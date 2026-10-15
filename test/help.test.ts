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
