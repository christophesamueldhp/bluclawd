import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
/** Local deterministic provider. Installed ONLY in temporary test-agent settings. */
export default function persistentViewProvider(pi: ExtensionAPI) {
	const root = process.env.VIEW_GATE_DIR;
	if (!root) throw new Error("VIEW_GATE_DIR required for isolated fixture");
	mkdirSync(root, { recursive: true });
	const faux = fauxProvider({
		provider: "bluclawd-view-test",
		models: [{ id: "view-test", name: "Persistent view fixture", input: ["text", "image"] }],
		tokensPerSecond: 1000,
	});
	pi.registerProvider(faux.provider);
	pi.on("before_agent_start", () => {
		faux.setResponses([
			(context) =>
				context.messages.some((message) => message.role === "toolResult" && message.toolName === "view_test_gate")
					? fauxAssistantMessage("Fixture completed after gate")
					: fauxAssistantMessage(
							[
								"Earlier partial before gate",
								fauxToolCall(
									"view_test_gate",
									{ question: process.env.VIEW_TEST_DIALOG === "1" },
									{ id: "view-gate" },
								),
							].map((block) => (typeof block === "string" ? { type: "text" as const, text: block } : block)),
							{ stopReason: "toolUse" },
						),
			fauxAssistantMessage("Fixture completed after gate"),
		]);
	});
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(
			join(root, `resources-${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				mode: ctx.mode,
				tools: pi.getAllTools().map((tool) => tool.name),
				commands: pi.getCommands().map((command) => command.name),
			}),
		);
	});
	pi.registerTool({
		name: "view_test_gate",
		label: "View test gate",
		description: "Wait for the isolated test release file",
		parameters: Type.Object({ question: Type.Optional(Type.Boolean()) }),
		execute: async (_id, params, signal, onUpdate, ctx) => {
			const countFile = join(root, `count-${process.pid}.json`);
			const count = existsSync(countFile) ? JSON.parse(readFileSync(countFile, "utf8")).count + 1 : 1;
			writeFileSync(countFile, JSON.stringify({ pid: process.pid, count }));
			onUpdate?.({
				content: [{ type: "text", text: "Earlier tool output before release" }],
				details: { pid: process.pid, count },
			});
			if (params.question) await ctx.ui.editor("Pending editor fixture", "unsent editor draft");
			const deadline = Date.now() + 30_000;
			while (!existsSync(join(root, `release-${process.pid}`))) {
				if (signal?.aborted) throw new Error("Fixture gate explicitly aborted");
				if (Date.now() > deadline) throw new Error("Fixture gate deadline exceeded");
				await delay(20, undefined, { signal });
			}
			if (process.env.VIEW_EDITOR === "1") await ctx.ui.editor("PTY pending editor", "Earlier editor draft");
			return { content: [{ type: "text", text: "gate complete" }], details: { pid: process.pid, count } };
		},
	});
}
