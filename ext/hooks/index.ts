/**
 * Declarative hooks engine (Claude Code hooks.json protocol) — PLAN.md F2.2.
 *
 * Loads `<agentDir>/hooks.json` (global, always) and `<cwd>/.bluclawd/hooks.json`
 * (project, ONLY when the project is trusted — see Trap B below) and runs the mapped
 * shell hooks on agent lifecycle events. Each hooks.json key is a Claude Code event
 * name mapping to an array of `{ matcher, command }`:
 *
 *   PreToolUse → tool_call (BLOCKABLE)      Stop           → agent_end
 *   PostToolUse → tool_result (success)      SessionStart   → session_start
 *   PostToolUseFailure → tool_result (error) SessionEnd     → session_shutdown
 *   SubagentStart → tool_call (task)         PreCompact     → session_before_compact (BLOCKABLE)
 *   SubagentStop → tool_result (task)        PostCompact    → session_compact
 *   UserPromptSubmit → input (BLOCKABLE)     Notification   → permission prompts
 * Subagent* matchers are tested against the task's agent type(s), not the tool name.
 * Notification fires via permissions-bridge.ts when a permission prompt is shown
 * (payload carries `message`); PreToolUse `permissionDecision` allow/ask is honored
 * by the permissions extension through the same bridge (audit B.4) — see protocol.ts.
 *
 * Claude Code also documents Stop and SubagentStop as blockable; bluclawd's do not
 * block (IMPROVEMENT-PLAN.md §3.2, investigated 2026-08-14) because their underlying
 * pi-core events structurally can't veto anything by the time they fire — see the
 * comments at each pi.on("agent_end", ...) / the SubagentStop block in pi.on("tool_result",
 * ...) below. This is a documented divergence, not an oversight.
 *
 * Hooks receive the payload as JSON on stdin AND as BLUCLAWD_* env vars (see
 * runHooksFor). Blocking semantics live in protocol.ts (exit 2 or stdout
 * {"decision":"block"} / {"hookSpecificOutput":{"permissionDecision":"deny"}} ⇒
 * block; other failures / timeouts fail open).
 *
 * The stdin payload speaks BOTH dialects: the original bluclawd F2.2 fields
 * (`event`, `toolName`, `input` subset, `prompt`) for scripts written against
 * this extension, plus Claude Code's field names (`hook_event_name`, `tool_name`
 * capitalized, full `tool_input` with file_path/old_string/new_string aliases,
 * `tool_response` on PostToolUse, `cwd`, `session_id`) so CC hook scripts run
 * unmodified. Matchers are tested against the pi tool name AND its CC name.
 *
 * Feedback channels (Claude Code parity):
 * - PostToolUse exit-2 stderr (and deny reasons) are APPENDED to the tool result
 *   the model sees — no longer discarded.
 * - UserPromptSubmit exit-0 stdout / additionalContext is appended to the prompt
 *   (transform), Claude Code's context-injection behavior.
 * - PreToolUse additionalContext is held until that tool's result and appended
 *   to it (both success and failure). ToolCallEventResult can only block, so
 *   there is no pre-execution injection point; the model sees the context and
 *   the result together, which is the same practical outcome.
 *
 * Universal fields (IMPROVEMENT-PLAN.md §3.2b): `continue: false` (+ `stopReason`) is
 * folded into the same `blocked`/`reason` outcome exit-2 and `decision:"block"` already
 * produce (see protocol.ts) — it does not add a cancel channel to any event that lacked
 * one. It cancels on the three events whose result this file reads a `blocked` field
 * from directly: PreToolUse, UserPromptSubmit, PreCompact. On PostToolUse it takes the
 * SAME path any other block signal already takes there — `runHooksFor`'s own
 * `options.blockable: false` branch reroutes it into `aggregate.feedback`, so it
 * surfaces as model-visible "PostToolUse hook feedback" text rather than canceling
 * anything. On every event whose aggregate outcome nothing reads at all
 * (PostToolUseFailure, SubagentStart/Stop, Notification, Stop, SessionStart/End,
 * PostCompact) it has no observable effect — the same structural gap already documented
 * above for Stop and SubagentStop, not a new one. `systemMessage` has no such
 * restriction: it is shown via `ctx.ui.notify` for every hook on every event, in
 * `runHooksFor`, independent of whether that event's aggregate outcome is otherwise
 * read. `suppressOutput` is not implemented — Claude Code's own docs say it "has no
 * effect" today.
 *
 * SECURITY (Trap B): the project hooks.json runs ARBITRARY SHELL on tool calls. A
 * malicious cloned repo could ship a PreToolUse command that exfiltrates or destroys.
 * So the project file is loaded ONLY when `ctx.isProjectTrusted()`. The global file
 * always loads. This mirrors F2.1's permissions trust-gating.
 *
 * Idempotent factory (Trap C): the body only registers managed `pi.on(...)` handlers
 * — no file I/O at load time (the factory may run twice per trust-resolving load).
 * Config is loaded/parsed inside session_start (resolving getAgentDir() and ctx.cwd
 * there), cached in a closure, and reloaded on every session_start (covers resume and
 * /reload, both of which re-fire session_start). No raw event-bus use.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, getDebugLogPath } from "../../../packages/coding-agent/src/config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	InputEventResult,
	SessionBeforeCompactResult,
	ToolCallEventResult,
	ToolResultEventResult,
} from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { execWithIo } from "../_shared/exec.ts";
import { setHookPermissionBridge } from "./permissions-bridge.ts";
import { type HookExec, matches, runHook } from "./protocol.ts";

const HOOKS_FILE = "hooks.json";

/** Claude Code event key → pi event. Keys of this map are the recognized hooks.json keys. */
const HOOK_EVENTS = {
	PreToolUse: "tool_call",
	PostToolUse: "tool_result", // success results only (CC semantics)
	PostToolUseFailure: "tool_result", // isError results
	SubagentStart: "tool_call", // task tool calls; matcher tests the agent type
	SubagentStop: "tool_result", // task tool results; matcher tests the agent type
	UserPromptSubmit: "input",
	Notification: "permission_prompt", // fired via permissions-bridge, not a pi event
	Stop: "agent_end",
	SessionStart: "session_start",
	SessionEnd: "session_shutdown",
	PreCompact: "session_before_compact",
	PostCompact: "session_compact",
} as const;
type CCEventKey = keyof typeof HOOK_EVENTS;
const CC_EVENT_KEYS = Object.keys(HOOK_EVENTS) as CCEventKey[];

/** Env vars exposed to hook commands. */
const ENV_EVENT = "BLUCLAWD_HOOK_EVENT";
const ENV_TOOL_NAME = "BLUCLAWD_TOOL_NAME";
const ENV_TOOL_PATH = "BLUCLAWD_TOOL_PATH";
const ENV_TOOL_COMMAND = "BLUCLAWD_TOOL_COMMAND";
const ENV_PROMPT = "BLUCLAWD_PROMPT";

export interface HookEntry {
	/** Regex tested against the tool name (tool events only); omitted ⇒ always runs. */
	matcher?: string;
	/** Shell command run via `bash -c`. */
	command: string;
}
export type HooksConfig = Partial<Record<CCEventKey, HookEntry[]>>;

/**
 * Render the configured hooks for `/hooks`, grouped by event.
 *
 * Hooks run arbitrary shell as you, on every matching tool call, and until now
 * the only way to see what was wired up was to open hooks.json yourself — in two
 * places, since global and project configs merge. Commands are shown in FULL:
 * truncating one would hide the part worth reading.
 *
 * Iterates CC_EVENT_KEYS rather than the config's own keys so the order is
 * stable no matter how the JSON was written.
 */
export function formatHooksList(config: HooksConfig): string[] {
	const lines: string[] = [];
	for (const event of CC_EVENT_KEYS) {
		const entries = config[event];
		if (!entries || entries.length === 0) continue;
		lines.push(event);
		for (const entry of entries) {
			lines.push(`  ${entry.matcher ? entry.matcher : "(any tool)"} → ${entry.command}`);
		}
	}
	return lines;
}

/** Append a best-effort diagnostic line to the debug log. Never throws. */
function debugLog(message: string): void {
	try {
		appendFileSync(getDebugLogPath(), `[hooks] ${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never affect hook behavior.
	}
}

/**
 * Parse a hooks.json file into a validated config. A missing file ⇒ empty; invalid
 * JSON ⇒ logged and treated as empty (never throws); unknown keys and malformed
 * entries are ignored.
 */
function parseHooksFile(path: string): HooksConfig {
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		debugLog(`ignoring malformed ${path}: ${String(err)}`);
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};

	const config: HooksConfig = {};
	for (const key of CC_EVENT_KEYS) {
		const entries = (parsed as Record<string, unknown>)[key];
		if (!Array.isArray(entries)) continue;
		const valid: HookEntry[] = [];
		for (const entry of entries) {
			if (entry && typeof entry === "object" && typeof (entry as HookEntry).command === "string") {
				const e = entry as HookEntry;
				valid.push({
					matcher: typeof e.matcher === "string" ? e.matcher : undefined,
					command: e.command,
				});
			}
		}
		if (valid.length > 0) config[key] = valid;
	}
	return config;
}

/** Concatenate two configs per event key (global entries first, then project). */
function mergeHooks(global: HooksConfig, project: HooksConfig): HooksConfig {
	const merged: HooksConfig = {};
	for (const key of CC_EVENT_KEYS) {
		const combined = [...(global[key] ?? []), ...(project[key] ?? [])];
		if (combined.length > 0) merged[key] = combined;
	}
	return merged;
}

/**
 * Load the effective hooks config: global always, project ONLY when trusted (Trap B).
 */
function loadHooks(ctx: ExtensionContext): HooksConfig {
	const global = parseHooksFile(join(getAgentDir(), HOOKS_FILE));
	const project = ctx.isProjectTrusted() ? parseHooksFile(join(ctx.cwd, ".bluclawd", HOOKS_FILE)) : {};
	return mergeHooks(global, project);
}

/** Per-event payload fields (only the ones relevant to a given event are set). */
interface HookData {
	toolName?: string;
	path?: string;
	command?: string;
	prompt?: string;
	/** Full tool input (tool events) — sent as Claude Code's `tool_input`. */
	input?: Record<string, unknown>;
	/** Tool result (PostToolUse) — sent as Claude Code's `tool_response`. */
	response?: { content: string; isError: boolean };
	/** Override the names the matcher is tested against (Subagent events: agent types). */
	matchNames?: string[];
	/** Agent types involved (Subagent events) — sent as `agent_type`. */
	agentTypes?: string[];
	/** Notification text (Notification event) — sent as `message`. */
	message?: string;
}

/** Agent names referenced by a task tool input (single / parallel / chain forms). */
function taskAgentNames(input: Record<string, unknown>): string[] {
	const names: string[] = [];
	if (typeof input.agent === "string") names.push(input.agent);
	for (const key of ["tasks", "chain"] as const) {
		const entries = input[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (entry && typeof entry === "object" && typeof (entry as { agent?: unknown }).agent === "string") {
				names.push((entry as { agent: string }).agent);
			}
		}
	}
	return [...new Set(names)];
}

/**
 * Extract the tool fields a hook cares about (`path` for read/edit/write, `command`
 * for bash), leaving each undefined when the tool's input lacks it — so only the
 * relevant BLUCLAWD_TOOL_* env var and stdin `input` field is set per tool.
 */
function toolFields(input: Record<string, unknown>): Pick<HookData, "path" | "command"> {
	return {
		path: input.path !== undefined ? String(input.path) : undefined,
		command: input.command !== undefined ? String(input.command) : undefined,
	};
}

/**
 * pi tool name → Claude Code tool name, for `tool_name` and matcher interop.
 * Mirrors permissions' VERB table for the shared tools (keep the two in sync);
 * task maps to its CC role equivalent. Unknown tools (incl. mcp__*) pass
 * through unchanged — CC uses the same mcp__<server>__<tool> shape.
 */
const CC_TOOL_NAME: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Find",
	ls: "Ls",
	webfetch: "WebFetch",
	websearch: "WebSearch",
	task: "Task",
};
function ccToolName(toolName: string): string {
	return CC_TOOL_NAME[toolName] ?? toolName;
}

/**
 * Full tool input plus Claude Code param aliases, so a CC hook script reading
 * `.tool_input.file_path` / `.old_string` / `.new_string` works against pi's
 * `path` / `oldText` / `newText`. Native keys are kept; aliases never overwrite
 * an existing key. (The batch `edits[]` form has no CC analog — passed through.)
 */
export function toCcToolInput(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...input };
	if (input.path !== undefined && out.file_path === undefined) out.file_path = input.path;
	if (input.oldText !== undefined && out.old_string === undefined) out.old_string = input.oldText;
	if (input.newText !== undefined && out.new_string === undefined) out.new_string = input.newText;
	return out;
}

/** Join a tool result's text blocks for the `tool_response` payload. */
function textOfContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/** Aggregated outcome of every hook that ran for one event. */
interface AggregateHookOutcome {
	/** True when a blockable event was blocked (short-circuits remaining hooks). */
	blocked: boolean;
	/** First blocking reason (blockable events). */
	reason?: string;
	/** Block reasons from NON-blockable events (PostToolUse feedback channel). */
	feedback: string[];
	/** additionalContext strings from every hook that ran. */
	additionalContexts: string[];
	/** Plain exit-0 stdouts from every hook that ran. */
	stdouts: string[];
	/** Aggregated permissionDecision (audit B.4): "ask" wins over "allow". */
	permissionDecision?: "allow" | "ask";
}

/**
 * Run every hook registered for `ccKey`, building the env + stdin JSON payload once.
 * - `applyMatcher`: filter tool hooks by their `matcher` against the pi tool name
 *   OR its Claude Code name (so `"matcher": "Task"` fires on pi's `task`).
 * - `blockable`: stop at the first hook that blocks. When false, all hooks run and
 *   block decisions are collected into `feedback` instead (PostToolUse channel).
 * additionalContext / plain stdout are accumulated from every hook that ran.
 */
async function runHooksFor(
	ccKey: CCEventKey,
	config: HooksConfig,
	data: HookData,
	ctx: ExtensionContext,
	exec: HookExec,
	options: { applyMatcher: boolean; blockable: boolean },
): Promise<AggregateHookOutcome> {
	const aggregate: AggregateHookOutcome = {
		blocked: false,
		feedback: [],
		additionalContexts: [],
		stdouts: [],
	};
	const entries = config[ccKey] ?? [];
	if (entries.length === 0) return aggregate;

	const env: Record<string, string> = { [ENV_EVENT]: ccKey };
	if (data.toolName !== undefined) env[ENV_TOOL_NAME] = data.toolName;
	if (data.path !== undefined) env[ENV_TOOL_PATH] = data.path;
	if (data.command !== undefined) env[ENV_TOOL_COMMAND] = data.command;
	if (data.prompt !== undefined) env[ENV_PROMPT] = data.prompt;

	// Both dialects on stdin: bluclawd F2.2 fields + Claude Code field names (see
	// file header). Session/cwd context lets CC scripts that read `.cwd` /
	// `.session_id` / `.hook_event_name` run unmodified.
	const payload: Record<string, unknown> = {
		event: ccKey,
		hook_event_name: ccKey,
		cwd: ctx.cwd,
		session_id: ctx.sessionManager.getSessionId(),
	};
	if (data.toolName !== undefined) {
		payload.toolName = data.toolName;
		payload.input = {
			...(data.path !== undefined ? { path: data.path } : {}),
			...(data.command !== undefined ? { command: data.command } : {}),
		};
		payload.tool_name = ccToolName(data.toolName);
		payload.tool_input = toCcToolInput(data.input ?? {});
	}
	if (data.response !== undefined) payload.tool_response = data.response;
	if (data.prompt !== undefined) payload.prompt = data.prompt;
	if (data.agentTypes !== undefined && data.agentTypes.length > 0) {
		payload.agent_type = data.agentTypes.join(",");
	}
	if (data.message !== undefined) payload.message = data.message;
	const stdinJson = JSON.stringify(payload);

	for (const entry of entries) {
		if (options.applyMatcher) {
			const names =
				data.matchNames ?? (data.toolName !== undefined ? [data.toolName, ccToolName(data.toolName)] : []);
			if (names.length > 0) {
				const hit = [...new Set(names)].some((name) => matches(entry.matcher, name, debugLog));
				if (!hit) continue;
			}
		}
		const outcome = await runHook(entry.command, env, stdinJson, exec, {
			log: debugLog,
		});
		// systemMessage is shown "regardless of continue" (Claude Code parity) — surfaced
		// here, before the blocked branch below, so it still shows even when this same
		// hook is the one that blocks (IMPROVEMENT-PLAN.md §3.2b).
		if (outcome.systemMessage !== undefined) ctx.ui.notify(outcome.systemMessage, "info");
		if (outcome.additionalContext !== undefined) aggregate.additionalContexts.push(outcome.additionalContext);
		if (outcome.stdout !== undefined) aggregate.stdouts.push(outcome.stdout);
		if (outcome.permissionDecision === "ask") {
			aggregate.permissionDecision = "ask"; // most restrictive non-deny decision wins
		} else if (outcome.permissionDecision === "allow" && aggregate.permissionDecision === undefined) {
			aggregate.permissionDecision = "allow";
		}
		if (outcome.blocked) {
			if (options.blockable) {
				aggregate.blocked = true;
				aggregate.reason = outcome.reason;
				return aggregate;
			}
			// Non-blockable event: the block channel becomes model-visible feedback.
			aggregate.feedback.push(outcome.reason ?? `A ${ccKey} hook reported a problem (no message).`);
		}
	}
	return aggregate;
}

export function factory(pi: ExtensionAPI): void {
	// Effective config for the session, (re)loaded on every session_start. Empty
	// until the first session_start.
	let config: HooksConfig = {};

	// PreToolUse outcomes already produced for the permissions extension via the
	// bridge, keyed by toolCallId — consumed (and deleted) by the tool_call pass
	// below so each hook command runs exactly once per call (audit B.4).
	const bridgedPreToolUse = new Map<string, AggregateHookOutcome>();

	// PreToolUse additionalContext, held from the tool_call until its matching
	// tool_result so it can ride that result to the model (audit B.4). There is
	// no pre-execution injection channel — ToolCallEventResult only blocks — and
	// the model reasons about the context and the result together anyway.
	const pendingPreToolUseContext = new Map<string, string[]>();

	function runPreToolUse(
		event: { toolName: string; input: Record<string, unknown> },
		ctx: ExtensionContext,
	): Promise<AggregateHookOutcome> {
		return runHooksFor(
			"PreToolUse",
			config,
			{
				toolName: event.toolName,
				...toolFields(event.input),
				input: event.input,
			},
			ctx,
			execWithIo,
			{ applyMatcher: true, blockable: true },
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		config = loadHooks(ctx);
		bridgedPreToolUse.clear();
		pendingPreToolUseContext.clear();
		setHookPermissionBridge({
			decider: async (request, bridgeCtx) => {
				const outcome = await runPreToolUse(request, bridgeCtx);
				bridgedPreToolUse.set(request.toolCallId, outcome);
				if (outcome.blocked) return { decision: "deny", reason: outcome.reason };
				if (outcome.permissionDecision) return { decision: outcome.permissionDecision };
				return undefined;
			},
			notifier: (message, bridgeCtx) => {
				void runHooksFor("Notification", config, { message }, bridgeCtx, execWithIo, {
					applyMatcher: false,
					blockable: false,
				});
			},
		});
		// SessionStart hooks run after the config is loaded (non-blocking).
		await runHooksFor("SessionStart", config, {}, ctx, execWithIo, {
			applyMatcher: false,
			blockable: false,
		});
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const bridged = bridgedPreToolUse.get(event.toolCallId);
		bridgedPreToolUse.delete(event.toolCallId);
		const outcome = bridged ?? (await runPreToolUse(event, ctx));
		if (outcome.blocked) {
			return {
				block: true,
				reason: outcome.reason ?? "Blocked by a PreToolUse hook.",
			};
		}
		if (outcome.additionalContexts.length > 0) {
			pendingPreToolUseContext.set(event.toolCallId, outcome.additionalContexts);
		}
		// SubagentStart (CC parity): fires for task tool calls; the matcher is
		// tested against the agent type(s), not the tool name. Not blockable —
		// PreToolUse above is the blocking channel for task calls.
		if (event.toolName === "task") {
			const agents = taskAgentNames(event.input);
			await runHooksFor(
				"SubagentStart",
				config,
				{
					toolName: event.toolName,
					input: event.input,
					matchNames: agents,
					agentTypes: agents,
				},
				ctx,
				execWithIo,
				{ applyMatcher: true, blockable: false },
			);
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		const data: HookData = {
			toolName: event.toolName,
			...toolFields(event.input),
			input: event.input,
			response: {
				content: textOfContent(event.content),
				isError: event.isError,
			},
		};

		// CC semantics: PostToolUse fires on SUCCESS results only; failures fire
		// PostToolUseFailure (non-blockable, no feedback channel).
		const ccKey: CCEventKey = event.isError ? "PostToolUseFailure" : "PostToolUse";
		const outcome = await runHooksFor(ccKey, config, data, ctx, execWithIo, {
			applyMatcher: true,
			blockable: false,
		});

		// SubagentStop (CC parity): fires for task tool results; matcher = agent type(s).
		// NOT blockable — another structural divergence, not an oversight
		// (IMPROVEMENT-PLAN.md §3.2): CC documents SubagentStop as able to block,
		// but this fires on the `tool_result` event, which reports a task call
		// that has ALREADY completed — ToolResultEventResult can replace the
		// content, not veto that the call happened. There is no pi-core mechanism
		// to retroactively cancel a finished subagent run from this hook.
		if (event.toolName === "task") {
			const agents = taskAgentNames(event.input);
			await runHooksFor(
				"SubagentStop",
				config,
				{ ...data, matchNames: agents, agentTypes: agents },
				ctx,
				execWithIo,
				{
					applyMatcher: true,
					blockable: false,
				},
			);
		}

		// PreToolUse additionalContext rides its tool's result (either outcome —
		// a failed tool needs the context just as much).
		const preContext = pendingPreToolUseContext.get(event.toolCallId) ?? [];
		pendingPreToolUseContext.delete(event.toolCallId);

		// Feedback channel: exit-2 stderr / deny reasons / additionalContext are
		// appended to the tool result the model sees. PostToolUse contributes only
		// on success (CC semantics); PreToolUse context is appended either way.
		const notes = [
			...preContext.map((context) => `PreToolUse hook context:\n${context}`),
			...(ccKey === "PostToolUse"
				? [
						...outcome.feedback.map((reason) => `PostToolUse hook feedback:\n${reason}`),
						...outcome.additionalContexts,
					]
				: []),
		];
		if (notes.length === 0) return undefined;
		const note: TextContent = { type: "text", text: notes.join("\n\n") };
		return { content: [...event.content, note] };
	});

	pi.on("input", async (event, ctx): Promise<InputEventResult> => {
		const outcome = await runHooksFor("UserPromptSubmit", config, { prompt: event.text }, ctx, execWithIo, {
			applyMatcher: false,
			blockable: true,
		});
		if (outcome.blocked) {
			// Always tell the user why their prompt was dropped — a hook that exits 2
			// with no stderr must not swallow the prompt silently.
			ctx.ui.notify(outcome.reason ?? "Prompt blocked by a UserPromptSubmit hook.", "warning");
			return { action: "handled" }; // swallow the prompt
		}
		// Claude Code parity: a UserPromptSubmit hook's exit-0 stdout and any
		// additionalContext are appended to the prompt as extra context.
		const injected = [...outcome.additionalContexts, ...outcome.stdouts];
		if (injected.length > 0) {
			return {
				action: "transform",
				text: `${event.text}\n\n${injected.join("\n")}`,
				images: event.images,
			};
		}
		return { action: "continue" };
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Bridged outcomes whose tool_call pass never ran (permissions blocked the
		// call outright) would otherwise accumulate; the run is over, drop them.
		bridgedPreToolUse.clear();
		pendingPreToolUseContext.clear();
		// NOT blockable, and this is a structural divergence from Claude Code, not
		// an oversight (IMPROVEMENT-PLAN.md §3.2): CC documents Stop as able to
		// block, but pi's own `agent_end` event has no result type at all
		// (`ExtensionHandler<AgentEndEvent>`, core/extensions/types.ts) — there is
		// nothing for a handler to return that could stop the agent from having
		// already ended. Fixing this would mean adding cancellation to upstream
		// pi's agent_end event, out of scope for a fork-extension change.
		await runHooksFor("Stop", config, {}, ctx, execWithIo, {
			applyMatcher: false,
			blockable: false,
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await runHooksFor("SessionEnd", config, {}, ctx, execWithIo, {
			applyMatcher: false,
			blockable: false,
		});
	});

	pi.on("session_before_compact", async (_event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
		// Blockable (IMPROVEMENT-PLAN.md §3.2): Claude Code documents PreCompact as
		// able to block, and unlike Stop/SubagentStop below, pi's own
		// session_before_compact event already supports it via `{cancel: true}`
		// (core/extensions/types.ts SessionBeforeCompactResult) — this was simply
		// never wired up.
		const outcome = await runHooksFor("PreCompact", config, {}, ctx, execWithIo, {
			applyMatcher: false,
			blockable: true,
		});
		if (outcome.blocked) {
			ctx.ui.notify(outcome.reason ?? "Compaction blocked by a PreCompact hook.", "warning");
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("session_compact", async (_event, ctx) => {
		await runHooksFor("PostCompact", config, {}, ctx, execWithIo, {
			applyMatcher: false,
			blockable: false,
		});
	});

	pi.registerCommand("hooks", {
		description: "List the shell hooks wired to this session's events",
		handler: async (_args, ctx) => {
			const lines = formatHooksList(config);
			if (lines.length === 0) {
				// "None configured" and "configured but every entry was rejected" look
				// identical from the parsed config, because malformed JSON and
				// non-string commands are dropped to the debug log. Paste a real Claude
				// Code hooks file (nested `hooks` key) and you would be told there was
				// nothing there — so check the disk before claiming that.
				const present = [join(getAgentDir(), HOOKS_FILE), join(ctx.cwd, CONFIG_DIR_NAME, HOOKS_FILE)].filter(
					(path) => existsSync(path),
				);
				ctx.ui.notify(
					present.length === 0
						? `No hooks configured. Add a ${HOOKS_FILE} (global agent dir or project .bluclawd/).`
						: [
								`No hooks loaded, but a ${HOOKS_FILE} exists: ${present.join(", ")}.`,
								"Every entry was rejected — malformed JSON, an unknown event key, or a non-string command.",
								"Run with --debug to see why each entry was dropped.",
							].join("\n"),
					"info",
				);
				return;
			}
			// Say where they came from: project hooks load only for a trusted project,
			// so "nothing here" can mean "not trusted" rather than "none configured".
			const origin = ctx.isProjectTrusted()
				? `Loaded from the global agent dir and this project's .bluclawd/${HOOKS_FILE}.`
				: `Loaded from the global agent dir only — this project is untrusted, so its ${HOOKS_FILE} is ignored.`;
			ctx.ui.notify(
				[`Hooks — these run as you, via bash, on every matching event:`, "", ...lines, "", origin].join("\n"),
				"info",
			);
		},
	});
}

const hooksExtension: InlineExtension = { name: "hooks", factory };
export default hooksExtension;
