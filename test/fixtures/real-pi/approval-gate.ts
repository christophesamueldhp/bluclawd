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
