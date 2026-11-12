import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HeldWakeups } from "../daemon/wakeups.ts";
import { WAKEUP_END_ENTRY, WAKEUP_ENTRY } from "../ext/background-bash/wakeups.ts";
import { conversation, DEFAULT_EXTENSIONS, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The wake-up entries in a session file: scheduled, and ended. */
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

/** Waits for the pane's pi to have saved its session as a stopped row: it has gone through its shutdown. */
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

	/** A pane whose session scheduled a wake-up ten minutes out; its session file. */
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

		// A hang-up nobody asked for: its tmux server's session killed from outside, as a closed terminal does.
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
		// It ended: the watch on the signal does not keep it running.
		await waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
	});

	it("cancels it when bluclawd ends its pi as a quit", async () => {
		const { real, pane, sessionFile } = await scheduled();

		real.tmux.end(pane);
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

	/** Where the daemon keeps what it holds: the test's own server dir. */
	const heldFile = () => {
		const dir = process.env.PI_SERVER_DIR;
		if (!dir) throw new Error("PI_SERVER_DIR is not set: startRealPi sets it.");
		return join(dir, "wakeups.json");
	};
	/** What the daemon holds, as it keeps it on disk. */
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

	/** A session whose pi a signal ended, with a wake-up ten minutes out that the daemon holds; its pane and file. */
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

	/** Ten minutes pass: in the session log, and in the daemon's copy on disk, the wake-up is overdue. */
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
		// A hand-off that lands after the Delete, as one sent just before it does.
		await real.client.holdWakeups(stale);
		await new Promise((resolve) => setTimeout(resolve, 3000));
		expect(real.requests("main")).toHaveLength(2);
		expect(held()).toEqual([]);

		real.start(["--session", sessionFile]);
		await waitFor(() => expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY, WAKEUP_END_ENTRY]));
		await new Promise((resolve) => setTimeout(resolve, 3000));
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

		// As agent view deletes a live row: its pi is killed, then the row goes.
		real.tmux.kill(pane);
		await real.client.delete(row.id);
		overdue(sessionFile);
		await new Promise((resolve) => setTimeout(resolve, 3000));
		expect(real.requests("main")).toHaveLength(2);
		expect(held()).toEqual([]);

		real.start(["--session", sessionFile]);
		await waitFor(() => expect(wakeupEntries(sessionFile)).toEqual([WAKEUP_ENTRY, WAKEUP_END_ENTRY]));
		await new Promise((resolve) => setTimeout(resolve, 3000));
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
		// Once: neither the daemon nor the reopened pi fires it again. A wait that proves nothing starts within it.
		await new Promise((resolve) => setTimeout(resolve, 3000));
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

		// The daemon is told of it as a hand-off: what it holds on disk is read only when it starts.
		await real.client.holdWakeups(held()[0]);
		const requests = await real.waitForRequests("main", 3);
		expect(conversation(requests[2]).at(-1)?.text).toContain("is late: it was due at");
		// Once: neither the daemon nor the reopened pi fires it again. A wait that proves nothing starts within it.
		await new Promise((resolve) => setTimeout(resolve, 3000));
		expect(real.requests("main")).toHaveLength(3);
		const row = (await real.rows()).find((r) => r.sessionFile === sessionFile);
		expect(row?.pane).toBeDefined();
		expect(row?.pane).not.toBe(pane);
		await waitFor(() => expect(held()).toEqual([]));
	});
});
