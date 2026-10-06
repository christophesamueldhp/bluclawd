import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";

let server: Server | undefined;
let dir: string | undefined;
afterEach(async () => {
	server?.close();
	if (dir) await rm(dir, { recursive: true, force: true });
});

async function daemon(promptAccepted = true) {
	dir = await mkdtemp(join(tmpdir(), "bluclawd-image-spawn-"));
	const requests: Array<Record<string, unknown>> = [];
	server = createServer((socket) =>
		socket.on("data", (chunk) => {
			const req = JSON.parse(chunk.toString().trim());
			requests.push(req);
			socket.end(
				`${JSON.stringify(
					req.type === "spawn"
						? { type: "spawn_result", ok: true, instance: { id: "new", status: "online", cwd: "/p" } }
						: {
								type: "rpc_result",
								ok: true,
								response: {
									type: "response",
									command: "prompt",
									success: promptAccepted,
									error: promptAccepted ? undefined : "image rejected",
								},
							},
				)}\n`,
			);
		}),
	);
	await new Promise<void>((resolve) => server?.listen(join(dir!, "server.sock"), resolve));
	return { client: new OrchestratorClient(join(dir, "server.sock")), requests };
}

describe("Agent View new-session RPC", () => {
	it("sends image-only prompts as structured RPC images", async () => {
		const { client, requests } = await daemon();
		await client.spawn({ cwd: "/p", prompt: "", images: [{ type: "image", mimeType: "image/png", data: "AQID" }] });
		expect(requests[1]).toEqual({
			type: "rpc",
			instanceId: "new",
			command: { type: "prompt", message: "", images: [{ type: "image", mimeType: "image/png", data: "AQID" }] },
		});
	});
	it("reports a rejected first prompt instead of pretending the task was submitted", async () => {
		const { client } = await daemon(false);
		await expect(client.spawn({ cwd: "/p", prompt: "describe image" })).rejects.toThrow("image rejected");
	});
});

describe("safe transfer to native Pi", () => {
	it.each([
		{ type: "stop_result", ok: true, instanceId: "a" },
		{ version: "old", buildId: "legacy" },
	])("uses a distinct request and checks the daemon's acknowledgement: %j", async (response) => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-native-transfer-"));
		const requests: unknown[] = [];
		server = createServer((socket) =>
			socket.on("data", (chunk) => {
				requests.push(JSON.parse(chunk.toString()));
				socket.end(`${JSON.stringify(response)}\n`);
			}),
		);
		const socket = join(dir, "server.sock");
		await new Promise<void>((resolve) => server?.listen(socket, resolve));
		const transfer = new OrchestratorClient(socket).releaseIdle("a");
		if ("type" in response) await expect(transfer).resolves.toBeUndefined();
		else await expect(transfer).rejects.toThrow("cannot transfer sessions safely");
		expect(requests).toEqual([{ type: "release_idle", instanceId: "a" }]);
	});
});
