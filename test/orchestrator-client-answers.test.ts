import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest } from "../daemon/handler.ts";
import { startIpcServer } from "../daemon/ipc/server.ts";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { collectRows } from "../daemon/rows.ts";
import { testRegistry } from "./helpers/registry.ts";

const signal = () => new AbortController().signal;

/** Each request a client method sends, and what the method makes of an answer it cannot use. */
const methods: Array<{
	name: string;
	call: (client: OrchestratorClient) => Promise<unknown>;
	/** What it resolves to from a daemon that predates the request; "out of date" when it rejects as such. */
	unknown: unknown;
}> = [
	{ name: "save", call: (c) => c.save({ cwd: "/p", sessionFile: "/p/s.jsonl" }), unknown: undefined },
	{ name: "start", call: (c) => c.start({ cwd: "/p", sessionFile: "/p/s.jsonl" }), unknown: "out of date" },
	{ name: "startFailed", call: (c) => c.startFailed("row"), unknown: undefined },
	{ name: "delete", call: (c) => c.delete("row"), unknown: undefined },
	{ name: "rename", call: (c) => c.rename("row", "name"), unknown: undefined },
	{ name: "setMeta", call: (c) => c.setMeta("row", { pinned: true }), unknown: undefined },
	{
		name: "register",
		call: (c) => c.register({ id: "pane", cwd: "/p" }),
		unknown: { messages: [], watched: false, wantReport: false },
	},
	{ name: "wait", call: (c) => c.wait("pane", signal()), unknown: undefined },
	{ name: "send", call: (c) => c.send("pane", { type: "abort" }), unknown: "out of date" },
	{ name: "remote", call: (c) => c.remote({ action: "status" }), unknown: "out of date" },
	{ name: "remoteLive", call: (c) => c.remoteLive("pane", null), unknown: undefined },
	{ name: "remoteReport", call: (c) => c.remoteReport("pane", { models: [] }), unknown: undefined },
	{
		name: "holdWakeups",
		call: (c) =>
			c.holdWakeups({
				sessionFile: "/p/s.jsonl",
				cwd: "/p",
				holder: { pid: 1, startedAt: 1 },
				launch: { command: ["pi"] },
				wakeups: [],
			}),
		unknown: undefined,
	},
	{ name: "claimRun", call: (c) => c.claimRun("run", "parent", signal()), unknown: "out of date" },
	{ name: "claimRunNow", call: (c) => c.claimRunNow("run", "parent"), unknown: "out of date" },
	{
		name: "launchRun",
		call: (c) => c.launchRun("run", { runDir: "/r", env: {} }),
		unknown: "out of date",
	},
	{ name: "takeRunEnv", call: (c) => c.takeRunEnv("pane"), unknown: "out of date" },
	{ name: "releaseRun", call: (c) => c.releaseRun("run"), unknown: undefined },
	{
		name: "collaboration",
		call: (c) => c.collaboration({ sessionId: "s", action: "get" }),
		unknown: "out of date",
	},
	{ name: "unregister", call: (c) => c.unregister("pane"), unknown: undefined },
];

/** What a client method does with an answer that is not its request's: from an older daemon, or a refusal. */
describe("OrchestratorClient and a daemon that does not answer its request", () => {
	let dir: string;
	let server: Server | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-client-answers-"));
	});
	afterEach(async () => {
		server?.close();
		server = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	/** A daemon stand-in that knows `list`, as every daemon does, and answers anything else with `answer`. */
	async function daemon(answer: Record<string, unknown>): Promise<OrchestratorClient> {
		const socketPath = join(dir, "server.sock");
		server = createServer((socket) => {
			socket.on("data", (chunk) => {
				const { type } = JSON.parse(chunk.toString().trim()) as { type: string };
				const reply = type === "list" ? { type: "list_result", ok: true, instances: [] } : answer;
				socket.end(`${JSON.stringify({ ...reply, version: "0.0.1", buildId: "old", pid: 7 })}\n`);
			});
		});
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
		return new OrchestratorClient(socketPath);
	}

	// A daemon answers a request it does not know with its version, build and pid, and no type (daemon/ipc/server.ts).
	describe.each([
		["no type, as a daemon that predates the request answers", {}],
		["another request's type", { type: "status_result", ok: true }],
	])("answered with %s", (_name, answer) => {
		it.each(methods)("$name", async ({ call, unknown }) => {
			const client = await daemon(answer);
			if (unknown === "out of date") await expect(call(client)).rejects.toThrow(/out of date/);
			else expect(await call(client)).toEqual(unknown);
		});

		it("shutdownDaemon says the daemon predates the request", async () => {
			const client = await daemon(answer);
			expect(await client.shutdownDaemon()).toEqual({ ok: false, reason: expect.stringMatching(/predates/) });
		});
	});

	describe("answered with a refusal", () => {
		const refusal = { type: "error", ok: false, error: "refused: for a reason" };

		it.each(methods)("$name rejects with the daemon's reason", async ({ call }) => {
			const client = await daemon(refusal);
			await expect(call(client)).rejects.toThrow("refused: for a reason");
		});

		it("shutdownDaemon gives the daemon's reason", async () => {
			const client = await daemon(refusal);
			expect(await client.shutdownDaemon()).toEqual({ ok: false, reason: "refused: for a reason" });
		});
	});

	it("reads the daemon's version, build and pid from its answer to list", async () => {
		const client = await daemon({});
		expect(await client.getDaemonInfo()).toEqual({ running: true, version: "0.0.1", buildId: "old", pid: 7 });
		expect(await client.list()).toEqual([]);
	});
});

/** A request as the client sends it, through a socket to the daemon's handler and a registry on disk. */
describe("OrchestratorClient through the daemon's socket and handler", () => {
	let dir: string;
	let server: Server;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-client-chain-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		const supervisor = testRegistry(dir);
		server = await startIpcServer((request) => handleIpcRequest(supervisor, request));
	});
	afterEach(async () => {
		await new Promise((resolve) => server.close(resolve));
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	it("saves a run's row with its orchestrator's pane, which keeps it out of the listed sessions", async () => {
		const client = new OrchestratorClient();
		await client.save({ cwd: "/p", sessionFile: "/p/run.jsonl", parent: "pi-orchestrator" });
		await client.save({ cwd: "/p", sessionFile: "/p/own.jsonl" });

		const saved = await client.list();
		expect(saved.map(({ sessionFile, parent }) => ({ sessionFile, parent }))).toEqual([
			{ sessionFile: "/p/run.jsonl", parent: "pi-orchestrator" },
			{ sessionFile: "/p/own.jsonl", parent: undefined },
		]);
		expect(collectRows(saved, undefined).map((row) => row.sessionFile)).toEqual(["/p/own.jsonl"]);
	});
});

it("the daemon's handler answers a request of a type it does not know with nothing, as the client expects", async () => {
	for (const type of ["later_request", "constructor", "toString"]) {
		expect(await handleIpcRequest(testRegistry(), { type } as never)).toBeUndefined();
	}
});
