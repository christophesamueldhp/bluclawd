/**
 * Permissions core extension (PLAN.md F2.1).
 *
 * Governs every `tool_call` against a `Verb(glob)` rule set (rules.ts) with a
 * deny > ask > allow precedence, layered under a session permission mode
 * (modes.ts): ask / edits / auto.
 *
 * Registration order matters: this extension is registered FIRST in
 * coreExtensions() so it sees `tool_call` before any other extension.
 *
 * Trap 3 (security): project settings are read TRUST-AWARE — an untrusted repo's
 * `.bluclawd/settings.json` must not be able to inject allow rules that defeat the
 * safety layer. Global writeback ("Always allow") targets global settings only.
 *
 * Performance: rules are loaded once per session_start into a closure variable —
 * the awaited `tool_call` path does no blocking I/O. "Always allow" updates the
 * in-closure rules immediately (so it takes effect at once) in addition to the
 * async disk writeback.
 *
 * Idempotent factory: the body only registers handlers/commands/shortcuts. All
 * state lives in this closure.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Key, Spacer, Text } from "@earendil-works/pi-tui";
import * as forkSettings from "../_shared/settings.ts";
import {
	addGlobalRule,
	addProjectRule,
	onRulesChanged,
	removeGlobalRule,
	removeProjectRule,
} from "../_shared/settings-write.ts";
import { sandboxPosture } from "../sandbox/state.ts";
import { setActivePermissionMode } from "./active-mode.ts";
import { type EvalConfig, evaluatePostHook, evaluatePreHook, type Gate } from "./evaluate.ts";
import {
	createModeStore,
	DEFAULT_MODE,
	isModeAllowedUntrusted,
	MODE_DESCRIPTIONS,
	type ModeStore,
	nextInCycle,
	PERMISSION_MODES,
	type PermissionMode,
	parseMode,
	SAFEST_MODE,
} from "./modes.ts";
import {
	bashSegments,
	decide,
	exactRule,
	governedVerbs,
	parseRuleSpec,
	type Rules,
	stripWrappingQuotes,
	subject,
} from "./rules.ts";

/** One rule and where it was set. */
interface SourcedRule {
	rule: string;
	source: string;
}

/** One gated call, as `/permissions why` shows it. */
interface DecisionRecord {
	tool: string;
	subject: string;
	gate: Gate;
	allowed: boolean;
	/** The user's answer, when the call prompted. */
	answer?: string;
}

/** What `/permissions` renders: the rule lists, one `test` result, or the decision log. */
interface PermissionsData {
	mode: PermissionMode;
	lists?: Array<{ list: "deny" | "ask" | "allow"; rules: Array<string | SourcedRule> }>;
	test?: string[];
	log?: DecisionRecord[];
}

/** Why a gate lets a call through or stops it, in the words `/permissions why` uses. */
const GATE_TEXT: Record<Gate, string> = {
	"deny-rule": "a deny rule",
	"read-protected-path": "protected path (credentials)",
	"write-protected-path": "protected path (config)",
	"exact-allow": "an exact allow rule",
	"cli-allow": "--allowedTools",
	"readonly-bash": "read-only command",
	"allow-rule": "an allow rule",
	"ask-rule": "an ask rule",
	"read-like": "reads never prompt",
	"accept-edits": "edits mode",
	"auto-mode": "auto mode",
	sandboxed: "runs in the sandbox",
	"no-matching-rule": "no rule matched, so the mode asked",
};

/** A rule some gate reads: a governed verb and a non-empty subject. */
function isRule(spec: string): boolean {
	return /\(.+\)$/.test(spec) && parseRuleSpec(spec) !== undefined;
}

/** How many recent decisions `/permissions why` keeps. */
const DECISION_LOG_SIZE = 20;

/** Claude Code's `autoAccept` badge colour (2.1.259 dark): rgb(175,135,255). */
const CC_AUTO_ACCEPT = "\x1b[38;2;175;135;255m";

/**
 * Footer chip for a mode, in Claude Code's own badge colours (extracted from the
 * 2.1.259 binary's dark theme): edits=#af87ff, auto=amber, ask=gray. The wording follows this layer's own mode names, not CC's labels.
 *
 * Two things this gets right that the previous version did not:
 *
 * - `edits` (Claude Code's accept-edits) is PURPLE, not green. pi's theme has no token for it, so
 *   `success` was the stand-in — and green is the one colour that reads as the
 *   opposite of what the badge means. It is painted with a raw truecolor escape
 *   instead, which the ccstatusline footer next to it already does for its own
 *   widgets. A 256-colour terminal would not downconvert the escape, so that
 *   case keeps the theme token.
 * - `ask` carries `⏸`: it is the manual mode, and `⏸` is the badge the manual
 *   (non-auto-accept) modes share.
 */
function modeStatusText(ctx: ExtensionContext, mode: PermissionMode): string | undefined {
	const theme = ctx.ui.theme;
	switch (mode) {
		case "ask":
			return theme.fg("muted", "⏸ ask mode on");
		case "edits":
			return theme.getColorMode() === "truecolor"
				? `${CC_AUTO_ACCEPT}⏵⏵ edits mode on\x1b[0m`
				: theme.fg("success", "⏵⏵ edits mode on");
		case "auto":
			return theme.fg("warning", "⏵⏵ auto mode on");
		default:
			return undefined;
	}
}

export function factory(pi: ExtensionAPI): void {
	// CC headless-interop flags (audit B.6). Values are read in session_start.
	pi.registerFlag("permission-mode", {
		description: `Start sessions in a permission mode: ${PERMISSION_MODES.join("|")}`,
		type: "string",
	});
	pi.registerFlag("dangerously-skip-permissions", {
		description: "Start sessions in auto mode (alias for --permission-mode auto)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("allowedTools", {
		description: 'Comma-separated rules allowed without prompting, e.g. "Bash(git *),WebFetch"',
		type: "string",
	});
	pi.registerFlag("disallowedTools", {
		description: 'Comma-separated rules denied without prompting, e.g. "Bash(curl **),websearch"',
		type: "string",
	});

	// Rule set for the current session, loaded on session_start (trust-aware) and
	// updated in place by "Always allow". Empty until the first session_start.
	let rules: Rules = {};
	// --allowedTools grants, kept SEPARATE from `rules`: the engine's ask > allow
	// precedence would let any settings ask rule shadow a merged allow glob, but the
	// flag's intent is an explicit per-invocation grant — honored in the ask and
	// auto gates below (deny and protected paths still win).
	let cliAllowRules: Rules = {};
	// What the session layers over settings — the FleetView ask-all posture and
	// --disallowedTools. Kept apart so every reload of settings re-applies it:
	// `/permissions add` used to reload settings alone and silently drop both.
	// Its allow list holds the "Yes, for this session" grants.
	let sessionRules: Rules = {};
	// The latest gated calls, newest last, for `/permissions why`.
	let decisions: DecisionRecord[] = [];

	/** Settings rules with the session's own layered on top. */
	function reloadRules(ctx: ExtensionContext): void {
		const base = loadRules(ctx);
		rules = {
			...base,
			allow: [...(base.allow ?? []), ...(sessionRules.allow ?? [])],
			ask: [...(base.ask ?? []), ...(sessionRules.ask ?? [])],
			deny: [...(base.deny ?? []), ...(sessionRules.deny ?? [])],
		};
	}
	// A rule saved elsewhere (the sandbox's "don't ask again" for a host) applies at once.
	onRulesChanged(() => liveCtx && reloadRules(liveCtx));
	// Mode store: created in session_start (fresh "ask" state), disposed in
	// session_shutdown. Undefined before the first session_start → treat as "ask".
	let modeStore: ModeStore | undefined;
	// Latest live context, captured in handlers so the event-driven footer refresh
	// has a ctx. Optional-chained + try/guarded so a stale instance is a safe no-op.
	let liveCtx: ExtensionContext | undefined;

	const currentMode = (): PermissionMode => modeStore?.get() ?? "ask";

	/**
	 * Say why a mode was refused. Project trust is pi's own gate — it already withholds
	 * this repository's settings, extensions and skills — so a mode that auto-approves
	 * edits or skips prompts is exactly what it should also withhold. `/trust` is the
	 * way out, so the message names it rather than leaving the refusal unexplained.
	 */
	function reportUntrustedRefusal(ctx: ExtensionContext, mode: PermissionMode): void {
		ctx.ui.notify(
			`This project is not trusted, so it stays in ${SAFEST_MODE} mode — ${mode} was refused. Run /trust to change that.`,
			"warning",
		);
	}

	/**
	 * Every mode change, from any source. Publishes the mode for the subagent gate
	 * (which has no other way to see it) before touching the UI, so a child spawned
	 * during the same turn cannot observe a stale mode.
	 */
	function onModeChanged(): void {
		setActivePermissionMode(currentMode());
		refreshStatus();
	}

	function refreshStatus(): void {
		const ctx = liveCtx;
		if (!ctx) return;
		try {
			ctx.ui.setStatus("mode", modeStatusText(ctx, currentMode()));
		} catch {
			// Stale extension instance after reload/replacement — ignore.
		}
	}

	function applySettingsDefaultMode(ctx: ExtensionContext): void {
		// Product default: a trusted session starts in DEFAULT_MODE unless settings say
		// otherwise. An untrusted project just stays clamped at SAFEST_MODE (the store's
		// own construction-time value) — that's the ordinary clamp, not a refused
		// request, so it does not warn.
		modeStore?.set(DEFAULT_MODE);

		let configured: string | undefined;
		try {
			configured = forkSettings.globalPermissionDefaultMode(
				SettingsManager.create(ctx.cwd, undefined, {
					projectTrusted: ctx.isProjectTrusted(),
				}),
			);
		} catch {
			return;
		}
		if (!configured) return;
		if (!parseMode(configured)) {
			ctx.ui.notify(
				`Invalid permissions.defaultMode "${configured}" in settings. Valid: ${PERMISSION_MODES.join(", ")}`,
				"warning",
			);
			return;
		}
		const parsed = parseMode(configured);
		if (parsed && modeStore && !modeStore.set(parsed)) reportUntrustedRefusal(ctx, parsed);
	}

	function loadRules(ctx: ExtensionContext): Rules {
		try {
			const sm = SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			return forkSettings.permissions(sm) ?? {};
		} catch {
			return {};
		}
	}

	/**
	 * Parse a --allowedTools/--disallowedTools value: comma-separated Verb(glob)
	 * rules used as-is; a bare governed tool name (any case) means every subject,
	 * e.g. `WebFetch` → `WebFetch(**)`. Entries naming ungoverned tools are dropped —
	 * the engine could never match them.
	 */
	function parseToolRuleFlag(raw: string): string[] {
		const out: string[] = [];
		for (const entry of raw
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)) {
			if (isRule(entry)) {
				out.push(entry);
				continue;
			}
			const verb = governedVerbs().find((v) => v.toLowerCase() === entry.toLowerCase());
			if (verb) out.push(`${verb}(**)`);
		}
		return out;
	}

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		// Dispose any prior store first so resume/new/fork re-runs stay idempotent.
		modeStore?.dispose();
		// Trust is read through a live callback, not captured: pi resolves it during
		// startup and `/trust` can grant it mid-session, so a snapshot would strand the
		// session in the clamped mode for good.
		modeStore = createModeStore(onModeChanged, () => ctx.isProjectTrusted());
		// Starting mode: DEFAULT_MODE unless permissions.defaultMode overrides it.
		// GLOBAL settings only — a trusted project may contribute allow rules, but
		// letting it name the mode would let any repo ship `defaultMode: "auto"`
		// and switch the whole safety layer off. CLI flags below still override this.
		applySettingsDefaultMode(ctx);
		sessionRules = {};
		decisions = [];
		// PI_PERMISSION_MODE=ask (set by the FleetView orchestrator for spawned background
		// sessions) makes the agent ask before every governed tool, so it surfaces a blocking
		// prompt an attach viewer can answer. Rules-based so it never touches the mode union.
		// Derived from governedVerbs() so it always covers exactly what decide() can gate — a
		// hand-kept list would silently miss any verb added to governance later. Since audit
		// B.5 this includes Mcp and Task, so MCP tools and subagent delegation prompt too.
		if (process.env.PI_PERMISSION_MODE === "ask") {
			sessionRules.ask = governedVerbs().map((verb) => `${verb}(**)`);
		}
		// CC headless interop (audit B.6): --disallowedTools merges into the deny
		// list (deny > ask > allow, so it wins in every mode);
		// --allowedTools populates the separate cliAllowRules grant set.
		const denyFlag = pi.getFlag("disallowedTools");
		if (typeof denyFlag === "string" && denyFlag) sessionRules.deny = parseToolRuleFlag(denyFlag);
		reloadRules(ctx);
		const allowFlag = pi.getFlag("allowedTools");
		cliAllowRules = typeof allowFlag === "string" && allowFlag ? { allow: parseToolRuleFlag(allowFlag) } : {};
		// Initial mode from the CLI: --dangerously-skip-permissions (CC alias) wins
		// over --permission-mode. Sets the *initial* mode only — Alt+M and /mode
		// still switch freely afterwards.
		const modeFlag = pi.getFlag("dangerously-skip-permissions") === true ? "auto" : pi.getFlag("permission-mode");
		if (typeof modeFlag === "string" && modeFlag) {
			const parsedFlag = parseMode(modeFlag);
			if (parsedFlag) {
				if (!modeStore.set(parsedFlag)) reportUntrustedRefusal(ctx, parsedFlag);
			} else {
				ctx.ui.notify(`Invalid --permission-mode "${modeFlag}". Valid: ${PERMISSION_MODES.join(", ")}`, "warning");
			}
		}
		// Also publishes the STARTING mode, which no transition fired for.
		onModeChanged();
	});

	pi.on("session_shutdown", async () => {
		modeStore?.dispose();
		modeStore = undefined;
		setActivePermissionMode("ask");
	});

	/** CC's documented cap: "Up to 5 rules may be saved for a single compound command." */
	const MAX_COMPOUND_ALLOW_RULES = 5;

	/**
	 * Persist an "Always allow" choice: update the in-closure cache so it takes effect
	 * at once, then write it back (global by default, project on request) and flush, so
	 * the throwaway SettingsManager's queued write lands before it is discarded.
	 *
	 * A compound bash command (`git status && npm test`) persists one rule PER SEGMENT
	 * (capped at `MAX_COMPOUND_ALLOW_RULES`, matching CC) rather than one rule for the
	 * whole line — `decide()`'s union-allow semantics for multi-segment bash (§2.4) then
	 * clear both the identical compound again AND any of its segments run alone, instead
	 * of only the exact compound string verbatim. A single command or a non-bash verb is
	 * unaffected: `bashSegments` returns one segment, so `toPersist` is just `[exact]`.
	 */
	/**
	 * The rules that grant `exact`: one per segment for a compound, or the whole line
	 * once the compound is past the cap, where per-segment rules would miss some.
	 */
	function grantRules(exact: string): string[] {
		const parsed = parseRuleSpec(exact);
		const segments = parsed?.tool === "bash" ? bashSegments(String(parsed.input.command ?? "")) : undefined;
		if (!segments || segments.length < 2 || segments.length > MAX_COMPOUND_ALLOW_RULES) return [exact];
		return [...new Set(segments.map((segment) => exactRule("bash", segment)).filter((r) => r !== null))];
	}

	async function persistAlwaysAllow(exact: string, toProject: boolean, ctx: ExtensionContext): Promise<void> {
		const toPersist = grantRules(exact);

		rules = {
			...rules,
			allow: [...new Set([...(rules.allow ?? []), ...toPersist])],
		};
		for (const rule of toPersist) {
			if (toProject) await addProjectRule(ctx.cwd, "allow", rule, ctx.isProjectTrusted());
			else await addGlobalRule("allow", rule);
		}
	}

	/** Yes/No prompt. Any failure fails CLOSED — an unanswered prompt is a "No". */
	async function confirm(label: string, ctx: ExtensionContext): Promise<boolean | "failed"> {
		try {
			return (await ctx.ui.select(label, ["Yes", "No"])) === "Yes";
		} catch {
			return "failed";
		}
	}

	/**
	 * The full permission prompt: Yes / Yes, for this session / No / No, and tell the
	 * model why / Always allow / Always allow (project). The project option persists into
	 * `.bluclawd/settings.json` and is offered only when the project is trusted (untrusted
	 * project rules are never read anyway). A session grant lives in memory only.
	 */
	async function askWithScope(
		label: string,
		exact: string | null,
		ctx: ExtensionContext,
	): Promise<{ outcome: "allow" | "deny" | "failed"; answer?: string; note?: string }> {
		let choice: string | undefined;
		try {
			// No rule names this call (a tool outside the rule verbs), so there is nothing to grant.
			const session = exact ? ["Yes, for this session"] : [];
			const always = exact ? ["Always allow", ...(ctx.isProjectTrusted() ? ["Always allow (project)"] : [])] : [];
			const options = ["Yes", ...session, "No", "No, and tell the model why", ...always];
			choice = await ctx.ui.select(label, options);
			if (choice === "No, and tell the model why") {
				const note = (await ctx.ui.input("Tell the model why, or what to do instead"))?.trim();
				return { outcome: "deny", answer: choice, note: note || undefined };
			}
		} catch {
			return { outcome: "failed" };
		}
		if (choice === "Always allow" || choice === "Always allow (project)") {
			if (exact) await persistAlwaysAllow(exact, choice === "Always allow (project)", ctx);
			return { outcome: "allow", answer: choice };
		}
		if (choice === "Yes, for this session" && exact) {
			sessionRules.allow = [...new Set([...(sessionRules.allow ?? []), ...grantRules(exact)])];
			rules = { ...rules, allow: [...new Set([...(rules.allow ?? []), ...grantRules(exact)])] };
			return { outcome: "allow", answer: choice };
		}
		return { outcome: choice === "Yes" ? "allow" : "deny", answer: choice ?? "No" };
	}

	/** A denial's reason, carrying what the user told the model, if anything. */
	function denied(reason: string, note?: string): ToolCallEventResult {
		return { block: true, reason: note ? `${reason} The user says: ${note}` : reason };
	}

	/**
	 * The gate. Decision logic lives in evaluate.ts as a pure function of the inputs
	 * gathered here; this handler owns only the I/O a verdict calls for — prompting,
	 * persisting an "Always allow".
	 */
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		liveCtx = ctx;
		const tool = event.toolName;
		const input = event.input as Record<string, unknown>;
		const { result, gate, answer } = await judge(tool, input, ctx);
		decisions = [...decisions, { tool, subject: subject(tool, input), gate, allowed: !result?.block, answer }].slice(
			-DECISION_LOG_SIZE,
		);
		return result;
	});

	/** The verdict for one call, with the gate that decided it and the user's answer if asked. */
	async function judge(
		tool: string,
		input: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<{ result: ToolCallEventResult | undefined; gate: Gate; answer?: string }> {
		const cfg: EvalConfig = {
			mode: currentMode(),
			rules,
			cliAllowRules,
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			hasUI: ctx.hasUI,
			sandbox: sandboxPosture(),
		};

		const failed = { block: true, reason: "Permission prompt failed or was interrupted. Blocked by default." };

		// Gates 1-3: deny rules, protected paths.
		const pre = evaluatePreHook(tool, input, cfg);
		if (pre?.outcome === "block") return { result: { block: true, reason: pre.reason }, gate: pre.gate };
		let preAnswer: string | undefined;
		if (pre?.outcome === "prompt") {
			// A protected READ may be allowed for good: the exact rule clears this gate next
			// time, and the bash screen matches words, so a repeat (`git diff .mcp.json`)
			// would otherwise ask every time. Protected WRITES stay one approval at a time.
			const asked =
				pre.gate === "read-protected-path"
					? await askWithScope(pre.reason, pre.exact ?? null, ctx)
					: await confirm(pre.reason, ctx).then((r) => ({
							outcome: r === "failed" ? ("failed" as const) : r ? ("allow" as const) : ("deny" as const),
							answer: r === true ? "Yes" : "No",
							note: undefined,
						}));
			if (asked.outcome === "failed") return { result: failed, gate: pre.gate };
			if (asked.outcome === "deny") {
				const what = pre.gate === "read-protected-path" ? "Read of" : "Write to";
				return {
					result: denied(`${what} protected path denied: ${pre.protectedPath}.`, asked.note),
					gate: pre.gate,
					answer: asked.answer,
				};
			}
			// An approved WRITE to a protected path is granted once and we are done. An
			// approved READ falls through: the read gate is narrow (credentials only) and
			// the call still has to satisfy the ordinary ask/auto gates below.
			if (pre.gate === "write-protected-path") return { result: undefined, gate: pre.gate, answer: asked.answer };
			preAnswer = asked.answer;
		}

		// Gates 4-6: ask rules, allow rules, and what the mode does with the rest.
		const post = evaluatePostHook(tool, input, cfg);
		if (post.outcome === "allow") return { result: undefined, gate: post.gate, answer: preAnswer };
		if (post.outcome === "block") return { result: { block: true, reason: post.reason }, gate: post.gate };

		const asked = await askWithScope(post.reason, post.exact ?? null, ctx);
		if (asked.outcome === "failed") return { result: failed, gate: post.gate };
		if (asked.outcome === "deny") {
			return { result: denied("Permission denied by user.", asked.note), gate: post.gate, answer: asked.answer };
		}
		return { result: undefined, gate: post.gate, answer: asked.answer };
	}

	async function cycleAndReport(ctx: ExtensionContext): Promise<void> {
		liveCtx = ctx;
		if (!modeStore) return; // no store before session_start (shouldn't happen in practice)
		const before = modeStore.get();
		const next = modeStore.cycle();
		refreshStatus();
		// An untrusted project pins the mode, so the cycle is a no-op. Saying "Permission
		// mode: ask" again would read as a stuck key rather than a refusal.
		if (next === before && !ctx.isProjectTrusted()) {
			// Name the mode the cycle AIMED at, not the one still in effect — "ask was
			// refused" while sitting in ask reads as nonsense.
			reportUntrustedRefusal(ctx, nextInCycle(before));
			return;
		}
		ctx.ui.notify(`Permission mode: ${next}`, "info");
	}

	/** Apply a named mode, reporting either the change or why trust refused it. */
	function applyNamedMode(ctx: ExtensionContext, mode: PermissionMode): void {
		liveCtx = ctx;
		if (!modeStore) return;
		if (!modeStore.set(mode)) {
			reportUntrustedRefusal(ctx, mode);
			return;
		}
		refreshStatus();
		ctx.ui.notify(`Permission mode: ${mode}`, "info");
	}

	pi.registerCommand("mode", {
		description: `Choose a permission mode (${PERMISSION_MODES.join(" / ")}); Alt+M cycles them`,
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested) {
				const mode = parseMode(requested);
				if (!mode) {
					ctx.ui.notify(`Unknown mode "${requested}". Valid: ${PERMISSION_MODES.join(", ")}`, "warning");
					return;
				}
				applyNamedMode(ctx, mode);
				return;
			}
			// A bare `/mode` opens a picker, the way pi's own `/model`, `/theme` and
			// `/thinking` do — cycling blind never showed what the other options were, or
			// what they mean. Alt+M is still the fast path.
			if (!ctx.hasUI) {
				await cycleAndReport(ctx);
				return;
			}
			const trusted = ctx.isProjectTrusted();
			const current = currentMode();
			const labels = PERMISSION_MODES.map((mode) => {
				const suffix =
					mode === current ? "  (current)" : !trusted && !isModeAllowedUntrusted(mode) ? "  (needs /trust)" : "";
				return `${mode} — ${MODE_DESCRIPTIONS[mode]}${suffix}`;
			});
			const choice = await ctx.ui.select("Permission mode", labels);
			if (!choice) return;
			const picked = PERMISSION_MODES[labels.indexOf(choice)];
			if (picked) applyNamedMode(ctx, picked);
		},
	});

	// Claude Code cycles permission modes on Shift+Tab, and the fork branch got that
	// by rebinding pi's own `app.thinking.cycle` default away from it. An extension
	// cannot rebind a built-in — pi refuses the registration and logs a conflict — so
	// this layer takes Alt+M instead and leaves Shift+Tab to pi. `/mode` is unaffected.
	pi.registerShortcut(Key.alt("m"), {
		description: "Cycle permission mode",
		handler: async (ctx) => cycleAndReport(ctx),
	});

	/**
	 * One rule list with where each rule was set. Settings files first, then what this
	 * session layers on top — flags, the FleetView posture, "Yes, for this session" —
	 * which no settings file shows.
	 */
	function sourcedRules(sm: SettingsManager, list: "deny" | "ask" | "allow"): SourcedRule[] {
		const listOf = (settings: unknown): string[] => (settings as { permissions?: Rules }).permissions?.[list] ?? [];
		const sessionSource = {
			deny: "--disallowedTools",
			ask: "PI_PERMISSION_MODE=ask",
			allow: "this session",
		}[list];
		const out: SourcedRule[] = [];
		const add = (rule: string, source: string): void => {
			const seen = out.find((entry) => entry.rule === rule);
			if (seen) seen.source += `, ${source}`;
			else out.push({ rule, source });
		};
		for (const rule of listOf(sm.getGlobalSettings())) add(rule, "global");
		for (const rule of listOf(sm.getProjectSettings())) add(rule, "project");
		for (const rule of sessionRules[list] ?? []) add(rule, sessionSource);
		if (list === "allow") for (const rule of cliAllowRules.allow ?? []) add(rule, "--allowedTools");
		return out;
	}

	/**
	 * Does ONE rule match this call, as its list kind? Runs the real engine on a
	 * single-rule rule set, so `/permissions test` can never diverge from enforcement.
	 */
	function ruleMatches(
		rule: string,
		kind: "allow" | "ask" | "deny",
		tool: string,
		input: Record<string, unknown>,
		cwd: string,
	): boolean {
		return decide({ [kind]: [rule] }, tool, input, cwd) === kind;
	}
	pi.registerEntryRenderer<PermissionsData>("bluclawd:permissions", (entry, _options, theme) => {
		const data = entry.data;
		const container = new Container();
		container.addChild(new Spacer(1));
		if (!data) return container;
		const lines: string[] = [`${theme.bold("Permissions")}  ${theme.fg("dim", `mode: ${data.mode}`)}`];
		if (data.log) {
			lines.push("");
			if (data.log.length === 0) lines.push(theme.fg("muted", "  No tool calls yet this session."));
			for (const d of data.log) {
				const mark = d.allowed ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const what = d.subject ? `${d.tool}  ${d.subject.split("\n")[0].slice(0, 80)}` : d.tool;
				const answer = d.answer ? `, you answered "${d.answer}"` : "";
				lines.push(`  ${mark} ${what}  ${theme.fg("dim", `— ${GATE_TEXT[d.gate]}${answer}`)}`);
			}
		} else if (data.test) {
			for (const line of data.test) lines.push(`  ${line}`);
			lines.push("");
			lines.push(
				theme.fg(
					"dim",
					"This is the RULE decision only. The final outcome can still differ: protected paths, the read-only allowlist, the sandbox pairing and the mode all apply on top.",
				),
			);
		} else {
			// deny/ask/allow keep their precedence order and take the colour that says
			// which way each list pushes — the flat string could only indent them.
			const colour = { deny: "error", ask: "warning", allow: "success" } as const;
			for (const { list, rules } of data.lists ?? []) {
				lines.push("");
				lines.push(`${theme.fg(colour[list], list)} ${theme.fg("dim", `(${rules.length})`)}`);
				for (const entry of rules) {
					lines.push(
						typeof entry === "string" ? `  ${entry}` : `  ${entry.rule}  ${theme.fg("dim", `(${entry.source})`)}`,
					);
				}
				if (rules.length === 0) lines.push(theme.fg("muted", "  none"));
			}
			lines.push("");
			lines.push(
				theme.fg(
					"dim",
					"/permissions why · /permissions test <Rule(spec)> · /permissions add <allow|ask|deny> <Rule(spec)> [--project] · /permissions remove <Rule(spec)>",
				),
			);
		}
		container.addChild(new Text(lines.join("\n"), 1, 0));
		return container;
	});

	pi.registerCommand("permissions", {
		description:
			"View, test or edit permission rules, or see why recent calls ran: /permissions [why | test <Rule(spec)> | add <allow|ask|deny> <Rule(spec)> [--project] | remove <Rule(spec)>]",
		handler: async (args, ctx) => {
			liveCtx = ctx;
			const trimmed = args.trim();
			const sm = SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			});

			if (!trimmed) {
				pi.appendEntry<PermissionsData>("bluclawd:permissions", {
					mode: currentMode(),
					lists: (["deny", "ask", "allow"] as const).map((list) => ({ list, rules: sourcedRules(sm, list) })),
				});
				return;
			}

			if (trimmed === "why") {
				pi.appendEntry<PermissionsData>("bluclawd:permissions", { mode: currentMode(), log: decisions });
				return;
			}

			const parts = trimmed.split(/\s+/);
			const verb = parts[0];

			// /permissions test <Verb(subject)> — which rules match this call, and what the
			// rule engine decides. Deliberately narrow: it reports the RULE decision and the
			// matching rules, NOT a prediction of the final outcome. The full outcome also
			// depends on the mode, protected paths, the read-only allowlist, the sandbox and
			// the real filesystem — a confident "allow" here that turned into a
			// prompt in the real call would be worse than no feature at all.
			if (verb === "test") {
				const spec = parts.slice(1).join(" ");
				const parsed = parseRuleSpec(spec);
				if (!parsed) {
					ctx.ui.notify(
						`Usage: /permissions test <Verb(subject)> — e.g. test "Bash(rm -rf /tmp/x)"\nGoverned verbs: ${governedVerbs().join(", ")}`,
						"warning",
					);
					return;
				}
				const effective = forkSettings.permissions(sm) ?? {};
				const lines = [`${spec} — in mode ${currentMode()}`, ""];
				let decided = false;
				for (const list of ["deny", "ask", "allow"] as const) {
					const hits = (effective[list] ?? []).filter((rule) =>
						ruleMatches(rule, list, parsed.tool, parsed.input, ctx.cwd),
					);
					if (hits.length === 0) continue;
					lines.push(`${decided ? "shadowed by" : "DECIDED BY"} ${list}:`);
					for (const rule of hits) lines.push(`  ${rule}`);
					decided = true;
				}
				if (!decided) {
					const byMode = {
						auto: "runs it",
						edits: "runs reads and file edits, and prompts for the rest",
						ask: "runs read-only calls, and prompts for the rest",
					};
					lines.push(`No rule matches — mode ${currentMode()} decides: it ${byMode[currentMode()]}.`);
				}
				pi.appendEntry<PermissionsData>("bluclawd:permissions", { mode: currentMode(), test: lines });
				return;
			}

			if (verb === "add") {
				const list = parts[1] as "allow" | "ask" | "deny";
				const rest = parts.slice(2);
				const toProject = rest.includes("--project");
				const rule = stripWrappingQuotes(rest.filter((token) => token !== "--project").join(" "));
				if (!["allow", "ask", "deny"].includes(list) || !isRule(rule)) {
					// A rule no gate reads would sit in settings looking like protection.
					ctx.ui.notify(
						`Usage: /permissions add <allow|ask|deny> <Rule(spec)> [--project] — e.g. add deny "Bash(curl **)"\nGoverned verbs: ${governedVerbs().join(", ")} (Mcp takes server:tool)`,
						"warning",
					);
					return;
				}
				if (toProject && !ctx.isProjectTrusted()) {
					ctx.ui.notify(
						"Cannot write project rules: this project is not trusted (its rules would be ignored anyway).",
						"error",
					);
					return;
				}
				if (toProject) await addProjectRule(ctx.cwd, list, rule, ctx.isProjectTrusted());
				else await addGlobalRule(list, rule);
				reloadRules(ctx); // effective immediately
				ctx.ui.notify(`Added ${list} rule (${toProject ? "project" : "global"}): ${rule}`, "info");
				return;
			}

			if (verb === "remove") {
				const rule = stripWrappingQuotes(
					parts
						.slice(1)
						.filter((token) => token !== "--project")
						.join(" "),
				);
				if (!rule) {
					ctx.ui.notify("Usage: /permissions remove <Rule(spec)>", "warning");
					return;
				}
				const removedGlobal = await removeGlobalRule(rule);
				const removedProject = await removeProjectRule(ctx.cwd, rule, ctx.isProjectTrusted());
				// A "Yes, for this session" grant is revoked the same way.
				const removedSession = sessionRules.allow?.includes(rule) ?? false;
				if (removedSession) sessionRules.allow = sessionRules.allow?.filter((r) => r !== rule);
				reloadRules(ctx);
				const where = [removedGlobal && "global", removedProject && "project", removedSession && "this session"]
					.filter(Boolean)
					.join(", ");
				ctx.ui.notify(
					where ? `Removed rule (${where}): ${rule}` : `Rule not found: ${rule}`,
					where ? "info" : "warning",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /permissions [why | test <Rule(spec)> | add <allow|ask|deny> <Rule(spec)> [--project] | remove <Rule(spec)>]",
				"warning",
			);
		},
	});
}

const permissionsExtension: InlineExtension = { name: "permissions", factory };
export default permissionsExtension.factory;
