import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WAKEUP_END_ENTRY, WAKEUP_ENTRY } from "../ext/background-bash/wakeups.ts";
import { DEFAULT_EXTENSIONS, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
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
