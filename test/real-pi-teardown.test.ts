import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import { endLeftovers, hasTmux, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

// Outlives the test, so only the sweep ends a fixture; bounded, so a failing run leaves nothing for good.
const LIFETIME_MS = 3 * readinessMs;
const IGNORES_TERM = `process.on('SIGTERM', () => {}); setTimeout(() => {}, ${LIFETIME_MS});`;

/** Whether `pid` still runs: a zombie has ended, though nothing reaped it (a container's `sleep` as pid 1 never does). */
const alive = (pid: number) => {
	const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
	return stat !== "" && !stat.startsWith("Z");
};

const dirs: string[] = [];
const started: ChildProcess[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const child of started.splice(0)) child.kill("SIGKILL");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const realDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "bc-real-"));
	dirs.push(dir);
	return dir;
};

/** A node process with `args`; returns its pid. */
function start(args: string[], options: SpawnOptions = {}): number {
	const child = spawn(process.execPath, args, { stdio: "ignore", ...options });
	started.push(child);
	if (child.pid === undefined) throw new Error(`node ${args.join(" ")} did not start`);
	return child.pid;
}

/** A node process running `script` with `args`, in `env` only; returns its pid. */
const node = (script: string, args: string[] = [], env: Record<string, string> = {}) =>
	start(["-e", script, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });

/** What still runs with `dir` in its command line or environment, as `ps` lists it. */
function naming(dir: string): number[] {
	const options = { encoding: "utf8", env: { PATH: process.env.PATH }, maxBuffer: 256 * 1024 * 1024 } as const;
	return spawnSync("ps", ["axeww", "-o", "pid=,command="], options)
		.stdout.split("\n")
		.filter((line) => line.includes(basename(dir)))
		.map((line) => Number.parseInt(line, 10))
		.filter((pid) => pid !== process.pid);
}

/** The pid `file` holds, once it holds one. */
const pidIn = (file: string) =>
	waitFor(() => {
		expect(existsSync(file) && readFileSync(file, "utf8")).toMatch(/^\d+$/);
		return Number(readFileSync(file, "utf8"));
	});

/**
 * A run's host and pi under `dir`, as the daemon starts them: a detached host, which leads its group and names `dir`,
 * and its child, which names nothing once it has taken a title, as pi does (`pi-rpc`).
 */
async function runHost(dir: string): Promise<{ host: number; pi: number }> {
	const pidFile = join(dir, "pi.pid");
	const pi = `process.title = 'pi-rpc'; ${IGNORES_TERM} require('node:fs').writeFileSync(process.argv[1], String(process.pid));`;
	const host = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(pi)}, process.argv[1]], { stdio: 'ignore', env: { PATH: process.env.PATH } }); ${IGNORES_TERM}`;
	return { host: start(["-e", host, pidFile], { detached: true }), pi: await pidIn(pidFile) };
}

/** The test dir a startRealPi stubbed in this process's environment. */
function stubbedBase(): string {
	const serverDir = process.env.PI_SERVER_DIR;
	if (!serverDir) throw new Error("no PI_SERVER_DIR is stubbed");
	return dirname(serverDir);
}

describe("a real-pi test's sweep of its leftovers", () => {
	it("ends a process that names its dir only in its environment and ignores SIGTERM, as a private daemon does", async () => {
		const base = realDir();
		const pid = node(IGNORES_TERM, [], { PI_SERVER_DIR: join(base, "s") });
		await waitFor(() => expect(naming(base)).toContain(pid));

		await endLeftovers(base);
		await waitFor(() => expect(alive(pid)).toBe(false));
	});

	it("ends what a process started after the sweep first listed them, as a run's host starts its pi", async () => {
		const base = realDir();
		const pids = join(base, "children.pids");
		// One child every few ms, each on its own once the spawner is gone, as a pi and its lingerer outlive their host.
		const spawner = `
			const { spawn } = require("node:child_process");
			const { appendFileSync } = require("node:fs");
			const [pids] = process.argv.slice(1);
			let left = 100;
			const timer = setInterval(() => {
				const child = spawn("/bin/sh", ["-c", "trap '' TERM; i=0; while [ $i -lt ${Math.ceil(LIFETIME_MS / 1000)} ]; do sleep 1; i=$((i+1)); done", pids], { detached: true, stdio: "ignore" });
				child.unref();
				appendFileSync(pids, child.pid + "\\n");
				if (--left === 0) clearInterval(timer);
			}, 5);`;
		const pid = node(spawner, [pids]);
		await waitFor(() => existsSync(pids));

		await endLeftovers(base);
		const children = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
		await waitFor(() => expect([pid, ...children].filter(alive)).toEqual([]));
	});

	it("ends a process whose title hides its command line and environment, by its group, as a run's pi", async () => {
		const base = realDir();
		const { host, pi } = await runHost(base);
		expect(naming(base)).not.toContain(pi);

		await endLeftovers(base);
		await waitFor(() => expect([host, pi].filter(alive)).toEqual([]));
	});

	it("leaves the leader of a group it did not start, when only a member of that group names its dir", async () => {
		const base = realDir();
		// Builds the dir's path itself, so only its child names it: as a shell running one of the test's processes.
		const leader = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(IGNORES_TERM)}, require('node:path').join(process.argv[1], 'bc-real-' + process.argv[2])], { stdio: 'ignore' }); ${IGNORES_TERM}`;
		const shell = start(["-e", leader, dirname(base), basename(base).replace("bc-real-", "")], {
			detached: true,
			env: { PATH: process.env.PATH ?? "" },
		});
		const [job] = await waitFor(() => {
			const named = naming(base);
			expect(named).toHaveLength(1);
			return named;
		});

		await endLeftovers(base);
		await waitFor(() => expect(alive(job)).toBe(false));
		expect(alive(shell)).toBe(true);
	});

	it("finds them in a listing of several MB, as every process's environment makes it on a loaded machine", async () => {
		const base = realDir();
		// 700 KB each, in strings of 100 KB: Linux refuses a single one over 128 KB.
		const padding = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`PAD${i}`, "x".repeat(100_000)]));
		for (let i = 0; i < 6; i++) node(IGNORES_TERM, [], padding);
		const pid = node(IGNORES_TERM, [join(base, "x")]);
		await waitFor(() => expect(naming(base)).toContain(pid));

		await endLeftovers(base);
		await waitFor(() => expect(alive(pid)).toBe(false));
	});

	it("leaves another test's run hosts and their groups running", async () => {
		const [base, other] = [realDir(), realDir()];
		const ours = await runHost(base);
		const theirs = await runHost(other);

		await endLeftovers(base);
		await waitFor(() => expect([ours.host, ours.pi].filter(alive)).toEqual([]));
		expect([theirs.host, theirs.pi].filter(alive)).toEqual([theirs.host, theirs.pi]);
		await endLeftovers(other);
		await waitFor(() => expect([theirs.host, theirs.pi].filter(alive)).toEqual([]));
	});
});

describe.skipIf(!hasTmux)("a real pi that fails to start", () => {
	it("leaves no daemon and no dir once its daemon had started", async () => {
		const ensureDaemon = OrchestratorClient.prototype.ensureDaemon;
		let daemons: number[] = [];
		vi.spyOn(OrchestratorClient.prototype, "ensureDaemon").mockImplementation(async function (
			this: OrchestratorClient,
		) {
			await ensureDaemon.call(this);
			await waitFor(async () => expect(await this.isRunning()).toBe(true));
			daemons = naming(stubbedBase());
			throw new Error("the setup failed once its daemon ran");
		});

		await expect(startRealPi()).rejects.toThrow("the setup failed once its daemon ran");
		expect(daemons).not.toEqual([]);
		await waitFor(() => expect(daemons.filter(alive)).toEqual([]));
		expect(existsSync(stubbedBase())).toBe(false);
	});
});
