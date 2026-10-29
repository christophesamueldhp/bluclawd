import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reapDescendants } from "../ext/sandbox/reaper.ts";
import { readHeartbeats } from "./helpers/heartbeats.ts";

const lifetimeMs = 3000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const descendants = fileURLToPath(new URL("./fixtures/subagent-writer/descendants.mjs", import.meta.url));
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

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
		const command = [process.execPath, descendants, mode, heartbeatPath, "reaper-probe", String(lifetimeMs)]
			.map(quote)
			.join(" ");
		const awaitBeat = `for _ in {1..500}; do [ -s ${quote(heartbeatPath)} ] && break; sleep 0.01; done`;
		const settled = exec(stop === "exit" ? `${command} & ${awaitBeat}` : command, dir, {
			onData: () => {},
			signal: abort.signal,
		}).catch(() => undefined);
		if (stop === "abort") {
			const deadline = Date.now() + 5000;
			while (!beats().some((beat) => mode !== "double-fork" || beat.ppid === 1)) {
				if (Date.now() > deadline) throw new Error("descendant never started");
				await delay(10);
			}
			abort.abort();
		}
		await settled;
		const atSettlement = beats().at(-1)?.sequence ?? 0;
		await delay(150);
		return { started: beats().length > 0, stillWriting: beats().filter((beat) => beat.sequence > atSettlement) };
	}

	it.each(["detached", "double-fork"])(
		"kills a %s descendant when the command is stopped",
		async (mode) => {
			const result = await run(mode, "abort");
			expect(result.started).toBe(true);
			expect(result.stillWriting).toEqual([]);
		},
		15000,
	);

	it("kills a detached descendant left behind when the command exits", async () => {
		const result = await run("detached", "exit");
		expect(result.started).toBe(true);
		expect(result.stillWriting).toEqual([]);
	}, 15000);

	it("kills a double-fork descendant when the process running the command dies", async () => {
		const command = [process.execPath, descendants, "double-fork", heartbeatPath, "reaper-probe", String(lifetimeMs)]
			.map(quote)
			.join(" ");
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
		const deadline = Date.now() + 10000;
		while (!beats().some((beat) => beat.ppid === 1)) {
			if (Date.now() > deadline) throw new Error("descendant never started");
			await delay(10);
		}
		// As when pi is killed: nothing runs its stop, and the helper sees the end of its stdin.
		owner.kill("SIGKILL");
		await exited;
		await delay(200);
		const afterReap = beats().at(-1)?.sequence ?? 0;
		await delay(150);
		expect(beats().filter((beat) => beat.sequence > afterReap)).toEqual([]);
	}, 15000);
});
