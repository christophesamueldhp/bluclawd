/**
 * The bash tool a subagent child runs: the parent's sandbox, the child's cwd.
 *
 * A child session loads no extensions, so without this its bash is pi's stock
 * tool — unsandboxed even while the parent's `/sandbox` is on, and unaware of
 * `sandbox.strict`. The parent publishes its operations and refusal through
 * `state.ts`; this inline extension registers a bash tool on top of them for the
 * child's own working directory. Registers nothing when no parent published
 * (a session without the sandbox extension), leaving pi's default in place.
 */

import { createBashTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { childBashProvider } from "./state.ts";

export function createChildBashExtension(cwd: string): InlineExtension {
	return {
		name: "subagent-sandboxed-bash",
		factory(pi) {
			const provider = childBashProvider();
			if (!provider) return;
			const { shellPath, commandPrefix } = provider;
			pi.registerTool({
				...createBashTool(cwd, { shellPath, commandPrefix }),
				async execute(id, params, signal, onUpdate) {
					const refusal = provider.refusal();
					if (refusal) return { content: [{ type: "text", text: refusal }], isError: true, details: undefined };
					// Built per call, as the parent does: whether the sandbox is active can
					// change under a long-running child (`/sandbox off`).
					const tool = createBashTool(cwd, { shellPath, commandPrefix, operations: provider.operations() });
					return tool.execute(id, params, signal, onUpdate);
				},
			});
		},
	};
}

export const childBashExtension: InlineExtension = createChildBashExtension(process.cwd());
