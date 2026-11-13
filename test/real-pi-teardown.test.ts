import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
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

/** A node process running `script` with `args`, in `env` only. */
function node(script: string, args: string[] = [], env: Record<string, string> = {}): ChildProcess {
	const child = spawn(process.execPath, ["-e", script, ...args], {
		stdio: "ignore",
		env: { PATH: process.env.PATH ?? "", ...env },
	});
	started.push(child);
	return child;
}

/** What still runs with `dir` in its command line or environment, as `ps` lists it. */
function naming(dir: string): number[] {
	const options = { encoding: "utf8", env: { PATH: process.env.PATH }, maxBuffer: Number.POSITIVE_INFINITY } as const;
	return spawnSync("ps", ["axeww", "-o", "pid=,command="], options)
		.stdout.split("\n")
		.filter((line) => line.includes(basename(dir)))
		.map((line) => Number.parseInt(line, 10))
		.filter((pid) => pid !== process.pid);
}

describe("a real-pi test's sweep of its leftovers", () => {
	it("ends a process that names its dir only in its environment and ignores SIGTERM, as a private daemon does", async () => {
		const base = realDir();
		const { pid } = node(IGNORES_TERM, [], { PI_SERVER_DIR: join(base, "s") });
		await waitFor(() => expect(naming(base)).toContain(pid));

		await endLeftovers(base);
		await waitFor(() => expect(alive(pid as number)).toBe(false));
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
		const { pid } = node(spawner, [pids]);
		await waitFor(() => existsSync(pids));

		await endLeftovers(base);
		const children = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
		await waitFor(() => expect([pid as number, ...children].filter(alive)).toEqual([]));
	});

	it("ends a process whose title hides its command line and environment, by its group, as a run's pi", async () => {
		const base = realDir();
		const pidFile = join(base, "titled.pid");
		// A detached host leads its group, as a run's host does; its child takes a title, as pi does (`pi-rpc`).
		const titled = `process.title = 'pi-rpc'; ${IGNORES_TERM} require('node:fs').writeFileSync(process.argv[1], String(process.pid));`;
		const host = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(titled)}, process.argv[1]], { stdio: 'ignore', env: { PATH: process.env.PATH } }); ${IGNORES_TERM}`;
		const leader = spawn(process.execPath, ["-e", host, pidFile], { detached: true, stdio: "ignore" });
		started.push(leader);
		await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
		const child = Number(readFileSync(pidFile, "utf8"));
		expect(naming(base)).not.toContain(child);

		await endLeftovers(base);
		await waitFor(() => expect([leader.pid as number, child].filter(alive)).toEqual([]));
	});

	it("finds them in a listing of several MB, as every process's environment makes it on a loaded machine", async () => {
		const base = realDir();
		for (let i = 0; i < 6; i++) node(IGNORES_TERM, [], { PAD: "x".repeat(800_000) });
		const { pid } = node(IGNORES_TERM, [join(base, "x")]);
		await waitFor(() => expect(naming(base)).toContain(pid));

		await endLeftovers(base);
		await waitFor(() => expect(alive(pid as number)).toBe(false));
	});

	it("leaves a process of another test's dir running", async () => {
		const [base, other] = [realDir(), realDir()];
		const ours = node(IGNORES_TERM, [join(base, "x")]);
		const theirs = node(IGNORES_TERM, [join(other, "x")]);
		await waitFor(() => expect([naming(base), naming(other)]).toEqual([[ours.pid], [theirs.pid]]));

		await endLeftovers(base);
		await waitFor(() => expect(alive(ours.pid as number)).toBe(false));
		expect(alive(theirs.pid as number)).toBe(true);
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
			daemons = naming(dirname(process.env.PI_SERVER_DIR as string));
			throw new Error("the setup failed once its daemon ran");
		});

		await expect(startRealPi()).rejects.toThrow("the setup failed once its daemon ran");
		expect(daemons).not.toEqual([]);
		await waitFor(() => expect(daemons.filter(alive)).toEqual([]));
		expect(existsSync(dirname(process.env.PI_SERVER_DIR as string))).toBe(false);
	});
});
