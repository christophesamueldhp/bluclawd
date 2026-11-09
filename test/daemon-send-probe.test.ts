import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleIpcRequest } from "../daemon/handler.ts";
import type { ServerSupervisor } from "../daemon/supervisor.ts";
import { heldTmux } from "./helpers/held-tmux.ts";
import { testRegistry } from "./helpers/registry.ts";
import { waitFor } from "./helpers/wait-for.ts";

function register(id: string) {
	return { type: "register", instance: { id, pane: id, cwd: "/p", activity: "idle" } } as const;
}
const send = (instanceId: string) => ({ type: "send", instanceId, message: { type: "abort" } }) as const;

describe("send asks tmux whether its pane is still there", () => {
	let dir: string;
	let up: Set<string>;
	let held: ReturnType<typeof heldTmux>;
	let supervisor: ServerSupervisor;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-send-probe-"));
		up = new Set(["pi-a", "pi-b"]);
		held = heldTmux(up);
		supervisor = testRegistry(dir, () => Date.now(), held.tmux);
		await handleIpcRequest(supervisor, register("pi-a"));
		await handleIpcRequest(supervisor, register("pi-b"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A send to `id`, once it is out waiting on tmux's answer about its pane. */
	const asking = async (id: string) => {
		const sent = handleIpcRequest(supervisor, send(id));
		await waitFor(() => expect([...held.pending.keys()]).toEqual([id]));
		return { sent };
	};

	it("answers other requests while tmux holds the answer, and queues once it comes", async () => {
		const { sent } = await asking("pi-a");
		expect(await handleIpcRequest(supervisor, register("pi-b"))).toMatchObject({ ok: true });
		expect(await handleIpcRequest(supervisor, { type: "list" })).toMatchObject({ type: "list_result" });
		expect(held.blocking).toEqual([]);

		held.answer();
		expect(await sent).toEqual({ type: "ack", ok: true });
		expect(supervisor.drainExternal("pi-a")).toEqual([{ type: "abort" }]);
	});

	const listed = async () => {
		const res = await handleIpcRequest(supervisor, { type: "list" });
		return res.type === "list_result" ? (res.instances ?? []).map((i) => i.id) : [];
	};
	const refused = { type: "error", ok: false, error: "Unknown instance: pi-a" };

	it("ends a pane tmux no longer has, and the send fails", async () => {
		up.delete("pi-a");
		const { sent } = await asking("pi-a");
		held.answer();
		expect(await sent).toEqual(refused);
		expect(await listed()).toEqual(["pi-b"]);
	});

	it("queues when tmux cannot say", async () => {
		held.tmux.hasSessionAsync = () => Promise.reject(new Error("timed out"));
		expect(await handleIpcRequest(supervisor, send("pi-a"))).toEqual({ type: "ack", ok: true });
		expect(supervisor.drainExternal("pi-a")).toEqual([{ type: "abort" }]);
	});

	it("fails, queuing nothing, for a pane that unregistered while tmux answered", async () => {
		const { sent } = await asking("pi-a");
		await handleIpcRequest(supervisor, { type: "unregister", instanceId: "pi-a" });
		held.answer();
		expect(await sent).toEqual(refused);
		expect(supervisor.drainExternal("pi-a")).toEqual([]);
	});

	it("queues for a pane that beat while tmux answered", async () => {
		const { sent } = await asking("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		held.answer();
		expect(await sent).toEqual({ type: "ack", ok: true });
		expect(supervisor.drainExternal("pi-a")).toEqual([{ type: "abort" }]);
	});

	it("queues for a pane tmux said was gone that beat while it answered, and leaves it live", async () => {
		up.delete("pi-a");
		const { sent } = await asking("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		held.answer();
		expect(await sent).toEqual({ type: "ack", ok: true });
		expect(await listed()).toEqual(["pi-a", "pi-b"]);
	});

	it("queues messages to one pane in the order sent, whichever of tmux's answers comes first", async () => {
		const answers: (() => void)[] = [];
		held.tmux.hasSessionAsync = () => new Promise((resolve) => answers.push(() => resolve(true)));
		const prompt = (text: string) => ({ type: "prompt", text }) as const;
		const sent = ["first", "second"].map((text) =>
			handleIpcRequest(supervisor, { type: "send", instanceId: "pi-a", message: prompt(text) }),
		);
		await waitFor(() => expect(answers).toHaveLength(2));
		answers[1]();
		await new Promise((resolve) => setImmediate(resolve));
		answers[0]();
		await Promise.all(sent);
		expect(supervisor.drainExternal("pi-a")).toEqual([prompt("first"), prompt("second")]);
	});

	it("wakes the pane's wait once it is queued", async () => {
		const wait = handleIpcRequest(supervisor, { type: "wait", instanceId: "pi-a" });
		const { sent } = await asking("pi-a");
		held.answer();
		await sent;
		expect(await wait).toEqual({ type: "wait_result", ok: true, queued: true });
	});
});
