import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { processAlive, processGroupAlive } from "../daemon/processes.ts";
import { readinessMs } from "./helpers/heartbeats.ts";

/** Processes the tests started, each ended afterwards with the process group it leads, if any. */
const started: number[] = [];

afterEach(() => {
	for (const pid of started.splice(0)) {
		for (const target of [-pid, pid]) {
			try {
				process.kill(target, "SIGKILL");
			} catch {
				// gone already
			}
		}
	}
});

/** The error code signal 0 to `target` fails with, if it fails. */
function probe(target: number): string | undefined {
	try {
		process.kill(target, 0);
		return undefined;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code;
	}
}

/**
 * Starts `script` in a shell that leads a process group of its own, under a parent that never reaps it: a node whose
 * event loop, where node reaps its children, stays blocked. Returns the shell's pid once it is a zombie.
 */
async function zombieLeader(script: string): Promise<number> {
	const parent = spawn(
		process.execPath,
		[
			"-e",
			`const c = require('node:child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(script)}], { detached: true, stdio: 'ignore' });
			require('node:fs').writeSync(1, c.pid + '\\n');
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	if (parent.pid === undefined) throw new Error("the parent did not start");
	started.push(parent.pid);
	const pid = await new Promise<number>((resolve) =>
		parent.stdout.once("data", (data) => resolve(Number(String(data)))),
	);
	started.push(pid);
	await expect
		.poll(() => spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim())
		.toMatch(/^Z/);
	// The kernel still has the group: signal 0 to it does not fail as it does for no process.
	expect(probe(-pid)).not.toBe("ESRCH");
	return pid;
}

describe("probing a process by its pid", () => {
	it("takes another user's process for one that exists, and a pid no process has for none", () => {
		// pid 1 is the system's own: signalling it is not permitted, which says it exists.
		expect(processAlive(1)).toBe(true);
		expect(processAlive(process.pid)).toBe(true);
		expect(processAlive(2 ** 22 + 7)).toBe(false);
		expect(processGroupAlive(2 ** 22 + 7)).toBe(false);
	});

	it("takes a process that exited but is not reaped, and a group of only such, for ended", async () => {
		const pid = await zombieLeader("exit 0");
		expect(processAlive(pid)).toBe(false);
		expect(processGroupAlive(pid)).toBe(false);
	});

	it("takes a group whose leader is unreaped but another member runs for one that still runs", async () => {
		// The member outlasts the test, whose timeout is 2 x readinessMs.
		const pid = await zombieLeader(`sleep ${Math.ceil((3 * readinessMs) / 1000)} & exit 0`);
		expect(processAlive(pid)).toBe(false);
		expect(processGroupAlive(pid)).toBe(true);
	});
});
