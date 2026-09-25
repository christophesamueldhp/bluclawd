/**
 * The bash tool a subagent child runs: the parent's sandbox, the child's cwd.
 *
 * A child session loads no extensions, so without this its bash is pi's stock
 * tool — unsandboxed even while the parent's `/sandbox` is on, unaware of
 * `sandbox.failIfUnavailable`, and without Claude Code's background paths. The
 * parent publishes its operations and refusal through `state.ts`; this inline
 * extension builds the same Claude Code bash the parent has (bash-tool.ts) on top
 * of them, for the child's own working directory. Registers nothing when no
 * parent published (a session without the sandbox extension), leaving pi's
 * default in place.
 *
 * Deliberately without the parent's `dangerouslyDisableSandbox` parameter: a
 * child has nobody to ask, so it cannot leave the sandbox (excludedCommands
 * still apply, as they do for the parent).
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createClaudeBashTool } from "./bash-tool.ts";
import { childBashProvider } from "./state.ts";

export function createChildBashExtension(
	cwd: string,
	options: { endsWithFinalResponse?: boolean } = {},
): InlineExtension {
	return {
		name: "subagent-sandboxed-bash",
		factory(pi) {
			const provider = childBashProvider();
			if (!provider) return;
			pi.registerTool(
				createClaudeBashTool({
					cwd,
					shellPath: provider.shellPath,
					commandPrefix: provider.commandPrefix,
					// Asked per call, as the parent does: whether the sandbox is active can
					// change under a long-running child (`/sandbox off`).
					operations: (command) => provider.operations(command),
					refusal: () => provider.refusal(),
					sendMessage: (message, delivery) => pi.sendMessage(message, delivery),
					isMain: false,
					sandboxEscape: false,
					endsWithFinalResponse: options.endsWithFinalResponse,
				}),
			);
		},
	};
}
