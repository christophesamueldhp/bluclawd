import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { modeStatusText } from "../ext/permissions/index.ts";

const ctx = {
	ui: { theme: { fg: (_color: string, text: string) => text, getColorMode: () => "256color" } },
} as unknown as ExtensionContext;

describe("permission mode status", () => {
	it("names the key that cycles the mode after every badge", () => {
		expect(modeStatusText(ctx, "auto")).toBe("⏵⏵ auto mode on (alt+m to cycle)");
		expect(modeStatusText(ctx, "edits")).toBe("⏵⏵ edits mode on (alt+m to cycle)");
		expect(modeStatusText(ctx, "ask")).toBe("⏸ ask mode on (alt+m to cycle)");
	});

	it("paints auto and edits in Claude Code's own colours on a truecolor terminal", () => {
		const truecolor = {
			ui: { theme: { fg: (_color: string, text: string) => text, getColorMode: () => "truecolor" } },
		} as unknown as ExtensionContext;
		expect(modeStatusText(truecolor, "auto")).toBe("\x1b[38;2;255;193;7m⏵⏵ auto mode on\x1b[39m (alt+m to cycle)");
		expect(modeStatusText(truecolor, "edits")).toBe(
			"\x1b[38;2;175;135;255m⏵⏵ edits mode on\x1b[39m (alt+m to cycle)",
		);
	});
});
