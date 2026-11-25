import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

it("gives each extension's copy of the module the theme one copy was given, pi's own Theme", async () => {
	initTheme("dark");
	const piTheme = (globalThis as Record<symbol, Theme>)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
	vi.resetModules();
	const setter = await import("../ext/_shared/theme.ts");
	vi.resetModules();
	const reader = await import("../ext/_shared/theme.ts");
	expect(reader).not.toBe(setter);

	setter.setSharedTheme(piTheme);

	const { fg } = reader.theme;
	expect(fg("accent", "x")).toBe(piTheme.fg("accent", "x"));
	expect(reader.theme.bold("x")).toBe(piTheme.bold("x"));
});
