import { describe, expect, it } from "vitest";
import help from "../ext/help/index.ts";

/** /help's text, with these extension commands registered. */
async function helpText(extensionCommands: string[]): Promise<string> {
	const renderers = new Map<string, (entry: unknown, options: unknown, theme: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	let entry: unknown;
	help({
		registerEntryRenderer: (type: string, render: never) => renderers.set(type, render),
		registerCommand: (name: string, options: { handler: never }) => commands.set(name, options.handler),
		appendEntry: (_type: string, data: unknown) => {
			entry = { data };
		},
		on: () => {},
		getCommands: () => extensionCommands.map((name) => ({ name, description: "", source: "extension" })),
	} as never);
	await commands.get("help")?.("", {});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const component = renderers.get("bluclawd:help")?.(entry, {}, theme) as { render(width: number): string[] };
	return component.render(120).join("\n");
}

describe("/help", () => {
	it("offers ← ← only while agent view is there", async () => {
		expect(await helpText(["agent-view", "rewind"])).toContain("← ←");
		expect(await helpText(["rewind"])).not.toContain("← ←");
	});

	it("names no other extension's shortcut, and points at /hotkeys for them all", async () => {
		const text = await helpText([]);
		expect(text).not.toContain("Alt+M");
		expect(text).toContain("/hotkeys");
	});
});

describe("/context", () => {
	const tool = (description: string) => ({ name: "ab", description, parameters: { type: "object" } });

	/** The `toolDefinitionChars` /context records, after the given requests. */
	async function recordedToolChars(requests: unknown[][]): Promise<unknown> {
		const handlers = new Map<string, (event: unknown) => void>();
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		let data: { toolDefinitionChars?: number } | undefined;
		help({
			registerEntryRenderer: () => {},
			registerCommand: (name: string, options: { handler: never }) => commands.set(name, options.handler),
			on: (event: string, handler: (event: unknown) => void) => handlers.set(event, handler),
			appendEntry: (_type: string, entry: typeof data) => {
				data = entry;
			},
			getAllTools: () => [tool("cde"), { ...tool("not declared"), name: "inactive" }],
			getActiveTools: () => ["ab"],
		} as never);
		for (const messages of requests) handlers.get("context_with_system")?.({ type: "context_with_system", messages });
		await commands.get("context")?.("", {
			model: { provider: "p", id: "m" },
			getContextUsage: () => ({ contextWindow: 1000, tokens: 100, percent: 10 }),
			getSystemPrompt: () => "",
		});
		return data?.toolDefinitionChars;
	}

	it("counts the tools the last request declared, with the descriptions the model got", async () => {
		const system = { role: "system", content: "", timestamp: 0, toolsAdded: [tool("cde, rewritten by its loadout")] };
		// "ab" + "cde, rewritten by its loadout" + '{"type":"object"}'
		expect(await recordedToolChars([[system, { role: "user", content: "hi", timestamp: 0 }]])).toBe(48);
	});

	it("counts the registered active tools before this process has sent a request", async () => {
		// "ab" + "cde" + '{"type":"object"}'; the inactive tool is left out
		expect(await recordedToolChars([])).toBe(22);
	});
});
