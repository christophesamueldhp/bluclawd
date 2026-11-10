import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe.skipIf(!hasTmux)("a pi that ends with a wake-up pending", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	/** A pane whose session scheduled a wake-up ten minutes out; its session file. */
	async function scheduled() {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "background-bash"] });
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

	/** Waits for the pane's pi to have saved its session as a stopped row: it has gone through its shutdown. */
	const stopped = (real: RealPi, sessionFile: string) =>
		waitFor(async () =>
			expect((await real.rows()).find((row) => row.sessionFile === sessionFile)?.status).toBe("stopped"),
		);

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

	/** What the daemon holds, as it keeps it on disk. */
	const held = () => {
		const file = join(process.env.PI_SERVER_DIR ?? "", "wakeups.json");
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Array<{ sessionFile: string }>) : [];
	};

	it("is handed a wake-up when it is scheduled, starting the daemon if it is not running", async () => {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "background-bash"] });
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
		await waitFor(async () =>
			expect((await real.rows()).find((row) => row.sessionFile === sessionFile)?.status).toBe("stopped"),
		);
		return { pane, sessionFile };
	}

	/** Ten minutes pass: in the session log, and in the daemon's copy on disk, the wake-up is overdue. */
	function overdue(sessionFile: string) {
		const at = Date.now() - 60_000;
		writeFileSync(sessionFile, readFileSync(sessionFile, "utf8").replace(/"dueAt":\d+/, `"dueAt":${at}`));
		const file = join(process.env.PI_SERVER_DIR ?? "", "wakeups.json");
		writeFileSync(file, readFileSync(file, "utf8").replace(/"dueAt": \d+/, `"dueAt": ${at}`));
		return at;
	}

	it("fires one that fell due while the daemon was down, once it is back", async () => {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "background-bash"] });
		pi = real;
		const { sessionFile } = await crashed(real);
		await real.client.shutdownDaemon();
		overdue(sessionFile);

		await real.client.ensureDaemon();
		const requests = await real.waitForRequests("main", 3);
		expect(conversation(requests[2]).at(-1)?.text).toContain("is late: it was due at");
	});

	it("reopens the session of a pi a signal ended once its wake-up falls due, and the turn starts there", async () => {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "background-bash"] });
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
		spawnSync("tmux", ["-S", real.tmux.socket, "kill-session", "-t", `=${pane}`]);
		await waitFor(async () =>
			expect((await real.rows()).find((row) => row.sessionFile === sessionFile)?.status).toBe("stopped"),
		);

		// Ten minutes pass: in its log and in the daemon's copy, it is now overdue.
		const overdue = Date.now() - 60_000;
		const log = readFileSync(sessionFile, "utf8").replace(/"dueAt":\d+/, `"dueAt":${overdue}`);
		writeFileSync(sessionFile, log);
		const [copy] = JSON.parse(readFileSync(join(process.env.PI_SERVER_DIR ?? "", "wakeups.json"), "utf8"));
		await real.client.holdWakeups({ ...copy, wakeups: [{ ...copy.wakeups[0], dueAt: overdue }] });

		const requests = await real.waitForRequests("main", 3);
		expect(conversation(requests[2]).at(-1)?.text).toContain("is late: it was due at");
		const row = (await real.rows()).find((r) => r.sessionFile === sessionFile);
		expect(row?.pane).toBeDefined();
		expect(row?.pane).not.toBe(pane);
		await waitFor(() => expect(held()).toEqual([]));
	});
});
