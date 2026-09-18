/**
 * Permission gate for in-process subagent children (audit B.5).
 *
 * Children run with an isolated resource loader that discovers NO extensions,
 * so the full permissions extension (modes, ask prompts, footer) never loads
 * there — and before this gate existed a `deny: Bash(**)` rule was
 * circumventable by delegating to an agent def that grants bash.
 *
 * Two postures, chosen by whether the parent can be asked:
 *
 *   - No prompt bridge (headless parent, or the default export): only the
 *     parent's deny rules and the protected-path screen apply, under the mode the
 *     engine resolved (`auto` for the default export). Ask rules are deliberately
 *     NOT loaded: a child has no UI of its own, so an inherited ask would
 *     hard-block every governed tool. Under `ask` — a headless parent in `ask` —
 *     whatever the mode would prompt for is blocked, as it is for that parent.
 *
 *   - With a prompt bridge (the engine supplies one when the parent has a UI):
 *     the parent's FULL rule set applies, the child runs under the mode the
 *     engine resolved for it, and every verdict the parent would have PROMPTED
 *     for — ask rules, protected paths, unmatched work in `ask` — is put to the
 *     user in the parent's UI, naming the subagent, exactly as Claude Code
 *     surfaces a subagent's permission prompts in the main session.
 *
 * Enforcement runs through the SAME evaluator the parent uses (evaluate.ts).
 * It used to hand-roll its own copy, which had drifted: the parent learned to
 * screen bash redirect targets against protected paths, and to gate reads of
 * credential-bearing config, but this copy never did — so a child could install
 * `.bluclawd/hooks.json` with `echo … >` and read `auth.json`, both of which the
 * parent refused. One implementation, no drift — which is also why both halves
 * of the evaluator run here, not just the first.
 */

import type { ExtensionAPI, InlineExtension, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as forkSettings from "../_shared/settings.ts";
import { sandboxPosture } from "../sandbox/state.ts";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "./evaluate.ts";
import type { PermissionMode } from "./modes.ts";
import type { Rules } from "./rules.ts";

/** The parent's sandbox stance with the unsandboxed retry switched off. */
function childSandboxPosture(): EvalConfig["sandbox"] {
	const posture = sandboxPosture();
	return posture ? { ...posture, allowUnsandboxedCommands: false } : undefined;
}

export interface GatePromptRequest {
	title: string;
	message: string;
	/** The child's abort signal: a stopped child's question is withdrawn, not left open. */
	signal?: AbortSignal;
}

/** Puts one permission question to the user in the parent's UI. */
export type GatePrompt = (request: GatePromptRequest) => Promise<boolean>;

export interface SubagentGateOptions {
	/** The mode the child is evaluated under. Default: `auto`. */
	mode?: PermissionMode;
	/** Named in the prompt, so the user knows which child is asking. */
	agent?: string;
	/** Absent: nobody to ask, so anything the parent would prompt for is blocked. */
	prompt?: GatePrompt;
	/**
	 * Where the rules are read from. Default: the child's own cwd — which for a
	 * worktree child is a pristine HEAD checkout whose project settings lack every
	 * uncommitted or gitignored rule the parent's working tree has. The engine
	 * passes the PARENT's cwd, so the rules in force are the parent's; protected
	 * paths are still resolved against the child's cwd.
	 */
	rulesCwd?: string;
}

/** The parent's permission rules as they apply at `cwd` for a project of this trust. */
export function loadParentRules(cwd: string, trusted: boolean): Rules {
	try {
		return forkSettings.permissions(SettingsManager.create(cwd, undefined, { projectTrusted: trusted })) ?? {};
	} catch {
		return {};
	}
}

export interface SubagentCheck {
	mode: PermissionMode;
	/** Full rules when the user can be asked; the gate passes deny rules only otherwise. */
	rules: Rules;
	/** Protected paths resolve against this: the child's own cwd. */
	cwd: string;
	prompt?: GatePrompt;
	/** Who is asking, for the prompt title. */
	asker: string;
	signal?: AbortSignal;
}

/**
 * One tool call judged as the parent would judge it, prompting through the bridge
 * when the verdict is a prompt. Returns the block reason, or undefined when it may
 * run. Shared by the child gate and the commands the subagent layer runs itself
 * (acceptance gates, external runners), so neither can drift from the evaluator.
 */
export async function checkAsParent(
	toolName: string,
	input: Record<string, unknown>,
	check: SubagentCheck,
): Promise<string | undefined> {
	const cfg: EvalConfig = {
		mode: check.mode,
		rules: check.rules,
		cliAllowRules: {},
		cwd: check.cwd,
		agentDir: getAgentDir(),
		configDirName: CONFIG_DIR_NAME,
		hasUI: Boolean(check.prompt),
		// A child cannot leave the sandbox: its bash offers no
		// `dangerouslyDisableSandbox` (child-bash.ts), and the evaluator is told
		// the same so a smuggled parameter changes nothing here either.
		sandbox: childSandboxPosture(),
	};
	// Running BOTH halves unconditionally is what keeps this gate from drifting
	// from the parent the next time a gate is added there.
	let verdict = evaluatePreHook(toolName, input, cfg);
	// An approved protected READ falls through to the remaining gates, as in the parent:
	// approving `cat .mcp.json` must not also approve the rest of the line.
	if (verdict?.outcome === "prompt" && verdict.gate === "read-protected-path" && check.prompt) {
		const ok = await check.prompt({ title: check.asker, message: verdict.reason, signal: check.signal });
		if (!ok) return `Permission declined by the user — ${verdict.reason}`;
		verdict = undefined;
	}
	verdict ??= evaluatePostHook(toolName, input, cfg);
	if (verdict.outcome === "allow") return undefined;
	if (verdict.outcome === "prompt" && check.prompt) {
		const ok = await check.prompt({ title: check.asker, message: verdict.reason, signal: check.signal });
		return ok ? undefined : `Permission declined by the user — ${verdict.reason}`;
	}
	return verdict.reason;
}

export function createSubagentGate(options: SubagentGateOptions = {}): InlineExtension {
	const mode = options.mode ?? "auto";
	const agent = options.agent ?? "subagent";
	const prompt = options.prompt;
	const rulesCwd = options.rulesCwd;

	function factory(pi: ExtensionAPI): void {
		// Loaded LAZILY on the first governed tool_call, not in session_start:
		// subagent children are built by the subagents engine without
		// bindExtensions(), so session_start NEVER fires for them and rules loaded
		// there would stay empty — leaving this gate inert and deny rules
		// circumventable by delegation, which is the exact hole it exists to close.
		let allRules: Rules | undefined;

		/** Full rules when the user can be asked; deny only otherwise — see the header. */
		function rulesFor(ctx: { cwd: string; isProjectTrusted: () => boolean }): Rules {
			allRules ??= loadParentRules(rulesCwd ?? ctx.cwd, ctx.isProjectTrusted());
			return prompt ? allRules : { deny: allRules.deny ?? [] };
		}

		// A reload re-reads settings; drop the cache so the next call picks them up.
		pi.on("session_start", async () => {
			allRules = undefined;
		});

		pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			// `task` is judged too: a nested child's delegations meet the parent's Task rules.
			const reason = await checkAsParent(event.toolName, event.input as Record<string, unknown>, {
				mode,
				rules: rulesFor(ctx),
				cwd: ctx.cwd,
				prompt,
				asker: `Subagent "${agent}" needs permission`,
				signal: ctx.signal,
			});
			return reason === undefined ? undefined : { block: true, reason };
		});
	}

	return { name: "subagent-permission-gate", factory };
}

/** The no-bridge posture: auto, deny rules only, block instead of prompt. */
const subagentPermissionGate: InlineExtension = createSubagentGate();
export default subagentPermissionGate;
