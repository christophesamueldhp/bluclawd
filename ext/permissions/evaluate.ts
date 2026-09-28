/**
 * The permission decision, as data: no prompts, no settings reads. The `tool_call`
 * handler supplies the inputs and performs whatever I/O a verdict calls for.
 *
 * Rules decide first, in every mode, with precedence deny > ask > allow:
 *
 *   deny   blocks
 *   ask    prompts
 *   allow  runs
 *
 * Only a call no rule names reaches the mode:
 *
 *   ask    reads and read-only bash run; everything else prompts
 *   edits  as ask, but edit/write run
 *   auto   everything runs
 *
 * In ask and edits, a write to protected config and a read of credentials also prompt.
 *
 * `isProtectedPath`/`isReadProtectedPath` and deny/ask path rules resolve symlinks, so
 * this module touches the filesystem there; everything else is a pure function of its
 * arguments.
 */

import { monitorSource } from "../_shared/monitor-source.ts";
import type { SandboxPosture } from "../sandbox/state.ts";
import { bashPathArgs, bashWriteTargets } from "./bash-targets.ts";
import type { PermissionMode } from "./modes.ts";
import {
	type Decision,
	decide,
	displayRule,
	exactRule,
	isProtectedPath,
	isReadProtectedPath,
	isReadProtectedPattern,
	type Rules,
	searchQueries,
	searchReachesProtectedFiles,
	subject,
} from "./rules.ts";
import { isSafeCommand } from "./safe-command.ts";

/** The gate that produced a verdict. Every verdict names exactly one. */
export type Gate =
	| "deny-rule"
	| "ask-rule"
	| "allow-rule"
	| "cli-allow"
	| "auto-mode"
	| "write-protected-path"
	| "read-protected-path"
	| "sandboxed"
	| "read-like"
	| "readonly-bash"
	| "accept-edits"
	| "no-matching-rule";

/** What the caller must do. `prompt` means "ask the user". */
export type Outcome = "allow" | "block" | "prompt";

export interface Verdict {
	outcome: Outcome;
	gate: Gate;
	/** Shown to the model on a block, or in the prompt on a prompt. Empty when allowing. */
	reason: string;
	/** Which prompt to show, when `outcome === "prompt"`. */
	promptKind?: "protected-read" | "protected-write" | "ask";
	/** The exact `Verb(subject)` rule for this call, when its tool is governed. */
	exact?: string | null;
	/** The path that tripped a protected-path gate, for the prompt text. */
	protectedPath?: string;
}

export interface EvalConfig {
	mode: PermissionMode;
	rules: Rules;
	/** `--allowedTools` grants. */
	cliAllowRules: Rules;
	cwd: string;
	agentDir: string;
	configDirName: string;
	hasUI: boolean;
	/** The OS sandbox's stance, when the sandbox extension is loaded. */
	sandbox?: SandboxPosture;
}

const READ_LIKE_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Tools that only read what this session already holds: stored fetch results, the
 * deferred MCP tool index, and MCP resource names.
 */
const LOCAL_READ_TOOLS = new Set(["get_search_content", "source_check", "mcp_find_tools", "mcp_list_resources"]);

/** Tools that only stop this session's own background work. */
const SELF_GATED_TOOLS = new Set(["task_stop"]);

/**
 * Will this bash command run inside the OS sandbox? Not when the sandbox is off, when
 * `excludedCommands` takes it out, or when a `dangerouslyDisableSandbox` retry is honoured.
 */
function sandboxedRun(tool: string, input: Record<string, unknown>, cfg: EvalConfig): boolean {
	const sb = cfg.sandbox;
	if (!sb?.active || tool !== "bash") return false;
	if (sb.isExcluded(String(input.command ?? ""))) return false;
	return !unsandboxedRetry(tool, input, cfg);
}

/** The model asked to leave the sandbox, and the settings let it. */
function unsandboxedRetry(tool: string, input: Record<string, unknown>, cfg: EvalConfig): boolean {
	return (
		tool === "bash" &&
		input.dangerouslyDisableSandbox === true &&
		cfg.sandbox?.active === true &&
		cfg.sandbox.allowUnsandboxedCommands
	);
}

/** The one parameter rule: ask before every unsandboxed retry. Rules do not otherwise match parameters. */
const RETRY_ASK_RULE = /^bash\(dangerouslyDisableSandbox:true\)$/i;

function asksAboutEveryRetry(rules: Rules): boolean {
	return (rules.ask ?? []).some((r) => RETRY_ASK_RULE.test(r));
}

/**
 * The rule decision. A `websearch` batch is decided per query: a deny on any query
 * blocks the whole call, and the first asking query becomes the prompt's subject.
 */
export function decideRules(
	tool: string,
	input: Record<string, unknown>,
	rules: Rules,
	cwd: string,
): { decision: Decision | null; denyAgent?: string; askAgent?: string } {
	const batch = tool === "websearch" && Array.isArray(input.queries);
	if (!batch) return { decision: decide(rules, tool, input, cwd) };

	let decision: Decision | null = null;
	let askAgent: string | undefined;
	for (const target of searchQueries(input)) {
		const d = decide(rules, tool, { query: target }, cwd);
		if (d === "deny") return { decision: "deny", denyAgent: target };
		if (d === "ask" && decision !== "ask") {
			decision = "ask";
			askAgent = target;
		} else if (d === "allow" && decision === null) {
			decision = "allow";
		}
	}
	return { decision, askAgent };
}

const ALLOW = (gate: Gate): Verdict => ({ outcome: "allow", gate, reason: "" });

const HEADLESS = "running headless (no interactive UI)";

/** The ask prompt, or a block when there is no UI to show it. */
function askOrBlock(gate: Gate, exact: string | null, cfg: EvalConfig, tool: string, label?: string): Verdict {
	if (!cfg.hasUI) {
		return { outcome: "block", gate, reason: `Permission approval required, but ${HEADLESS}. Blocked by default.` };
	}
	return {
		outcome: "prompt",
		gate,
		promptKind: "ask",
		reason: `Permission required — ${label ? `${label}: ` : ""}${exact ? displayRule(exact) : tool}`,
		exact,
	};
}

/**
 * The tool name every gate decides on. `monitor` runs a shell like bash, or opens a
 * WebSocket judged as a fetch; MCP resources are judged as their server's tools.
 */
function governedTool(tool: string, input: Record<string, unknown>): string {
	if (tool === "monitor") return monitorSource(input).kind === "ws" ? "webfetch" : "bash";
	if (tool === "mcp_read_resource" || tool === "mcp_list_resources") {
		const server = typeof input.server === "string" ? input.server : "";
		if (server) return `mcp__${server}__${tool.slice("mcp_".length)}`;
	}
	return tool;
}

/** The input every gate reads: a WebSocket monitor's is the fetch it amounts to. */
function governedInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
	const source = tool === "monitor" ? monitorSource(input) : undefined;
	return source?.kind === "ws" ? { url: source.url } : input;
}

/** The protected config path this call writes, if any. bash counts through its redirects and write commands. */
function protectedWriteTarget(tool: string, input: Record<string, unknown>, cfg: EvalConfig): string | undefined {
	if (tool !== "edit" && tool !== "write" && tool !== "bash") return undefined;
	const candidates =
		tool === "bash"
			? bashWriteTargets(String(input.command ?? ""))
			: [typeof input.path === "string" ? input.path : ""];
	return candidates.find(
		(candidate) => candidate && isProtectedPath(candidate, cfg.cwd, cfg.agentDir, cfg.configDirName),
	);
}

/**
 * The credential file this call reads, if any. Only files whose contents are secrets or
 * executable config: gating every read under `.git` would prompt constantly.
 */
function protectedReadTarget(tool: string, input: Record<string, unknown>, cfg: EvalConfig): string | undefined {
	const { cwd, agentDir, configDirName } = cfg;
	if (tool === "bash") {
		return bashPathArgs(String(input.command ?? "")).find((word) =>
			isReadProtectedPattern(word, cwd, agentDir, configDirName),
		);
	}
	if (!READ_LIKE_TOOLS.has(tool)) return undefined;
	const rawPath = typeof input.path === "string" ? input.path : "";
	if (rawPath && isReadProtectedPath(rawPath, cwd, agentDir, configDirName)) return rawPath;
	// find and ls list names; only grep reads what is under its root.
	if (tool === "grep" && searchReachesProtectedFiles(rawPath || cwd, cwd, agentDir, configDirName)) {
		return rawPath || cwd;
	}
	return undefined;
}

/** The protected-path prompt for a call no rule names, in ask or edits mode. */
function protectedPathVerdict(tool: string, input: Record<string, unknown>, cfg: EvalConfig): Verdict | undefined {
	const exact = exactRule(tool, subject(tool, input));
	const writeTarget = protectedWriteTarget(tool, input, cfg);
	if (writeTarget) {
		if (!cfg.hasUI) {
			return {
				outcome: "block",
				gate: "write-protected-path",
				reason: `Protected path: ${writeTarget}. Approval required, but ${HEADLESS}. Blocked.`,
				protectedPath: writeTarget,
			};
		}
		return {
			outcome: "prompt",
			gate: "write-protected-path",
			promptKind: "protected-write",
			reason: `Protected path — allow ${tool} to ${writeTarget}?`,
			protectedPath: writeTarget,
			exact,
		};
	}
	const readTarget = protectedReadTarget(tool, input, cfg);
	if (readTarget) {
		if (!cfg.hasUI) {
			return {
				outcome: "block",
				gate: "read-protected-path",
				reason: `Protected path: ${readTarget} holds agent credentials. Approval required, but ${HEADLESS}. Blocked.`,
				protectedPath: readTarget,
			};
		}
		return {
			outcome: "prompt",
			gate: "read-protected-path",
			promptKind: "protected-read",
			reason:
				tool === "bash"
					? `Protected path — bash command names ${readTarget}: ${String(input.command ?? "")}`
					: `Protected path — allow ${tool} of ${readTarget}?`,
			protectedPath: readTarget,
			exact,
		};
	}
	return undefined;
}

/** Deny rules. `undefined` when none matches and evaluation continues in {@link evaluatePostHook}. */
export function evaluatePreHook(
	rawTool: string,
	rawInput: Record<string, unknown>,
	cfg: EvalConfig,
): Verdict | undefined {
	const tool = governedTool(rawTool, rawInput);
	const input = governedInput(rawTool, rawInput);
	const { decision, denyAgent } = decideRules(tool, input, cfg.rules, cfg.cwd);
	if (decision !== "deny") return undefined;
	const subj = tool === "websearch" && denyAgent !== undefined ? denyAgent : subject(tool, input);
	return {
		outcome: "block",
		gate: "deny-rule",
		reason: `Blocked by permission rule (deny): ${displayRule(exactRule(tool, subj) ?? tool)}`,
	};
}

/** Ask and allow rules, then the mode for a call no rule names. */
export function evaluatePostHook(rawTool: string, rawInput: Record<string, unknown>, cfg: EvalConfig): Verdict {
	const tool = governedTool(rawTool, rawInput);
	const input = governedInput(rawTool, rawInput);
	const retry = unsandboxedRetry(tool, input, cfg);
	const label = retry ? "Bash command (unsandboxed)" : undefined;
	const { decision, askAgent } = decideRules(tool, input, cfg.rules, cfg.cwd);
	const subj = tool === "websearch" && askAgent !== undefined ? askAgent : subject(tool, input);
	const exact = exactRule(tool, subj);

	// Rules.
	if (decision === "ask" || (retry && asksAboutEveryRetry(cfg.rules))) {
		return askOrBlock("ask-rule", exact, cfg, tool, label);
	}
	if (decision === "allow") return ALLOW("allow-rule");
	if (decide(cfg.cliAllowRules, tool, input, cfg.cwd) === "allow") return ALLOW("cli-allow");

	// The mode.
	if (cfg.mode === "auto") return ALLOW("auto-mode");
	const protectedPath = protectedPathVerdict(tool, input, cfg);
	if (protectedPath) return protectedPath;
	if (sandboxedRun(tool, input, cfg) && cfg.sandbox?.autoAllowBashIfSandboxed === true) return ALLOW("sandboxed");
	if (READ_LIKE_TOOLS.has(tool) || LOCAL_READ_TOOLS.has(tool) || SELF_GATED_TOOLS.has(tool)) return ALLOW("read-like");
	// Leaving the sandbox is never read-only: the sandbox is what stopped the first attempt.
	if (tool === "bash" && !retry && isSafeCommand(String(input.command ?? ""))) return ALLOW("readonly-bash");
	if (cfg.mode === "edits" && (tool === "edit" || tool === "write")) return ALLOW("accept-edits");
	return askOrBlock("no-matching-rule", exact, cfg, tool, label);
}
