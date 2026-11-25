import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processAlive, processGroupAlive, processStarted } from "../daemon/processes.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import { sigkillIfAlive } from "./helpers/leaderless-group.ts";

const OUTLASTS_TEST_MS = 3 * readinessMs;
const FAILURE_BOUND_MS = 15_000;

const started: number[] = [];

afterEach(() => {
	for (const pid of started.splice(0)) {
		for (const target of [-pid, pid]) sigkillIfAlive(target);
	}
});

function probe(target: number): string | undefined {
	try {
		process.kill(target, 0);
		return undefined;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code;
	}
}

/**
 * Starts `script` in a shell that leads a process group of its own, under a parent that never reaps it. The parent is a node whose
 * event loop, where node reaps its children, stays blocked.
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
	// The kernel still has the group, so signal 0 to it does not fail as it does for no process.
	expect(probe(-pid)).not.toBe("ESRCH");
	return pid;
}

describe("probing a process by its pid", () => {
	it("takes another user's process for one that exists, and a pid no process has for none", () => {
		// pid 1 is the system's own. Signalling it is not permitted, which says it exists.
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
		const pid = await zombieLeader(`sleep ${Math.ceil(OUTLASTS_TEST_MS / 1000)} & exit 0`);
		expect(processAlive(pid)).toBe(false);
		expect(processGroupAlive(pid)).toBe(true);
	});

	it("takes a group for ended at once on a fresh look, though it ran a moment ago", async () => {
		const pid = await zombieLeader(`sleep ${Math.ceil(OUTLASTS_TEST_MS / 1000)} & exit 0`);
		expect(processGroupAlive(pid)).toBe(true);
		process.kill(-pid, "SIGKILL");
		await expect.poll(() => liveMembers(pid)).toEqual([]);
		expect(processGroupAlive(pid, { fresh: true })).toBe(false);
	});

	it("tells when a process started the same each time, and nothing once it has exited", async () => {
		const child = spawn(
			process.execPath,
			["-e", "const t = Date.now(); while (Date.now() - t < 300); setInterval(() => {}, 1 << 30)"],
			{ stdio: "ignore" },
		);
		const { pid } = child;
		if (pid === undefined) throw new Error("node did not start");
		started.push(pid);
		const start = processStarted(pid);
		expect(start).toMatch(/\S/);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(processStarted(pid)).toBe(start);
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGKILL");
		await exited;
		expect(processStarted(pid)).toBeUndefined();
	});
});

function liveMembers(pid: number): string[] {
	const listed = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" }).stdout;
	return listed.split("\n").flatMap((line) => {
		const [group, state] = line.trim().split(/\s+/);
		return Number(group) === pid && state && !state.startsWith("Z") ? [state] : [];
	});
}

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakePs(script: string): () => number {
	const dir = mkdtempSync(join(tmpdir(), "bc-ps-"));
	dirs.push(dir);
	const runs = join(dir, "runs");
	writeFileSync(join(dir, "ps"), `#!/bin/sh\necho >> '${runs}'\n${script}\n`, { mode: 0o755 });
	vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
	return () => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").length - 1 : 0);
}

function running(): number {
	const child = spawn("sleep", [String(Math.ceil(OUTLASTS_TEST_MS / 1000))], { detached: true, stdio: "ignore" });
	if (child.pid === undefined) throw new Error("sleep did not start");
	started.push(child.pid);
	return child.pid;
}

describe.skipIf(process.platform === "linux")("what probing a process costs, and what it trusts", () => {
	it("asks ps at most once a second about a process or group that keeps running", () => {
		const runs = fakePs('exec /bin/ps "$@"');
		const pid = running();
		for (let i = 0; i < 10; i++) {
			expect(processAlive(pid)).toBe(true);
			expect(processGroupAlive(pid)).toBe(true);
		}
		expect(runs()).toBeLessThanOrEqual(2);
	});

	it("takes a process for running when ps hangs, and waits for it only a moment", () => {
		fakePs("exec sleep 60");
		const pid = running();
		const start = Date.now();
		expect(processAlive(pid)).toBe(true);
		expect(Date.now() - start).toBeLessThan(FAILURE_BOUND_MS);
	});

	it("takes a process signal 0 reaches for running when ps does not list it", () => {
		fakePs("exit 1");
		expect(processAlive(running())).toBe(true);
	});

	it("tells no start of a process when ps fails", () => {
		fakePs("exit 1");
		expect(processStarted(running())).toBeUndefined();
	});

	it("asks ps for a process's start in one locale and zone", () => {
		fakePs('echo "$LC_ALL $TZ"');
		vi.stubEnv("LC_ALL", "id_ID.UTF-8");
		vi.stubEnv("TZ", "Asia/Jakarta");
		expect(processStarted(running())).toBe("C UTC");
	});
});
