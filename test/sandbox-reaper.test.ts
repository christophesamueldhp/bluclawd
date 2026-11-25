import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reapDescendantsOfSimpleCommand } from "../ext/sandbox/reaper.ts";
import { beatsFromNow, descendantCommand, leavingBehind, readHeartbeats, readinessMs } from "./helpers/heartbeats.ts";
import { awaitFixtureExpiry } from "./helpers/run-timing.ts";

const lifetimeMs = 3000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform !== "darwin")("reaper (macOS)", { timeout: 2 * readinessMs }, () => {
	let dir: string;
	let heartbeatPath: string;
	let agentDir: string;
	beforeAll(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "bluclawd-reaper-agent-"));
	});
	afterAll(() => rm(agentDir, { recursive: true, force: true }));
	beforeEach(async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		dir = await realpath(await mkdtemp(join(tmpdir(), "bluclawd-reaper-")));
		heartbeatPath = join(dir, "heartbeat.jsonl");
	});
	afterEach(async () => {
		await awaitFixtureExpiry(heartbeatPath);
		await rm(dir, { recursive: true, force: true });
	});

	const beats = () => readHeartbeats(heartbeatPath);

	async function run(mode: string, stop: "abort" | "exit") {
		const exec = reapDescendantsOfSimpleCommand(createLocalBashOperations({ shellPath: "/bin/bash" }).exec);
		const abort = new AbortController();
		const command = descendantCommand(mode, heartbeatPath, "reaper-probe", lifetimeMs);
		const settled = exec(stop === "exit" ? leavingBehind(command, heartbeatPath) : command, dir, {
			onData: () => {},
			signal: abort.signal,
		}).catch(() => undefined);
		if (stop === "abort") {
			const deadline = Date.now() + readinessMs;
			while (!beats().some((beat) => mode !== "double-fork" || beat.ppid === 1)) {
				if (Date.now() > deadline) throw new Error(`descendant never started within ${readinessMs}ms`);
				await delay(10);
			}
			abort.abort();
		}
		await settled;
		return beatsFromNow(heartbeatPath);
	}

	it.each(["detached", "double-fork"])("kills a %s descendant when the command is stopped", async (mode) => {
		const result = await run(mode, "abort");
		expect(result.started).toBe(true);
		expect(result.stillWriting).toEqual([]);
	});

	it("kills a detached descendant left behind when the command exits", async () => {
		const result = await run("detached", "exit");
		expect(result.started).toBe(true);
		expect(result.stillWriting).toEqual([]);
	});

	it("kills a double-fork descendant when the process running the command dies", async () => {
		const command = descendantCommand("double-fork", heartbeatPath, "reaper-probe", lifetimeMs);
		const script = [
			'import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";',
			`import { reapDescendantsOfSimpleCommand } from ${JSON.stringify(new URL("../ext/sandbox/reaper.ts", import.meta.url).href)};`,
			`await reapDescendantsOfSimpleCommand(createLocalBashOperations({ shellPath: "/bin/bash" }).exec)(${JSON.stringify(command)}, ${JSON.stringify(dir)}, { onData: () => {} });`,
		].join("\n");
		const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: "ignore",
		});
		const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
		const deadline = Date.now() + readinessMs;
		while (!beats().some((beat) => beat.ppid === 1)) {
			if (Date.now() > deadline) throw new Error(`descendant never started within ${readinessMs}ms`);
			await delay(10);
		}
		owner.kill("SIGKILL");
		await exited;
		await delay(200);
		expect((await beatsFromNow(heartbeatPath)).stillWriting).toEqual([]);
	});
});
