/**
 * Deny-only permission gate for in-process subagent children (audit B.5).
 *
 * Children run headless with an isolated resource loader that discovers NO
 * extensions, so the full permissions extension (modes, ask prompts, footer)
 * never loads there — and before this gate existed a `deny: Bash(**)` rule was
 * circumventable by delegating to an agent def that grants bash.
 *
 * This gate loads ONLY the deny rules (trust-aware, same settings files as the
 * parent) and enforces them plus the protected-paths guard. Ask rules are
 * deliberately NOT propagated: a child has no UI to answer a prompt, so an
 * inherited ask would hard-block every governed tool and break subagents
 * entirely. deny is the safety-critical layer; allow/ask stay parent-side. The
 * parent's mode is not inherited either: a child is always evaluated as `auto`,
 * the one mode under which a call no rule names can run without a prompt —
 * a child has nobody to answer one.
 *
 * Enforcement runs through the SAME evaluator the parent uses (evaluate.ts), in
 * headless mode. It used to hand-roll its own copy, which had drifted: the parent
 * learned to screen bash redirect targets against protected paths, and to gate
 * reads of credential-bearing config, but this copy never did — so a child could
 * install `.bluclawd/hooks.json` with `echo … >` and read `auth.json`, both of
 * which the parent refused. One implementation, no drift — which is also why both
 * halves of the evaluator run here, not just the first.
 */

import type { ExtensionAPI, InlineExtension, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as forkSettings from "../_shared/settings.ts";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "./evaluate.ts";
import type { Rules } from "./rules.ts";

export function factory(pi: ExtensionAPI): void {
	// Loaded LAZILY on the first governed tool_call, not in session_start:
	// subagent children are built by the subagents engine without
	// bindExtensions(), so session_start NEVER fires for them and rules loaded
	// there would stay empty — leaving this gate inert and deny rules
	// circumventable by delegation, which is the exact hole it exists to close.
	let allRules: Rules | undefined;

	/** The parent's full rule set, cached. Narrowed per call by {@link rulesFor}. */
	function loadRules(ctx: { cwd: string; isProjectTrusted: () => boolean }): Rules {
		if (allRules) return allRules;
		try {
			const sm = SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			allRules = forkSettings.permissions(sm) ?? {};
		} catch {
			allRules = {};
		}
		return allRules;
	}

	/** Deny rules only — see the header. */
	function rulesFor(ctx: { cwd: string; isProjectTrusted: () => boolean }): Rules {
		return { deny: loadRules(ctx).deny ?? [] };
	}

	// A reload re-reads settings; drop the cache so the next call picks them up.
	pi.on("session_start", async () => {
		allRules = undefined;
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		// hasUI false: anything the parent would have PROMPTED for becomes a block,
		// because a child has nobody to ask. `task` is stripped from child tool sets, but
		// the evaluator gates it anyway (defense in depth against a custom tool set
		// reintroducing it).
		const cfg: EvalConfig = {
			mode: "auto",
			rules: rulesFor(ctx),
			cliAllowRules: {},
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			hasUI: false,
		};

		const input = event.input as Record<string, unknown>;
		const pre = evaluatePreHook(event.toolName, input, cfg);
		// `prompt` is unreachable with hasUI:false, but a verdict that is not an explicit
		// allow must never fall through to "permitted" in a gate whose job is to refuse.
		if (pre) return pre.outcome === "allow" ? undefined : { block: true, reason: pre.reason };

		// Both halves run unconditionally, so the next gate added to the evaluator applies
		// here too instead of leaving this copy to drift from the parent again. With deny
		// rules only and auto mode, the second half allows everything today.
		const post = evaluatePostHook(event.toolName, input, cfg);
		if (post.outcome !== "allow") return { block: true, reason: post.reason };
		return;
	});
}

const subagentPermissionGate: InlineExtension = {
	name: "subagent-permission-gate",
	factory,
};
export default subagentPermissionGate;
