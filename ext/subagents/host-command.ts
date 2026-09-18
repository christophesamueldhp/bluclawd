/**
 * A shell command the subagent layer runs itself — an acceptance gate, an external
 * CLI runner — rather than a child's model asking for it.
 *
 * It is still a bash call and gets exactly what the parent's own bash gets: judged
 * by the parent's rules under the parent's mode (a deny blocks it; an ask, or an
 * unmatched command in `ask`, prompts the user — and is blocked when nobody can be
 * asked), then run through the sandbox's operations when the sandbox publishes them.
 */

import { type BashOperations, createBashTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getActivePermissionMode } from "../permissions/active-mode.ts";
import { checkAsParent, type GatePrompt, loadParentRules } from "../permissions/subagent-gate.ts";
import { childBashProvider } from "../sandbox/state.ts";

export interface HostCommandOptions {
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
	/** Where the command runs: the child's cwd, a worktree for a worktree child. */
	cwd: string;
	/** Who asks, in the permission prompt title. */
	asker: string;
	prompt?: GatePrompt;
	signal?: AbortSignal;
	/** Seconds. */
	timeout?: number;
}

export type HostCommandResult =
	| { outcome: "passed"; output: string }
	| { outcome: "failed"; output: string }
	| { outcome: "blocked"; output: string };

export type RunHostCommand = (command: string, options: HostCommandOptions) => Promise<HostCommandResult>;

const text = (content: Array<{ type: string; text?: string }>): string =>
	content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");

export const runHostCommand: RunHostCommand = async (command, options) => {
	const blocked = await checkAsParent(
		"bash",
		{ command },
		{
			mode: getActivePermissionMode(),
			rules: loadParentRules(options.ctx.cwd, options.ctx.isProjectTrusted()),
			cwd: options.cwd,
			prompt: options.prompt,
			asker: options.asker,
			signal: options.signal,
		},
	);
	if (blocked !== undefined) return { outcome: "blocked", output: blocked };

	const provider = childBashProvider();
	const refusal = provider?.refusal();
	if (refusal) return { outcome: "blocked", output: refusal };
	const operations: BashOperations | undefined = provider?.operations(command);
	const tool = createBashTool(options.cwd, {
		shellPath: provider?.shellPath,
		commandPrefix: provider?.commandPrefix,
		...(operations ? { operations } : {}),
	});
	try {
		const result = await tool.execute("host-command", { command, timeout: options.timeout }, options.signal);
		return { outcome: "passed", output: text(result.content as Array<{ type: string; text?: string }>) };
	} catch (err) {
		// pi's bash tool throws for a non-zero exit, with the output and the exit status.
		return { outcome: "failed", output: err instanceof Error ? err.message : String(err) };
	}
};
