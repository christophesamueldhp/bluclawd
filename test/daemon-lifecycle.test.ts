import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { type: string; [key: string]: unknown }) => void;

/** A stand-in child: the test drives its events; spawn args are recorded. */
class FakeChild {
	static last: FakeChild | undefined;
	static spawnOptions: Array<Record<string, unknown>> = [];
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
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.PI_SERVER_DIR;
		else process.env.PI_SERVER_DIR = prevEnv;
	});

	it("children get the sentinel instructions and ask-mode permissions", async () => {
		await new ServerSupervisor().spawnInstance({ cwd: "/p" });
		const options = FakeChild.spawnOptions[0];
		expect(options.appendSystemPrompt).toBe(SENTINEL_INSTRUCTIONS);
		expect((options.env as Record<string, string>).PI_PERMISSION_MODE).toBe("ask");
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

	it("recovery after a daemon restart keeps rows as stopped", async () => {
		const supervisor = new ServerSupervisor();
		await supervisor.spawnInstance({ cwd: "/p" });
		await new ServerSupervisor().recoverAfterRestart();
		expect(loadInstances()[0]).toMatchObject({ status: "stopped", outcome: "stopped" });
	});
});
