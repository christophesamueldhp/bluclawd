import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTINUE_PROMPT } from "../ext/agent-view/hand-off.ts";
import { currentDaemonBuildId } from "../ext/agent-view/orchestrator-client.ts";

const HELPER = join(import.meta.dirname, "..", "ext", "agent-view", "hand-off.ts");

/** A daemon stand-in of the current build: answers `list`, `spawn` and `save`, records every request. */
async function fakeDaemon(dir: string): Promise<{ server: Server; requests: Array<Record<string, unknown>> }> {
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer((socket) => {
		socket.on("data", (chunk) => {
			const request = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
			requests.push(request);
			const reply =
				request.type === "spawn"
					? { type: "spawn_result", ok: true, instance: { id: "bg", status: "online", cwd: "/p" } }
					: { type: request.type === "save" ? "ack" : `${request.type}_result`, ok: true, instances: [] };
			socket.end(`${JSON.stringify({ ...reply, buildId: currentDaemonBuildId() })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(join(dir, "server.sock"), resolve));
	return { server, requests };
}

describe("hand-off.ts run as the exit helper", () => {
	let dir: string | undefined;
	let server: Server | undefined;

	afterEach(async () => {
		server?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	/** Run the helper for a pi process that has already exited; the fake daemon's requests. */
	async function runHelper(working: boolean): Promise<Array<Record<string, unknown>>> {
		dir = await mkdtemp(join(tmpdir(), "handoff-"));
		const daemon = await fakeDaemon(dir);
		server = daemon.server;
		const gone = spawn(process.execPath, ["-e", ""]);
		await new Promise((resolve) => gone.once("exit", resolve));
		const outgoing = { cwd: "/p", sessionFile: "/p/s.jsonl", model: { provider: "x", id: "y" }, working };
		const helper = spawn(process.execPath, [HELPER, String(gone.pid), JSON.stringify(outgoing)], {
			env: { ...process.env, PI_SERVER_DIR: dir },
			stdio: "ignore",
		});
		expect(await new Promise((resolve) => helper.once("exit", resolve))).toBe(0);
		return daemon.requests;
	}

	it("once the pi process is gone, resumes a working session in the daemon with the continue prompt", async () => {
		const requests = await runHelper(true);
		expect(requests).toContainEqual(
			expect.objectContaining({ type: "spawn", sessionFile: "/p/s.jsonl", provider: "x", model: "y" }),
		);
		expect(requests).toContainEqual({
			type: "rpc",
			instanceId: "bg",
			command: { type: "prompt", message: CONTINUE_PROMPT },
		});
	});

	it("saves an idle session as a row without starting it", async () => {
		const requests = await runHelper(false);
		expect(requests).toContainEqual({ type: "save", cwd: "/p", sessionFile: "/p/s.jsonl" });
		expect(requests.some((r) => r.type === "spawn")).toBe(false);
	});
});
