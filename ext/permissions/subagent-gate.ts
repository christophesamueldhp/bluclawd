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
 * entirely. deny is the safety-critical layer; allow/ask stay parent-side.
 *
 * `never` is the ONE mode that changes that, and it has to. The mode means "run
 * only what is listed", so leaving a child on the default posture would make an
 * `allow: Task(...)` grant a laundering route: the parent refuses an unlisted
 * write, the child performs it. Under `never` the child therefore inherits the
 * mode AND the whole rule set — ask rules included, since nothing prompts in that
 * mode anyway, so parent and child reach the same verdict. Its posture is exactly
 * the parent's. `edits` is still not inherited (pre-existing; see
 * active-mode.ts).
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
import { getActivePermissionMode } from "./active-mode.ts";
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

	/**
	 * Deny-only normally; the whole set under `never`, where the child must be able
	 * to do what the parent explicitly allowed and must refuse what it did not. The
	 * mode is read per call, not cached, so switching it mid-session takes effect.
	 */
	function rulesFor(ctx: { cwd: string; isProjectTrusted: () => boolean }, neverMode: boolean): Rules {
		const rules = loadRules(ctx);
		return neverMode ? rules : { deny: rules.deny ?? [] };
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
		const neverMode = getActivePermissionMode() === "never";
		const cfg: EvalConfig = {
			mode: neverMode ? "never" : "ask",
			rules: rulesFor(ctx, neverMode),
			cliAllowRules: {},
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			sandboxActive: false,
			hasUI: false,
		};

		const input = event.input as Record<string, unknown>;
		const pre = evaluatePreHook(event.toolName, input, cfg);
		// `prompt` is unreachable with hasUI:false, but a verdict that is not an explicit
		// allow must never fall through to "permitted" in a gate whose job is to refuse.
		if (pre) return pre.outcome === "allow" ? undefined : { block: true, reason: pre.reason };

		// The second half. Under `never` it applies the whole inherited rule set; in every
		// other mode it now contributes exactly one thing — the deterministic guardrail,
		// whose refusal the parent turns into a prompt and a child, having nobody to ask,
		// turns into a block. Without it `task` would launder every guardrail-refused
		// command: the parent asks before `rm -rf`, the child just runs it.
		//
		// Running BOTH halves unconditionally is what surfaced that for free, and is what
		// keeps this gate from drifting from the parent again the next time a gate is added.
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
