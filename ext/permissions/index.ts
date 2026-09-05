/**
 * Permissions core extension (PLAN.md F2.1).
 *
 * Governs every `tool_call` against a `Verb(glob)` rule set (rules.ts) with a
 * deny > ask > allow precedence, layered under a session permission mode
 * (modes.ts): always / edits / ask / auto / never.
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
import { addGlobalRule, addProjectRule, removeGlobalRule, removeProjectRule } from "../_shared/settings-write.ts";
import { isSandboxActive } from "../sandbox/state.ts";
import { setActivePermissionMode } from "./active-mode.ts";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "./evaluate.ts";
import {
	createModeStore,
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
} from "./rules.ts";

/** What `/permissions` renders: either the rule lists, or one `test` result. */
interface PermissionsData {
	mode: PermissionMode;
	lists?: Array<{ list: "deny" | "ask" | "allow"; rules: string[] }>;
	test?: string[];
}

/** Claude Code's `autoAccept` badge colour (2.1.259 dark): rgb(175,135,255). */
const CC_AUTO_ACCEPT = "\x1b[38;2;175;135;255m";

/**
 * Footer chip for a mode, in Claude Code's own badge colours (extracted from the
 * 2.1.259 binary's dark theme): edits=#af87ff, auto=amber, always and never=red,
 * ask=gray. The wording follows this layer's own mode names, not CC's labels.
 *
 * Two things this gets right that the previous version did not:
 *
 * - `edits` (Claude Code's accept-edits) is PURPLE, not green. pi's theme has no token for it, so
 *   `success` was the stand-in — and green is the one colour that reads as the
 *   opposite of what the badge means. It is painted with a raw truecolor escape
 *   instead, which the ccstatusline footer next to it already does for its own
 *   widgets. A 256-colour terminal would not downconvert the escape, so that
 *   case keeps the theme token.
 * - `ask` carries NO symbol. `⏸` is Claude Code's *plan mode* badge, and
 *   plan mode is not part of this layer, so the symbol pointed at nothing.
 */
function modeStatusText(ctx: ExtensionContext, mode: PermissionMode): string | undefined {
	const theme = ctx.ui.theme;
	switch (mode) {
		case "ask":
			return theme.fg("muted", "ask mode on");
		case "edits":
			return theme.getColorMode() === "truecolor"
				? `${CC_AUTO_ACCEPT}⏵⏵ edits mode on\x1b[0m`
				: theme.fg("success", "⏵⏵ edits mode on");
		case "auto":
			return theme.fg("warning", "⏵⏵ auto mode on");
		case "always":
			return theme.fg("error", "⏵⏵ always mode on");
		case "never":
			return theme.fg("error", "⏵⏵ never mode on");
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
		description: "Start sessions in bypass mode (alias for --permission-mode bypass)",
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
	// Mode store: created in session_start (fresh "ask" state), disposed in
	// session_shutdown. Undefined before the first session_start → treat as "ask".
	let modeStore: ModeStore | undefined;
	// Latest live context, captured in handlers so the event-driven footer refresh
	// has a ctx. Optional-chained + try/guarded so a stale instance is a safe no-op.
	let liveCtx: ExtensionContext | undefined;

	// Auto-mode fallback state (reset on session_start). Mirrors CC: any allowed action
	// resets `consecutive`; `total` persists for the session. Thresholds are configurable.
	let consecutiveBlocks = 0;
	let totalBlocks = 0;
	let autoMaxConsecutive = 3;
	let autoMaxTotal = 20;

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
			if (RULE_SHAPE.test(entry)) {
				out.push(entry);
				continue;
			}
			const verb = governedVerbs().find((v) => v.toLowerCase() === entry.toLowerCase());
			if (verb) out.push(`${verb}(**)`);
		}
		return out;
	}

	/** Load auto-mode fallback thresholds from settings (defaults 3 / 20; positive ints only). */
	function loadAutoModeConfig(ctx: ExtensionContext): void {
		let cfg: { maxConsecutiveBlocks?: number; maxTotalBlocks?: number } | undefined;
		try {
			const sm = SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			cfg = forkSettings.permissions(sm)?.autoMode;
		} catch {
			cfg = undefined;
		}
		const posInt = (v: unknown, fallback: number): number =>
			typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : fallback;
		autoMaxConsecutive = posInt(cfg?.maxConsecutiveBlocks, 3);
		autoMaxTotal = posInt(cfg?.maxTotalBlocks, 20);
	}

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		// Dispose any prior store first so resume/new/fork re-runs stay idempotent.
		modeStore?.dispose();
		// Trust is read through a live callback, not captured: pi resolves it during
		// startup and `/trust` can grant it mid-session, so a snapshot would strand the
		// session in the clamped mode for good.
		modeStore = createModeStore(onModeChanged, () => ctx.isProjectTrusted());
		// Starting mode from settings (Claude Code parity with permissions.defaultMode).
		// GLOBAL settings only — a trusted project may contribute allow rules, but
		// letting it name the mode would let any repo ship `defaultMode: "always"`
		// and switch the whole safety layer off. CLI flags below still override this.
		applySettingsDefaultMode(ctx);
		rules = loadRules(ctx);
		loadAutoModeConfig(ctx);
		consecutiveBlocks = 0;
		totalBlocks = 0;
		// PI_PERMISSION_MODE=ask (set by the FleetView orchestrator for spawned background
		// sessions) makes the agent ask before every governed tool, so it surfaces a blocking
		// prompt an attach viewer can answer. Rules-based so it never touches the mode union.
		// Derived from governedVerbs() so it always covers exactly what decide() can gate — a
		// hand-kept list would silently miss any verb added to governance later. Since audit
		// B.5 this includes Mcp and Task, so MCP tools and subagent delegation prompt too.
		if (process.env.PI_PERMISSION_MODE === "ask") {
			const askAll = governedVerbs().map((verb) => `${verb}(**)`);
			rules = { ...rules, ask: [...(rules.ask ?? []), ...askAll] };
		}
		// CC headless interop (audit B.6): --disallowedTools merges into the deny
		// list (deny > ask > allow, so it wins everywhere except bypass mode);
		// --allowedTools populates the separate cliAllowRules grant set.
		const denyFlag = pi.getFlag("disallowedTools");
		if (typeof denyFlag === "string" && denyFlag) {
			rules = {
				...rules,
				deny: [...(rules.deny ?? []), ...parseToolRuleFlag(denyFlag)],
			};
		}
		const allowFlag = pi.getFlag("allowedTools");
		cliAllowRules = typeof allowFlag === "string" && allowFlag ? { allow: parseToolRuleFlag(allowFlag) } : {};
		// Initial mode from the CLI: --dangerously-skip-permissions (CC alias) wins
		// over --permission-mode. Sets the *initial* mode only — Alt+M and /mode
		// still switch freely afterwards.
		const modeFlag = pi.getFlag("dangerously-skip-permissions") === true ? "always" : pi.getFlag("permission-mode");
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
	async function persistAlwaysAllow(exact: string, toProject: boolean, ctx: ExtensionContext): Promise<void> {
		const parsed = parseRuleSpec(exact);
		const segments = parsed?.tool === "bash" ? bashSegments(String(parsed.input.command ?? "")) : undefined;
		const toPersist =
			segments && segments.length > 1
				? [...new Set(segments.map((segment) => exactRule("bash", segment)).filter((r) => r !== null))].slice(
						0,
						MAX_COMPOUND_ALLOW_RULES,
					)
				: [exact];

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
	 * The full permission prompt: Yes / No / Always allow / Always allow (project).
	 * The project option persists into `.bluclawd/settings.json` and is offered only when
	 * the project is trusted (untrusted project rules are never read anyway).
	 */
	async function askWithScope(
		label: string,
		exact: string | null,
		ctx: ExtensionContext,
	): Promise<"allow" | "deny" | "failed"> {
		let choice: string | undefined;
		try {
			const options = ["Yes", "No", "Always allow", ...(ctx.isProjectTrusted() ? ["Always allow (project)"] : [])];
			choice = await ctx.ui.select(label, options);
		} catch {
			return "failed";
		}
		if (choice === "Always allow" || choice === "Always allow (project)") {
			if (exact) await persistAlwaysAllow(exact, choice === "Always allow (project)", ctx);
			return "allow";
		}
		return choice === "Yes" ? "allow" : "deny";
	}

	/**
	 * The gate. Decision logic lives in evaluate.ts as a pure function of the inputs
	 * gathered here; this handler owns only the I/O a verdict calls for — prompting,
	 * persisting an "Always allow", and advancing the auto-mode counters.
	 */
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		liveCtx = ctx;
		const tool = event.toolName;
		const input = event.input as Record<string, unknown>;
		const cfg: EvalConfig = {
			mode: currentMode(),
			rules,
			cliAllowRules,
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			sandboxActive: isSandboxActive(),
			hasUI: ctx.hasUI,
		};

		// Gates 1-4: mode blocks, deny rules, protected paths.
		const pre = evaluatePreHook(tool, input, cfg);
		if (pre?.outcome === "allow") return;
		if (pre?.outcome === "block") return { block: true, reason: pre.reason };
		if (pre?.outcome === "prompt") {
			const approved = await confirm(pre.reason, ctx);
			if (approved === "failed") {
				return {
					block: true,
					reason: "Permission prompt failed or was interrupted. Blocked by default.",
				};
			}
			if (!approved) {
				const what = pre.gate === "read-protected-path" ? "Read of" : "Write to";
				return {
					block: true,
					reason: `${what} protected path denied: ${pre.protectedPath}`,
				};
			}
			// An approved WRITE to a protected path is granted once and we are done. An
			// approved READ falls through: the read gate is narrow (credentials only) and
			// the call still has to satisfy the ordinary ask/auto gates below.
			if (pre.gate === "write-protected-path") return;
		}

		// Gates 6-9: auto mode's guardrail, the standing grants that clear an ask, and the
		// prompt.
		const post = evaluatePostHook(tool, input, cfg);

		// Auto mode owns counters, so its outcomes are handled before the generic ones.
		if (post.gate === "auto-guardrail" || (cfg.mode === "auto" && post.outcome === "allow")) {
			if (post.outcome === "allow") {
				// NOTE: an exact "Always allow" grant deliberately does NOT reset the
				// consecutive counter — preserved from the pre-refactor implementation.
				if (post.gate !== "exact-allow") consecutiveBlocks = 0;
				return;
			}
			consecutiveBlocks += 1;
			totalBlocks += 1;
			const shouldPrompt = consecutiveBlocks >= autoMaxConsecutive || totalBlocks >= autoMaxTotal;
			if (!shouldPrompt || !ctx.hasUI) return { block: true, reason: post.reason };
			// Threshold hit: pause auto mode and ask, so the user can approve and resume.
			const outcome = await askWithScope(`Auto mode paused — ${post.reason}`, post.exact ?? null, ctx);
			if (outcome === "failed" || outcome === "deny") return { block: true, reason: post.reason };
			consecutiveBlocks = 0;
			return;
		}

		if (post.outcome === "allow") return;
		if (post.outcome === "block") return { block: true, reason: post.reason };

		const outcome = await askWithScope(post.reason, post.exact ?? null, ctx);
		if (outcome === "failed") {
			return {
				block: true,
				reason: "Permission prompt failed or was interrupted. Blocked by default.",
			};
		}
		if (outcome === "deny") return { block: true, reason: "Permission denied by user." };
		return;
	});

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
		description: `Choose a permission mode (${PERMISSION_MODES.join(" / ")}); Alt+M cycles the first three`,
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
			// `/thinking` do — cycling blind through five modes (two of which are not even
			// in the cycle) never showed what the other options were, or what they mean.
			// Alt+M is still the fast path for the three-mode cycle.
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

	// /permissions — view or edit rules (CC parity, audit B.3). Rule syntax is
	// validated shallowly (Verb(spec)); the glob semantics live in rules.ts.
	const RULE_SHAPE = /^[A-Za-z]+\(.+\)$/;

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
		if (data.test) {
			for (const line of data.test) lines.push(`  ${line}`);
			lines.push("");
			lines.push(
				theme.fg(
					"dim",
					"This is the RULE decision only. The final outcome can still differ: protected paths, a PreToolUse hook, the sandbox pairing and auto mode's guardrail all apply on top.",
				),
			);
		} else {
			// deny/ask/allow keep their precedence order and take the colour that says
			// which way each list pushes — the flat string could only indent them.
			const colour = { deny: "error", ask: "warning", allow: "success" } as const;
			for (const { list, rules } of data.lists ?? []) {
				lines.push("");
				lines.push(`${theme.fg(colour[list], list)} ${theme.fg("dim", `(${rules.length})`)}`);
				for (const rule of rules) lines.push(`  ${rule}`);
				if (rules.length === 0) lines.push(theme.fg("muted", "  none"));
			}
			lines.push("");
			lines.push(
				theme.fg(
					"dim",
					"/permissions test <Rule(spec)> · /permissions add <allow|ask|deny> <Rule(spec)> [--project] · /permissions remove <Rule(spec)>",
				),
			);
		}
		container.addChild(new Text(lines.join("\n"), 1, 0));
		return container;
	});

	pi.registerCommand("permissions", {
		description:
			"View, test or edit permission rules: /permissions [test <Rule(spec)> | add <allow|ask|deny> <Rule(spec)> [--project] | remove <Rule(spec)>]",
		handler: async (args, ctx) => {
			liveCtx = ctx;
			const trimmed = args.trim();
			const sm = SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			});

			if (!trimmed) {
				const effective = forkSettings.permissions(sm) ?? {};
				pi.appendEntry<PermissionsData>("bluclawd:permissions", {
					mode: currentMode(),
					lists: (["deny", "ask", "allow"] as const).map((list) => ({ list, rules: effective[list] ?? [] })),
				});
				return;
			}

			const parts = trimmed.split(/\s+/);
			const verb = parts[0];

			// /permissions test <Verb(subject)> — which rules match this call, and what the
			// rule engine decides. Deliberately narrow: it reports the RULE decision and the
			// matching rules, NOT a prediction of the final outcome. The full outcome also
			// depends on the mode, protected paths, a PreToolUse hook, the sandbox, the auto
			// counters and the real filesystem — a confident "allow" here that turned into a
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
					lines.push(
						currentMode() === "never"
							? "No rule matches — and never mode refuses whatever no rule allows, so the call is blocked."
							: "No rule matches — the call runs (nothing is denied, nothing prompts).",
					);
				}
				pi.appendEntry<PermissionsData>("bluclawd:permissions", { mode: currentMode(), test: lines });
				return;
			}

			if (verb === "add") {
				const list = parts[1] as "allow" | "ask" | "deny";
				const rest = parts.slice(2);
				const toProject = rest.includes("--project");
				const rule = stripWrappingQuotes(rest.filter((token) => token !== "--project").join(" "));
				if (!["allow", "ask", "deny"].includes(list) || !RULE_SHAPE.test(rule)) {
					ctx.ui.notify(
						'Usage: /permissions add <allow|ask|deny> <Rule(spec)> [--project] — e.g. add deny "Bash(curl **)"',
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
				rules = loadRules(ctx); // effective immediately
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
				rules = loadRules(ctx);
				ctx.ui.notify(
					removedGlobal || removedProject
						? `Removed rule${removedGlobal ? " (global)" : ""}${removedProject ? " (project)" : ""}: ${rule}`
						: `Rule not found: ${rule}`,
					removedGlobal || removedProject ? "info" : "warning",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /permissions [add <allow|ask|deny> <Rule(spec)> [--project] | remove <Rule(spec)>]",
				"warning",
			);
		},
	});
}

const permissionsExtension: InlineExtension = { name: "permissions", factory };
export default permissionsExtension.factory;
