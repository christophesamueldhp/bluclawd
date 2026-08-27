/**
 * Permissions core extension (PLAN.md F2.1).
 *
 * Governs every `tool_call` against a `Verb(glob)` rule set (rules.ts) with a
 * deny > ask > allow precedence, layered under a session permission mode
 * (modes.ts): bypass / acceptEdits / default / auto / dontAsk.
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

import { Key } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../packages/coding-agent/src/config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolCallEventResult,
} from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import * as forkSettings from "../_shared/settings.ts";
import { addGlobalRule, addProjectRule, removeGlobalRule, removeProjectRule } from "../_shared/settings-write.ts";
import { decidePermissionViaHooks, notifyPermissionPrompt } from "../hooks/permissions-bridge.ts";
import { isSandboxActive } from "../sandbox/state.ts";
import { setActivePermissionMode } from "./active-mode.ts";
import { type EvalConfig, evaluatePostHook, evaluatePreHook, type HookDecision } from "./evaluate.ts";
import { createModeStore, type ModeStore, PERMISSION_MODES, type PermissionMode } from "./modes.ts";
import {
	bashSegments,
	decide,
	exactRule,
	governedVerbs,
	parseRuleSpec,
	type Rules,
	stripWrappingQuotes,
} from "./rules.ts";

/**
 * Footer chip for a mode. Labels/symbols/colors mirror Claude Code (2.1.207/2.1.220 dark):
 * manual=gray ⏸, accept edits=purple ⏵⏵, auto=amber ⏵⏵, bypass=red ⏵⏵,
 * don't ask=red ⏵⏵ (CC's own badge entry is `{indicator:"don't ask", symbol:"⏵⏵", color:"error"}`).
 */
function modeStatusText(ctx: ExtensionContext, mode: PermissionMode): string | undefined {
	switch (mode) {
		case "default":
			return ctx.ui.theme.fg("muted", "⏸ manual mode on");
		case "acceptEdits":
			return ctx.ui.theme.fg("success", "⏵⏵ accept edits on");
		case "auto":
			return ctx.ui.theme.fg("warning", "⏵⏵ auto mode on");
		case "bypass":
			return ctx.ui.theme.fg("error", "⏵⏵ bypass permissions on");
		case "dontAsk":
			return ctx.ui.theme.fg("error", "⏵⏵ don't ask on");
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
	// Mode store: created in session_start (fresh "default" state), disposed in
	// session_shutdown. Undefined before the first session_start → treat as "default".
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

	const currentMode = (): PermissionMode => modeStore?.get() ?? "default";

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
		if (!(PERMISSION_MODES as readonly string[]).includes(configured)) {
			ctx.ui.notify(
				`Invalid permissions.defaultMode "${configured}" in settings. Valid: ${PERMISSION_MODES.join(", ")}`,
				"warning",
			);
			return;
		}
		modeStore?.set(configured as PermissionMode);
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
		modeStore = createModeStore(onModeChanged);
		// Starting mode from settings (Claude Code parity with permissions.defaultMode).
		// GLOBAL settings only — a trusted project may contribute allow rules, but
		// letting it name the mode would let any repo ship `defaultMode: "bypass"`
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
		// over --permission-mode. Sets the *initial* mode only — Shift+Tab and /mode
		// still switch freely afterwards.
		const modeFlag = pi.getFlag("dangerously-skip-permissions") === true ? "bypass" : pi.getFlag("permission-mode");
		if (typeof modeFlag === "string" && modeFlag) {
			if ((PERMISSION_MODES as readonly string[]).includes(modeFlag)) {
				modeStore.set(modeFlag as PermissionMode);
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
		setActivePermissionMode("default");
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
		notifyPermissionPrompt(label, ctx);
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
		notifyPermissionPrompt(label, ctx);
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
	 * notifying hooks, persisting an "Always allow", and advancing the auto-mode counters.
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

		// Gates 1-5: mode blocks, deny rules, protected paths. A hook may never override
		// any of them, which is why they run before it.
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

		// PreToolUse permissionDecision (CC parity, audit B.4). The hooks extension caches
		// this run by toolCallId so the hook commands execute exactly once per call.
		const hookDecision = await decidePermissionViaHooks({ toolCallId: event.toolCallId, toolName: tool, input }, ctx);
		if (hookDecision?.decision === "deny") {
			return {
				block: true,
				reason: hookDecision.reason ?? "Blocked by a PreToolUse hook (permissionDecision: deny).",
			};
		}
		const hook: HookDecision =
			hookDecision?.decision === "allow" ? "allow" : hookDecision?.decision === "ask" ? "ask" : undefined;

		// Gates 6-9: the hook's verdict, auto mode's guardrail, the standing grants that
		// clear an ask, and the prompt.
		const post = evaluatePostHook(tool, input, cfg, hook);

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

		// A hook allowed the call but the guardrail did not: a two-option confirmation,
		// never an "Always allow" (that would persist a grant the guardrail refused).
		if (post.gate === "hook-allow") {
			notifyPermissionPrompt(`Guardrail — ${post.reason}`, ctx);
			let hookChoice: string | undefined;
			try {
				hookChoice = await ctx.ui.select(`A hook allowed this, but ${post.reason}`, ["Yes", "No"]);
			} catch {
				return { block: true, reason: post.reason };
			}
			if (hookChoice === "Yes") return;
			return { block: true, reason: post.reason };
		}

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
		const next = modeStore.cycle();
		refreshStatus();
		ctx.ui.notify(`Permission mode: ${next}`, "info");
	}

	pi.registerCommand("mode", {
		description:
			"Cycle permission mode (default → acceptEdits → auto); /mode bypass allows everything, /mode dontAsk denies whatever would have prompted",
		handler: async (args, ctx) => {
			const requested = args.trim() as PermissionMode;
			if (requested && (PERMISSION_MODES as readonly string[]).includes(requested)) {
				liveCtx = ctx;
				if (!modeStore) return;
				modeStore.set(requested);
				refreshStatus();
				ctx.ui.notify(`Permission mode: ${requested}`, "info");
				return;
			}
			await cycleAndReport(ctx);
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
				const lines: string[] = [`Permission mode: ${currentMode()}`];
				for (const list of ["deny", "ask", "allow"] as const) {
					const entries = effective[list] ?? [];
					lines.push(`${list} (${entries.length}):`);
					for (const rule of entries) lines.push(`  ${rule}`);
				}
				lines.push("");
				lines.push(
					"Test: /permissions test <Rule(spec)> · Edit: /permissions add <allow|ask|deny> <Rule(spec)> [--project] · /permissions remove <Rule(spec)>",
				);
				ctx.ui.notify(lines.join("\n"), "info");
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
						currentMode() === "dontAsk"
							? "No rule matches — and dontAsk mode refuses whatever no rule allows, so the call is blocked."
							: "No rule matches — the call runs (nothing is denied, nothing prompts).",
					);
				}
				lines.push("");
				lines.push(
					"This is the RULE decision only. The final outcome can still differ: protected paths, a PreToolUse hook, the sandbox pairing and auto mode's guardrail all apply on top.",
				);
				ctx.ui.notify(lines.join("\n"), "info");
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
export default permissionsExtension;
