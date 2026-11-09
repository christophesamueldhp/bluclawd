/**
 * Settings read once per session_start, shared by every extension's handler for it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startupSettings } from "../ext/_shared/startup-settings.ts";

describe("startupSettings", () => {
	let home: string;
	let dir: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-startup-settings-home-"));
		dir = mkdtempSync(join(tmpdir(), "bluclawd-startup-settings-cwd-"));
		saved.HOME = process.env.HOME;
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
		mkdirSync(getAgentDir(), { recursive: true });
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	});

	const writeGlobal = (content: string) => writeFileSync(join(getAgentDir(), "settings.json"), content);
	const ctx = (trusted = true) => ({ cwd: dir, isProjectTrusted: () => trusted });

	it("reads once per session_start, for every extension's copy of the module", async () => {
		const path = new URL("../ext/_shared/startup-settings.ts", import.meta.url).pathname;
		const copy = (await import(`${path}?copy=other`)) as typeof import("../ext/_shared/startup-settings.ts");
		expect(copy.startupSettings).not.toBe(startupSettings);

		const event = { type: "session_start", reason: "startup" };
		writeGlobal(JSON.stringify({ shellPath: "/bin/first" }));
		expect(startupSettings(event, ctx()).settings.getShellPath()).toBe("/bin/first");
		writeGlobal(JSON.stringify({ shellPath: "/bin/second" }));
		expect(copy.startupSettings(event, ctx()).settings.getShellPath()).toBe("/bin/first");

		// The next session_start (a /reload, /new, /resume) reads again.
		const next = { type: "session_start", reason: "reload" };
		expect(startupSettings(next, ctx()).settings.getShellPath()).toBe("/bin/second");
	});
});
