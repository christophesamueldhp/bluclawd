import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHeartbeats } from "./helpers/heartbeats.ts";
import { createWriterFixture } from "./helpers/writer-fixture.ts";

const supported =
	process.platform === "darwin" &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;
const lifetimeMs = 3000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!supported)("macOS: stopping a sandboxed command ends its descendants (target of #29)", () => {
	let fixture: Awaited<ReturnType<typeof createWriterFixture>>;
	let waitForProbe: (() => Promise<void>) | undefined;
	beforeEach(async () => {
		fixture = await createWriterFixture();
	});
	afterEach(async () => {
		await waitForProbe?.();
		waitForProbe = undefined;
		await fixture.cleanup();
	});

	async function observeAfterStop(mode: string, loseOwner = false) {
		const workspace = join(fixture.runDir, "worktree");
		await mkdir(workspace);
		const heartbeatPath = join(workspace, "heartbeat.jsonl");
		const identity = `bluclawd-proof-${randomUUID()}`;
		const controllerPath = fileURLToPath(new URL("./fixtures/subagent-writer/probe-controller.mjs", import.meta.url));
		const child = spawn(
			process.execPath,
			[
				controllerPath,
				workspace,
				fixture.parentCwd,
				fixture.siblingDir,
				mode,
				heartbeatPath,
				identity,
				String(lifetimeMs),
			],
			{
				cwd: workspace,
				env: { PATH: process.env.PATH, HOME: fixture.runDir, TMPDIR: workspace, LANG: "C" },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		const exited = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`Probe exit ${code}: ${stdout} ${stderr}`)),
			);
		});
		const settled = exited.then(
			() => undefined,
			() => undefined,
		);
		waitForProbe = async () => {
			child.stdin.end();
			await settled;
			// Fixture descendants self-expire; never kill a process using a persisted PID.
			if (existsSync(`${heartbeatPath}.identity`)) {
				const info = JSON.parse(readFileSync(`${heartbeatPath}.identity`, "utf8"));
				await delay(Math.max(0, info.expiresAt - Date.now()) + 100);
			}
		};
		const beats = () => readHeartbeats(heartbeatPath);
		const deadline = Date.now() + 5000;
		while (!beats().some((beat) => beat.identity === identity && (mode !== "double-fork" || beat.ppid === 1))) {
			if (child.exitCode !== null) throw new Error(`Probe stopped before readiness: ${stdout} ${stderr}`);
			if (Date.now() > deadline) throw new Error(`Probe readiness timeout: ${stdout} ${stderr}`);
			await delay(10);
		}
		const started = beats().at(-1)!;
		if (loseOwner) child.stdin.end();
		else child.stdin.write("stop\n");
		await exited;
		const atSettlement = beats().at(-1)!.sequence;
		await delay(150);
		const stillWriting = beats().filter((beat) => beat.identity === identity && beat.sequence > atSettlement);
		return { started, stillWriting, stdout };
	}

	it.each(["attached", "inherited-stdio", "detached", "double-fork"])(
		"leaves no executing descendant after public cancellation and sandbox reset: %s",
		async (mode) => {
			const result = await observeAfterStop(mode);
			expect(result.stdout).toContain('"event":"settled"');
			expect(result.stillWriting.map((beat) => beat.pid)).toEqual([]);
		},
		15000,
	);

	it("leaves no executing double-fork descendant after the owner pipe closes", async () => {
		const result = await observeAfterStop("double-fork", true);
		expect(result.started.ppid).toBe(1);
		expect(result.stillWriting.map((beat) => beat.pid)).toEqual([]);
	}, 15000);
});
