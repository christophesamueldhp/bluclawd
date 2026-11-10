/**
 * A policy in a run's pi (test/subagent-rpc-approvals.test.ts) that needs the user's approval before reading a file
 * named `*.gated`: an approval a run may ask for, as bluclawd's own policy will once runs have a shell.
 */
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askRunApproval } from "../../../ext/subagents/run-approvals.ts";

export default function approvalGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		const path = (event.input as { path?: unknown }).path;
		if (event.toolName !== "read" || typeof path !== "string" || !path.endsWith(".gated")) return undefined;
		return askRunApproval(ctx.ui, { action: "read", target: resolve(ctx.cwd, path) }, ctx.signal);
	});
}
