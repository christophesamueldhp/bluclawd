import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePermissionMode } from "../ext/permissions/active-mode.ts";
import { runHostCommand } from "../ext/subagents/host-command.ts";

describe("runHostCommand", () => {
	let home: string;
	let cwd: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-host-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-host-cwd-"));
		saved = { HOME: process.env.HOME };
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(join(getAgentDir(), "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm **)"] } }));
		setActivePermissionMode("auto");
	});
	afterEach(() => {
		setActivePermissionMode("ask");
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	const opts = (over = {}) => ({ ctx: { cwd, isProjectTrusted: () => true }, cwd, asker: "Gate", ...over });

	it("runs an allowed command in the child's cwd and reports its output", async () => {
		const r = await runHostCommand("pwd && echo passed", opts());
		expect(r.outcome).toBe("passed");
		expect(r.output).toContain("passed");
	});

	it("reports a non-zero exit as failed, with the output", async () => {
		const r = await runHostCommand("echo broken; exit 3", opts());
		expect(r.outcome).toBe("failed");
		expect(r.output).toMatch(/broken[\s\S]*code 3/);
	});

	it("is blocked by the parent's deny rules", async () => {
		const r = await runHostCommand("rm -rf build", opts());
		expect(r.outcome).toBe("blocked");
	});

	it("in ask mode, asks through the bridge — and is blocked when there is nobody to ask", async () => {
		setActivePermissionMode("ask");
		expect((await runHostCommand("npm test", opts())).outcome).toBe("blocked");
		const asked: string[] = [];
		const prompt = async (r: { title: string }) => {
			asked.push(r.title);
			return true;
		};
		expect((await runHostCommand("touch made", opts({ prompt }))).outcome).toBe("passed");
		expect(asked).toEqual(["Gate"]);
	});
});
