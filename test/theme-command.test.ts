import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import branding from "../ext/branding/index.ts";
import { AUTO_THEME } from "../ext/branding/theme-picker.ts";

type Scheme = "dark" | "light";

/** pi with only what `/theme` touches, and a TUI that reports the terminal's light/dark switches. */
function load(saved: string | undefined) {
	const agent = join(mkdtempSync(join(tmpdir(), "bluclawd-theme-")), "agent");
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	if (saved !== undefined) {
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: saved }));
	}
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	branding({
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options.handler),
		on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
	} as never);

	const listeners = new Set<(scheme: Scheme) => void>();
	const tui = {
		notifications: false,
		onTerminalColorSchemeChange(listener: (scheme: Scheme) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setTerminalColorSchemeNotifications(enabled: boolean) {
			tui.notifications = enabled;
		},
		requestRender() {},
	};
	const shown: string[] = [];
	let pick: string | undefined;
	const themes = ["bluclawd", "bluclawd-light", "bluclawd-dark-daltonized", "dark", "light"];
	const ctx = {
		cwd: agent,
		hasUI: true,
		isProjectTrusted: () => false,
		ui: {
			getAllThemes: () => themes.map((name) => ({ name })),
			// pi's own record of the terminal's appearance stops updating once an extension shows a theme.
			getTheme: (name: string) =>
				name === "system" ? { name, appearance: "dark" } : themes.includes(name) ? { name } : undefined,
			setTheme: (theme: string | { name: string }) => {
				shown.push(typeof theme === "string" ? theme : theme.name);
				return { success: true };
			},
			custom: async (factory: (...args: unknown[]) => unknown) => {
				factory(tui, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, () => {});
				return pick;
			},
			notify: () => {},
		},
	};
	const theme = async (choice: string | undefined) => {
		pick = choice;
		await commands.get("theme")!("", ctx);
	};
	const report = (scheme: Scheme) => {
		for (const listener of listeners) listener(scheme);
	};
	const savedTheme = () => JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).theme;
	return { theme, report, shown, tui, listeners, handlers, savedTheme };
}

describe("/theme Auto (match terminal)", () => {
	beforeEach(() => vi.unstubAllEnvs());
	afterEach(() => vi.unstubAllEnvs());

	it("follows the terminal's light/dark switches once chosen, as Claude Code's does", async () => {
		const t = load("bluclawd");
		await t.theme(AUTO_THEME);
		expect(t.savedTheme()).toBe(AUTO_THEME);
		expect(t.tui.notifications).toBe(true);
		t.shown.length = 0;
		t.report("light");
		expect(t.shown).toEqual(["bluclawd-light"]);
		t.report("dark");
		expect(t.shown).toEqual(["bluclawd-light", "bluclawd"]);
	});

	it("keeps following when the picker is cancelled on Auto", async () => {
		const t = load(AUTO_THEME);
		await t.theme(undefined);
		t.shown.length = 0;
		t.report("light");
		expect(t.shown).toEqual(["bluclawd-light"]);
	});

	it("shows the theme for the terminal's last report when the picker is reopened", async () => {
		const t = load("bluclawd");
		await t.theme(AUTO_THEME);
		t.report("light");
		t.shown.length = 0;
		await t.theme(undefined);
		expect(t.shown).toEqual(["bluclawd-light"]);
	});

	it("stops following once another theme is chosen", async () => {
		const t = load("bluclawd");
		await t.theme(AUTO_THEME);
		await t.theme("bluclawd-dark-daltonized");
		expect(t.tui.notifications).toBe(false);
		expect(t.listeners.size).toBe(0);
		t.shown.length = 0;
		t.report("light");
		expect(t.shown).toEqual([]);
	});

	it("stops following when the session ends", async () => {
		const t = load("bluclawd");
		await t.theme(AUTO_THEME);
		t.handlers.get("session_shutdown")?.({}, {});
		expect(t.tui.notifications).toBe(false);
		expect(t.listeners.size).toBe(0);
	});
});
