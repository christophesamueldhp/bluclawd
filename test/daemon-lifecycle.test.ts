import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { type: string; [key: string]: unknown }) => void;

/** A stand-in child: the test drives its events; spawn args are recorded. */
class FakeChild {
	static last: FakeChild | undefined;
	static spawnOptions: Array<Record<string, unknown>> = [];
	static startupError: Error | undefined;
	listeners = new Set<Listener>();
	exitListeners = new Set<(error?: Error) => void>();
	uiHandler: ((request: unknown) => void) | undefined;
	answered: unknown[] = [];
	sent: unknown[] = [];
	disposed = false;
	readonly options: Record<string, unknown>;
	constructor(options: Record<string, unknown>) {
		this.options = options;
		FakeChild.last = this;
		FakeChild.spawnOptions.push(options);
	}
	onEvent(listener: Listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onExit(listener: (error?: Error) => void) {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}
	setUiRequestHandler(handler?: (request: unknown) => void) {
		this.uiHandler = handler;
	}
	handleUiResponse(response: unknown) {
		this.answered.push(response);
	}
	async send(command: { type: string }) {
		this.sent.push(command);
		if (command.type === "get_state") {
			if (FakeChild.startupError) throw FakeChild.startupError;
			return {
				type: "response",
				success: true,
				command: "get_state",
				data: { sessionId: "s1", sessionFile: (this.options.sessionFile as string) ?? "/tmp/s1.jsonl" },
			};
		}
		return { type: "response", success: true, command: command.type };
	}
	async dispose() {
		this.disposed = true;
	}
	emit(event: { type: string; [key: string]: unknown }) {
		for (const listener of this.listeners) listener(event);
	}
	crash() {
		for (const listener of this.exitListeners) listener(new Error("boom"));
	}
}

vi.mock("../daemon/rpc-process.ts", () => ({
	createRpcProcessInstance: (options: Record<string, unknown>) => new FakeChild(options),
}));

const { ServerSupervisor } = await import("../daemon/supervisor.ts");
const { loadInstances } = await import("../daemon/storage.ts");
const { SENTINEL_INSTRUCTIONS } = await import("../daemon/session-state.ts");

describe("agent-view session lifecycle", () => {
	let prevEnv: string | undefined;

	beforeEach(() => {
		prevEnv = process.env.PI_SERVER_DIR;
		process.env.PI_SERVER_DIR = mkdtempSync(join(tmpdir(), "bluclawd-lifecycle-"));
		FakeChild.spawnOptions = [];
		FakeChild.startupError = undefined;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.PI_SERVER_DIR;
		else process.env.PI_SERVER_DIR = prevEnv;
	});

	it("children get the sentinel instructions", async () => {
		await new ServerSupervisor().spawnInstance({ cwd: "/p" });
		const options = FakeChild.spawnOptions[0];
		expect(options.appendSystemPrompt).toBe(SENTINEL_INSTRUCTIONS);
	});

	it("stop keeps the row; delete removes it", async () => {
		const supervisor = new ServerSupervisor();
		const spawned = await supervisor.spawnInstance({ cwd: "/p" });
		FakeChild.last?.emit({ type: "agent_start" });
		await supervisor.stopInstance(spawned.id);
		const [row] = loadInstances();
		expect(row.status).toBe("stopped");
		expect(row.outcome).toBe("stopped"); // stopped mid-run
		expect(await supervisor.deleteInstance(spawned.id)).toBe(true);
		expect(loadInstances()).toEqual([]);
	});

	it("a finished run stays Done when its process is stopped", async () => {
		const supervisor = new ServerSupervisor();
		const spawned = await supervisor.spawnInstance({ cwd: "/p" });
		const child = FakeChild.last;
		child?.emit({ type: "agent_start" });
		child?.emit({ type: "message_end", message: { role: "assistant", content: "result: shipped it" } });
		child?.emit({ type: "agent_settled" });
		expect(loadInstances()[0]).toMatchObject({ outcome: "done", detail: "result: shipped it", turns: 1 });
		await supervisor.stopInstance(spawned.id);
		expect(loadInstances()[0].outcome).toBe("done");
	});

	it("native transfer refuses a writer that became busy after the roster was drawn", async () => {
		const supervisor = new ServerSupervisor();
		const row = await supervisor.spawnInstance({ cwd: "/p" });
		const child = FakeChild.last!;
		child.emit({ type: "agent_start" });
		await expect(supervisor.stopInstance(row.id, true)).rejects.toThrow("still working");
		expect(child.disposed).toBe(false);
		expect(supervisor.getInstance(row.id)?.status).toBe("online");
		expect(supervisor.getActivity(row.id)).toBe("working");
		child.emit({ type: "message_end", message: { role: "assistant", content: "result: completed" } });
		child.emit({ type: "agent_settled" });
		await supervisor.stopInstance(row.id, true);
		expect(child.disposed).toBe(true);
		expect(loadInstances()[0]).toMatchObject({ status: "stopped", outcome: "done" });
	});

	it("native transfer preserves an unanswered dialog", async () => {
		const supervisor = new ServerSupervisor();
		const row = await supervisor.spawnInstance({ cwd: "/p" });
		const child = FakeChild.last!;
		child.uiHandler?.({ type: "extension_ui_request", method: "input", id: "q", title: "Your choice?" });
		await expect(supervisor.stopInstance(row.id, true)).rejects.toThrow("waiting for input");
		expect(child.disposed).toBe(false);
		expect(supervisor.getPendingNeeds(row.id)?.requestId).toBe("q");
		expect(child.answered).toEqual([]);
	});

	it("native transfer blocks new prompts while releasing the idle writer", async () => {
		const supervisor = new ServerSupervisor();
		const row = await supervisor.spawnInstance({ cwd: "/p" });
		const child = FakeChild.last!;
		const stream = supervisor.openRpcStream(
			row.id,
			() => {},
			() => {},
		)!;
		let finish!: () => void;
		child.dispose = () =>
			new Promise<void>((resolve) => {
				finish = resolve;
			});
		const release = supervisor.stopInstance(row.id, true);
		expect(supervisor.getInstance(row.id)?.status).toBe("stopping");
		const prompt = { type: "prompt" as const, message: "must not run" };
		expect(await supervisor.handleRpc(row.id, prompt)).toBeUndefined();
		await expect(stream.handleRpc(prompt)).rejects.toThrow("being stopped");
		expect(child.sent).not.toContainEqual(prompt);
		finish();
		await release;
		stream.close();
	});

	it("a failed hand-off keeps the session file so its Failed row can be opened and revived", async () => {
		const supervisor = new ServerSupervisor();
		FakeChild.startupError = new Error("Cannot find package: old Pi installation removed");
		await expect(supervisor.spawnInstance({ cwd: "/p", sessionFile: "/p/outgoing.jsonl" })).rejects.toThrow(
			"Cannot find package",
		);
		const [failed] = loadInstances();
		expect(failed).toMatchObject({ status: "stopped", outcome: "failed", sessionFile: "/p/outgoing.jsonl" });
		expect(failed.detail).toContain("old Pi installation removed");
		FakeChild.startupError = undefined;
		const revived = await supervisor.spawnInstance({ cwd: "/p", sessionFile: "/p/outgoing.jsonl" });
		expect(revived.id).toBe(failed.id);
		expect(loadInstances()).toHaveLength(1);
	});

	it("a crashed child is kept as Failed instead of vanishing", async () => {
		const supervisor = new ServerSupervisor();
		await supervisor.spawnInstance({ cwd: "/p" });
		FakeChild.last?.crash();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(loadInstances()[0]).toMatchObject({ status: "stopped", outcome: "failed" });
	});

	it("resuming a known session file revives the same row, and never spawns a second writer", async () => {
		const supervisor = new ServerSupervisor();
		const first = await supervisor.spawnInstance({ cwd: "/p", sessionFile: "/tmp/a.jsonl", label: "walk cycle" });
		const again = await supervisor.spawnInstance({ cwd: "/p", sessionFile: "/tmp/a.jsonl" });
		expect(again.id).toBe(first.id);
		expect(FakeChild.spawnOptions).toHaveLength(1);

		supervisor.setInstanceMeta(first.id, { pinned: true });
		await supervisor.stopInstance(first.id);
		const revived = await supervisor.spawnInstance({ cwd: "/elsewhere", sessionFile: "/tmp/a.jsonl" });
		expect(revived).toMatchObject({ id: first.id, label: "walk cycle", pinned: true, createdAt: first.createdAt });
		expect(loadInstances()).toHaveLength(1);
	});

	it("rename updates the row and tells a live child", async () => {
		const supervisor = new ServerSupervisor();
		const spawned = await supervisor.spawnInstance({ cwd: "/p" });
		await supervisor.renameInstance(spawned.id, "jump physics");
		expect(loadInstances()[0].label).toBe("jump physics");
		expect(FakeChild.last?.sent).toContainEqual({ type: "set_session_name", name: "jump physics" });
	});

	it("answer resolves only the prompt the session is actually waiting on", async () => {
		const supervisor = new ServerSupervisor();
		const spawned = await supervisor.spawnInstance({ cwd: "/p" });
		const child = FakeChild.last;
		child?.uiHandler?.({
			type: "extension_ui_request",
			id: "q1",
			method: "select",
			title: "Allow?",
			options: ["Yes", "No"],
		});
		expect(supervisor.getPendingNeeds(spawned.id)).toMatchObject({ requestId: "q1", options: ["Yes", "No"] });
		expect(supervisor.getActivity(spawned.id)).toBe("awaiting_input");

		expect(supervisor.answer(spawned.id, { type: "extension_ui_response", id: "stale", value: "Yes" })).toBe(false);
		expect(supervisor.answer(spawned.id, { type: "extension_ui_response", id: "q1", value: "Yes" })).toBe(true);
		expect(child?.answered).toHaveLength(1);
		expect(supervisor.getPendingNeeds(spawned.id)).toBeUndefined();
		expect(supervisor.getActivity(spawned.id)).toBe("working");
	});

	it("save lists a session as a row without starting it, reusing a row it already has", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-save-"));
		const file = join(dir, "s.jsonl");
		const reply = { role: "assistant", content: [{ type: "text", text: "result: tests pass" }], stopReason: "stop" };
		writeFileSync(file, `${JSON.stringify({ type: "message", message: reply })}\n`);
		const supervisor = new ServerSupervisor();

		const saved = supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(FakeChild.spawnOptions).toHaveLength(0);
		expect(loadInstances()).toEqual([
			expect.objectContaining({ id: saved.id, status: "stopped", outcome: "done", detail: "result: tests pass" }),
		]);

		supervisor.setInstanceMeta(saved.id, { pinned: true });
		const again = supervisor.saveInstance({ cwd: "/p", label: "other", sessionFile: file });
		expect(again).toMatchObject({ id: saved.id, label: "fix tests", pinned: true });
		expect(loadInstances()).toHaveLength(1);
	});

	it("save leaves a session the daemon is running alone", async () => {
		const supervisor = new ServerSupervisor();
		const live = await supervisor.spawnInstance({ cwd: "/p", sessionFile: "/tmp/live.jsonl" });
		expect(supervisor.saveInstance({ cwd: "/p", sessionFile: "/tmp/live.jsonl" })).toMatchObject({
			id: live.id,
			status: "online",
		});
	});

	it("recovery after a daemon restart keeps rows as stopped", async () => {
		const supervisor = new ServerSupervisor();
		await supervisor.spawnInstance({ cwd: "/p" });
		await new ServerSupervisor().recoverAfterRestart();
		expect(loadInstances()[0]).toMatchObject({ status: "stopped", outcome: "stopped" });
	});
});
