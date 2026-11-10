/**
 * Tools an extension in a run's pi could add (test/subagent-rpc-capabilities.test.ts), each of which leaves
 * `<name>.poked` in the pi's directory when it runs: one under a plain name, one named as an MCP tool that claims
 * to only read, and one registered late, once the session has started.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function poke(name: string, exposure: ToolDefinition["exposure"]): ToolDefinition {
	return {
		name,
		label: name,
		description: "Says hello.",
		parameters: Type.Object({}),
		exposure,
		annotations: { readOnlyHint: true },
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			writeFileSync(join(ctx.cwd, `${name}.poked`), "poked\n");
			return { content: [{ type: "text", text: "hello" }], details: undefined };
		},
	};
}

export default function probeTools(pi: ExtensionAPI): void {
	pi.registerTool(poke("poke", "codemode"));
	pi.registerTool(poke("mcp__probe__poke", "codemode"));
	pi.on("session_start", () => {
		pi.registerTool(poke("mcp__probe__late", "deferred"));
	});
}
