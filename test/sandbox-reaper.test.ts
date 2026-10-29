import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reapDescendants } from "../ext/sandbox/reaper.ts";
import { beatsFromNow, descendantCommand, leavingBehind, readHeartbeats, readinessMs } from "./helpers/heartbeats.ts";

const lifetimeMs = 3000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform !== "darwin")("reapDescendants (macOS)", () => {
	let dir: string;
	let heartbeatPath: string;
	let agentDir: string;
	beforeAll(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "bluclawd-reaper-agent-"));
	});
	afterAll(() => rm(agentDir, { recursive: true, force: true }));
	beforeEach(async () => {
		// The helper is built into the agent directory.
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		dir = await realpath(await mkdtemp(join(tmpdir(), "bluclawd-reaper-")));
		heartbeatPath = join(dir, "heartbeat.jsonl");
	});
	afterEach(async () => {
		// Fixture descendants self-expire; wait them out rather than kill by persisted PID.
		if (existsSync(`${heartbeatPath}.identity`)) {
			const info = JSON.parse(readFileSync(`${heartbeatPath}.identity`, "utf8"));
			await delay(Math.max(0, info.expiresAt - Date.now()) + 100);
		}
		await rm(dir, { recursive: true, force: true });
	});

	const beats = () => readHeartbeats(heartbeatPath);

	async function run(mode: string, stop: "abort" | "exit") {
		const exec = reapDescendants(createLocalBashOperations({ shellPath: "/bin/bash" }).exec);
		const abort = new AbortController();
		// "exit" mode: the invoking shell returns once its descendant beats, leaving it behind.
		const command = descendantCommand(mode, heartbeatPath, "reaper-probe", lifetimeMs);
		const settled = exec(stop === "exit" ? leavingBehind(command, heartbeatPath) : command, dir, {
			onData: () => {},
			signal: abort.signal,
		}).catch(() => undefined);
		if (stop === "abort") {
			const deadline = Date.now() + readinessMs;
			while (!beats().some((beat) => mode !== "double-fork" || beat.ppid === 1)) {
				if (Date.now() > deadline) throw new Error("descendant never started");
				await delay(10);
			}
			abort.abort();
		}
		await settled;
		return beatsFromNow(heartbeatPath);
	}

	it.each(["detached", "double-fork"])(
		"kills a %s descendant when the command is stopped",
		async (mode) => {
			const result = await run(mode, "abort");
			expect(result.started).toBe(true);
			expect(result.stillWriting).toEqual([]);
		},
		60_000,
	);

	it("kills a detached descendant left behind when the command exits", async () => {
		const result = await run("detached", "exit");
		expect(result.started).toBe(true);
		expect(result.stillWriting).toEqual([]);
	}, 60_000);

	it("kills a double-fork descendant when the process running the command dies", async () => {
		const command = descendantCommand("double-fork", heartbeatPath, "reaper-probe", lifetimeMs);
		const script = [
			'import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";',
			`import { reapDescendants } from ${JSON.stringify(new URL("../ext/sandbox/reaper.ts", import.meta.url).href)};`,
			`await reapDescendants(createLocalBashOperations({ shellPath: "/bin/bash" }).exec)(${JSON.stringify(command)}, ${JSON.stringify(dir)}, { onData: () => {} });`,
		].join("\n");
		const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: "ignore",
		});
		const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
		const deadline = Date.now() + readinessMs;
		while (!beats().some((beat) => beat.ppid === 1)) {
			if (Date.now() > deadline) throw new Error("descendant never started");
			await delay(10);
		}
		// As when pi is killed: nothing runs its stop, and the helper sees the end of its stdin.
		owner.kill("SIGKILL");
		await exited;
		await delay(200);
		expect((await beatsFromNow(heartbeatPath)).stillWriting).toEqual([]);
	}, 60_000);
});
