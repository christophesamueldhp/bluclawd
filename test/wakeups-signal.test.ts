import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PANE_ENV } from "../daemon/tmux.ts";
import type { HeldWakeups } from "../daemon/wakeups.ts";
import { WAKEUP_END_ENTRY, WAKEUP_ENTRY } from "../ext/background-bash/wakeups.ts";
import { conversation, DEFAULT_EXTENSIONS, hasTmux, PI_CLI, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { nothingWithin } from "./helpers/run-timing.ts";
import { waitFor } from "./helpers/wait-for.ts";

function wakeupEntries(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; customType?: string })
		.filter((entry) => entry.type === "custom")
		.flatMap((entry) =>
			entry.customType === WAKEUP_ENTRY || entry.customType === WAKEUP_END_ENTRY ? [entry.customType] : [],
		);
}

const stopped = (real: RealPi, sessionFile: string) =>
	waitFor(async () =>
		expect((await real.rows()).find((row) => row.sessionFile === sessionFile)?.status).toBe("stopped"),
	);

describe.skipIf(!hasTmux)("a pi that ends with a wake-up pending", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	async function scheduled() {
		const real = await startRealPi({
			extensions: [...DEFAULT_EXTENSIONS, "background-bash"],
			defaultTools: ["+schedule_wakeup"],
		});
		pi = real;
		real.script("main", [
			{ tool: "schedule_wakeup", args: { prompt: "Check CI.", delay: 600 } },
			{ text: "scheduled" },
		]);
		const pane = real.start(["--", "watch CI"]);
		await real.waitForRequests("main", 2);
		const sessionFile = await waitFor(async () => {
			const file = (await real.rows()).find((row) => row.pane === pane)?.sessionFile;
			if (!file) throw new Error("Its row has no session file yet.");
			return file;
		});
		await waitFor(() => expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY]));
		return { real, pane, sessionFile };
	}

	it("keeps it pending when a signal ends its pi, as a crash does", async () => {
		const { real, pane, sessionFile } = await scheduled();

		spawnSync("tmux", ["-S", real.tmux.socket, "kill-session", "-t", `=${pane}`]);
		await stopped(real, sessionFile);
		expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY]);
	});

	it("keeps it pending when its pi is sent SIGTERM, as a plain kill or a logout does", async () => {
		const { real, pane, sessionFile } = await scheduled();
		const pid = Number(
			spawnSync("tmux", ["-S", real.tmux.socket, "display-message", "-p", "-t", `=${pane}:`, "#{pane_pid}"], {
				encoding: "utf8",
			}).stdout.trim(),
		);

		process.kill(pid, "SIGTERM");
		await stopped(real, sessionFile);
		expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY]);
		await waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
	});

	it("keeps it pending when SIGTERM ends a pi in print mode, as it does in the TUI", async () => {
		const real = await startRealPi({
			extensions: [...DEFAULT_EXTENSIONS, "background-bash"],
			defaultTools: ["+schedule_wakeup"],
		});
		pi = real;
		real.script("main", [
			{ tool: "schedule_wakeup", args: { prompt: "Check CI.", delay: 600 } },
			{ text: "scheduled", stallMs: 60_000 },
		]);
		const { [PANE_ENV]: _pane, TMUX: _tmux, TMUX_PANE: _tmuxPane, ...env } = process.env;
		const print = spawn(process.execPath, [PI_CLI, "--model", "faux/faux-1", "-p", "watch CI"], {
			cwd: real.cwd,
			env,
			stdio: "ignore",
		});
		const exited = new Promise((resolve) => print.once("exit", resolve));
		try {
			await real.waitForRequests("main", 2);
			const sessions = join(real.agentDir, "sessions");
			const sessionFile = await waitFor(() => {
				const file = readdirSync(sessions, { recursive: true, encoding: "utf8" }).find((f) => f.endsWith(".jsonl"));
				if (!file) throw new Error("The print-mode pi has no session file yet.");
				return join(sessions, file);
			});
			await waitFor(() => expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY]));

			print.kill("SIGTERM");
			await exited;
			expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY]);
		} finally {
			print.kill("SIGKILL");
		}
	});

	it("cancels it when bluclawd ends its pi as a quit", async () => {
		const { real, pane, sessionFile } = await scheduled();

		real.tmux.hangUpAsQuit(pane);
		await waitFor(() => expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY, WAKEUP_END_ENTRY]));
	});

	it("cancels it when the user quits", async () => {
		const { real, pane, sessionFile } = await scheduled();

		real.tmux.sendKeys(pane, ["/quit", "Enter"]);
		await waitFor(() => expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY, WAKEUP_END_ENTRY]));
	});
});

describe.skipIf(!hasTmux)("the daemon's hold on a session's wake-ups", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	const heldFile = () => {
		const dir = process.env.PI_SERVER_DIR;
		if (!dir) throw new Error("PI_SERVER_DIR is not set: startRealPi sets it.");
		return join(dir, "wakeups.json");
	};
	const held = (): HeldWakeups[] =>
		existsSync(heldFile()) ? (JSON.parse(readFileSync(heldFile(), "utf8")) as HeldWakeups[]) : [];

	it("is handed a wake-up when it is scheduled, starting the daemon if it is not running", async () => {
		const real = await startRealPi({
			extensions: [...DEFAULT_EXTENSIONS, "background-bash"],
			defaultTools: ["+schedule_wakeup"],
		});
		pi = real;
		await real.client.shutdownDaemon();
		real.script("main", [
			{ tool: "schedule_wakeup", args: { prompt: "Check CI.", delay: 600 } },
			{ text: "scheduled" },
		]);
		real.start(["--", "watch CI"]);
		await real.waitForRequests("main", 2);

		await waitFor(async () => expect(await real.client.isRunning()).toBe(true));
		await waitFor(() => expect(held()).toHaveLength(1));
	});

	async function crashed(real: RealPi) {
		real.script("main", [
			{ tool: "schedule_wakeup", args: { prompt: "Check CI.", delay: 600 } },
			{ text: "scheduled" },
			{ text: "CI is green" },
		]);
		const pane = real.start(["--", "watch CI"]);
		await real.waitForRequests("main", 2);
		await waitFor(() => expect(held()).toHaveLength(1));
		const [{ sessionFile }] = held();
		spawnSync("tmux", ["-S", real.tmux.socket, "kill-session", "-t", `=${pane}`]);
		await stopped(real, sessionFile);
		return { pane, sessionFile };
	}

	function overdue(sessionFile: string) {
		const at = Date.now() - 60_000;
		writeFileSync(sessionFile, readFileSync(sessionFile, "utf8").replace(/"dueAt":\d+/, `"dueAt":${at}`));
		writeFileSync(heldFile(), readFileSync(heldFile(), "utf8").replace(/"dueAt": \d+/, `"dueAt": ${at}`));
		return at;
	}

	it("cancels a crashed session's wake-up when its row is deleted: the daemon reopens nothing, and a /resume revives none", async () => {
		const real = await startRealPi({
			extensions: [...DEFAULT_EXTENSIONS, "background-bash"],
			defaultTools: ["+schedule_wakeup"],
		});
		pi = real;
		const { sessionFile } = await crashed(real);
		overdue(sessionFile);
		const [stale] = held();
		const row = (await real.rows()).find((r) => r.sessionFile === sessionFile);
		if (!row) throw new Error("The crashed session has no row.");

		await real.client.delete(row.id);
		await real.client.holdWakeups(stale);
		await nothingWithin(3000);
		expect(real.requests("main")).toHaveLength(2);
		expect(held()).toEqual([]);

		real.start(["--session", sessionFile]);
		await waitFor(() => expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY, WAKEUP_END_ENTRY]));
		await nothingWithin(3000);
		expect(real.requests("main")).toHaveLength(2);
	});

	it("cancels a live session's wake-up when its row is deleted, though its killed pi recorded nothing", async () => {
		const real = await startRealPi({
			extensions: [...DEFAULT_EXTENSIONS, "background-bash"],
			defaultTools: ["+schedule_wakeup"],
		});
		pi = real;
		real.script("main", [
			{ tool: "schedule_wakeup", args: { prompt: "Check CI.", delay: 600 } },
			{ text: "scheduled" },
			{ text: "CI is green" },
		]);
		const pane = real.start(["--", "watch CI"]);
		await real.waitForRequests("main", 2);
		await waitFor(() => expect(held()).toHaveLength(1));
		const [{ sessionFile }] = held();
		const row = (await real.rows()).find((r) => r.sessionFile === sessionFile);
		if (!row) throw new Error("The session has no row.");

		real.tmux.killWithoutSave(pane);
		await real.client.delete(row.id);
		overdue(sessionFile);
		await nothingWithin(3000);
		expect(real.requests("main")).toHaveLength(2);
		expect(held()).toEqual([]);

		real.start(["--session", sessionFile]);
		await waitFor(() => expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY, WAKEUP_END_ENTRY]));
		await nothingWithin(3000);
		expect(real.requests("main")).toHaveLength(2);
	});

	it("fires one that fell due while the daemon was down, once it is back", async () => {
		const real = await startRealPi({
			extensions: [...DEFAULT_EXTENSIONS, "background-bash"],
			defaultTools: ["+schedule_wakeup"],
		});
		pi = real;
		const { sessionFile } = await crashed(real);
		await real.client.shutdownDaemon();
		overdue(sessionFile);

		await real.client.ensureDaemon();
		const requests = await real.waitForRequests("main", 3);
		expect(conversation(requests[2]).at(-1)?.text).toContain("is late: it was due at");
		await nothingWithin(3000);
		expect(real.requests("main")).toHaveLength(3);
	});

	it("reopens the session of a pi a signal ended once its wake-up falls due, and the turn starts there", async () => {
		const real = await startRealPi({
			extensions: [...DEFAULT_EXTENSIONS, "background-bash"],
			defaultTools: ["+schedule_wakeup"],
		});
		pi = real;
		const { pane, sessionFile } = await crashed(real);
		overdue(sessionFile);

		await real.client.holdWakeups(held()[0]);
		const requests = await real.waitForRequests("main", 3);
		expect(conversation(requests[2]).at(-1)?.text).toContain("is late: it was due at");
		await nothingWithin(3000);
		expect(real.requests("main")).toHaveLength(3);
		const row = (await real.rows()).find((r) => r.sessionFile === sessionFile);
		expect(row?.pane).toBeDefined();
		expect(row?.pane).not.toBe(pane);
		await waitFor(() => expect(held()).toEqual([]));
	});
});
