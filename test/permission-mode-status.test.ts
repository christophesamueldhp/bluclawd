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
});
