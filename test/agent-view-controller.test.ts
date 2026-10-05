import type { RpcCommand, RpcExtensionUIResponse, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createViewProjection } from "../daemon/view-projection.ts";
import type { HistoryPage, ManagedDraft, ViewEvent, ViewReady, ViewTerminal } from "../daemon/view-types.ts";
import type { InstanceSummary } from "../ext/agent-view/orchestrator-client.ts";
import { SessionController } from "../ext/agent-view/session-controller.ts";
import type { SessionViewHandle } from "../ext/agent-view/view-client.ts";
import { assistant } from "./support/view-fixtures.ts";

const images = [{ type: "image" as const, mimeType: "image/png", data: "AA==" }];
const input: ManagedDraft = { text: "hello", images };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function fixture() {
	const rows = new Map<string, InstanceSummary>(
		["a", "b"].map((id) => [id, { id, status: "online", cwd: "/unit", sessionFile: "/" + id + ".jsonl" }]),
	);
	const generations = new Map<string, string>();
	const overrides = new Map<string, Partial<ViewReady>>();
	const log: string[] = [];
	const transports: Array<
		SessionViewHandle & { record: (record: ViewEvent | ViewTerminal) => void; disconnect: (error?: Error) => void }
	> = [];
	const client = {
		stop: vi.fn(),
		list: vi.fn(async () => [...rows.values()]),
		history: vi.fn(async (): Promise<HistoryPage> => ({ messages: [], before: undefined })),
		spawn: vi.fn(async (opts: { cwd: string; sessionFile?: string; model?: unknown }) => {
			log.push("spawn");
			let row = [...rows.values()].find((r) => opts.sessionFile && r.sessionFile === opts.sessionFile);
			if (!row) {
				const id = "new-" + rows.size;
				row = { id, status: "online", cwd: opts.cwd, sessionFile: opts.sessionFile ?? "/" + id + ".jsonl" };
				rows.set(id, row);
			}
			if (row.status !== "online") {
				row.status = "online";
				generations.set(row.id, "revived");
			}
			return { ...row };
		}),
	};
	const send = vi.fn(async (command: RpcCommand): Promise<RpcResponse> => {
		log.push(command.type === "prompt" ? "prompt" : command.type);
		return { type: "response", command: command.type, success: true } as RpcResponse;
	});
	function make(
		id: string,
		options: { onRecord: (record: ViewEvent | ViewTerminal) => void; onDisconnect: (error?: Error) => void } = {
			onRecord: () => {},
			onDisconnect: () => {},
		},
	) {
		const row = rows.get(id);
		if (!row) throw new Error("unknown session");
		const projection = createViewProjection();
		const state: RpcSessionState = {
			sessionId: id,
			sessionFile: row.sessionFile,
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			autoCompactionEnabled: true,
			messageCount: 0,
			pendingMessageCount: 0,
		};
		const ready: ViewReady = {
			type: "view_ready",
			ok: true,
			viewProtocol: 1,
			instance: { ...row },
			generation: generations.get(id) ?? "g-" + id,
			sequence: 0,
			projection,
			state,
			...overrides.get(id),
		};
		const h = {
			ready,
			send,
			answer: vi.fn(async (_response: RpcExtensionUIResponse) => true),
			close: vi.fn(),
			record: options.onRecord,
			disconnect: options.onDisconnect,
		};
		transports.push(h);
		return h;
	}
	const views = {
		open: vi.fn(
			async (
				id: string,
				options: {
					signal?: AbortSignal;
					onRecord: (record: ViewEvent | ViewTerminal) => void;
					onDisconnect: (error?: Error) => void;
				},
			): Promise<SessionViewHandle> => {
				log.push("attach");
				return make(id, options);
			},
		),
	};
	const onChange = vi.fn();
	const controller = new SessionController({
		client,
		views,
		cwd: "/unit",
		model: { provider: "test", id: "model" },
		onChange,
	});
	return { client, views, controller, rows, transports, log, send, make, overrides, generations, onChange };
}
describe("managed session selection", () => {
	it("malformed incoming snapshot cannot replace the old selection", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		const old = f.transports[0];
		const projection = createViewProjection();
		projection.queues = undefined as never;
		f.overrides.set("b", { projection });
		expect(await f.controller.select({ instanceId: "b" })).toBe(false);
		expect(f.controller.selected()?.instance.id).toBe("a");
		expect(old.close).not.toHaveBeenCalled();
		f.controller.dispose();
	});
	it("buffers events arriving immediately after ready", async () => {
		const f = fixture();
		const projection = createViewProjection();
		projection.partial = assistant("before");
		f.overrides.set("a", { projection });
		f.views.open.mockImplementationOnce(async (id, opts) => {
			const h = f.make(id, opts);
			opts.onRecord({
				type: "view_event",
				generation: h.ready.generation,
				sequence: 1,
				event: {
					type: "message_update",
					usage: assistant("").usage,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " after" },
				},
			});
			return h;
		});
		await f.controller.select({ instanceId: "a" });
		expect(f.controller.projection()?.partial?.content).toEqual([{ type: "text", text: "before after" }]);
		f.controller.dispose();
	});
	it("live editor requests update draft without replaying cached text on reconnect", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		f.transports[0].record({
			type: "view_event",
			generation: "g-a",
			sequence: 1,
			event: { type: "extension_ui_request", id: "editor", method: "set_editor_text", text: "remote suggestion" },
		});
		expect(f.controller.draft().text).toBe("remote suggestion");
		f.controller.setDraft({ text: "local edit", images });
		const projection = createViewProjection();
		projection.editorText = "remote suggestion";
		f.overrides.set("a", { projection });
		await f.controller.reconnect();
		expect(f.controller.draft()).toEqual({ text: "local edit", images });
		f.controller.dispose();
	});
	it("history advances cursors and never returns another selection data", async () => {
		const f = fixture();
		const projection = createViewProjection();
		projection.historyBefore = "first";
		f.overrides.set("a", { projection });
		await f.controller.select({ instanceId: "a" });
		f.client.history.mockResolvedValueOnce({ messages: [], before: "older" });
		await f.controller.history();
		await f.controller.history();
		await f.controller.history();
		expect(f.client.history.mock.calls).toEqual([
			["a", "first"],
			["a", "older"],
		]);
		await f.controller.select({ instanceId: "a" });
		const gate = deferred<HistoryPage>();
		f.client.history.mockImplementationOnce(() => gate.promise);
		const history = f.controller.history();
		await f.controller.select({ instanceId: "b" });
		gate.resolve({ messages: [{ key: "old", message: assistant("a only") }] });
		expect((await history).messages).toEqual([]);
		f.controller.dispose();
	});
	it("closing a successful picker signal does not detach the selected view", async () => {
		const f = fixture();
		f.views.open.mockImplementationOnce(async (id, opts) => {
			const h = f.make(id, opts);
			opts.signal?.addEventListener("abort", () => opts.onDisconnect(new Error("picker closed")));
			return h;
		});
		const picker = new AbortController();
		expect(await f.controller.select({ instanceId: "a" }, picker.signal)).toBe(true);
		picker.abort();
		expect(f.controller.connectionState()).toBe("connected");
		f.controller.dispose();
	});
	it("A B A never stops or respawns live children", async () => {
		const f = fixture();
		for (const id of ["a", "b", "a"]) expect(await f.controller.select({ instanceId: id })).toBe(true);
		expect(f.controller.selected()?.instance.id).toBe("a");
		expect(f.client.stop).not.toHaveBeenCalled();
		expect(f.client.spawn).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
		f.controller.dispose();
	});
	it("cancelled or failed attach retains old view", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		const old = f.transports[0];
		f.views.open.mockRejectedValueOnce(new Error("broken attach"));
		expect(await f.controller.select({ instanceId: "b" })).toBe(false);
		expect(old.close).not.toHaveBeenCalled();
		const gate = deferred<SessionViewHandle>();
		f.views.open.mockImplementationOnce(() => gate.promise);
		const selection = f.controller.select({ instanceId: "b" });
		await vi.waitFor(() => expect(f.views.open).toHaveBeenCalledTimes(3));
		f.controller.cancelSelection();
		const stale = f.make("b");
		gate.resolve(stale);
		expect(await selection).toBe(false);
		expect(stale.close).toHaveBeenCalledOnce();
		expect(f.controller.selected()?.instance.id).toBe("a");
		f.controller.dispose();
	});
	it("stale ready cannot steal selection", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		const gate = deferred<SessionViewHandle>();
		f.views.open.mockImplementationOnce(() => gate.promise);
		const delayed = f.controller.select({ instanceId: "b" });
		await vi.waitFor(() => expect(f.views.open).toHaveBeenCalledTimes(2));
		await f.controller.select({ instanceId: "a" });
		const stale = f.make("b");
		gate.resolve(stale);
		expect(await delayed).toBe(false);
		expect(f.controller.selected()?.instance.id).toBe("a");
		expect(stale.close).toHaveBeenCalledOnce();
		f.controller.dispose();
	});
	it("drafts and images belong to session", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		f.controller.setDraft(input);
		await f.controller.select({ instanceId: "b" });
		expect(f.controller.draft()).toEqual({ text: "", images: [] });
		f.controller.setDraft({ text: "b draft", images: [] });
		await f.controller.select({ instanceId: "a" });
		expect(f.controller.draft()).toEqual(input);
		f.controller.blank();
		expect(f.controller.selected()).toBeUndefined();
		expect(f.client.stop).not.toHaveBeenCalled();
		f.controller.dispose();
	});
	it("subscribe precedes first prompt", async () => {
		const f = fixture();
		expect(await f.controller.submit(input)).toBe("accepted");
		expect(f.log).toEqual(["spawn", "attach", "prompt"]);
		expect(f.client.spawn.mock.calls[0][0]).toEqual({ cwd: "/unit", model: { provider: "test", id: "model" } });
		expect(f.send.mock.calls[0][0]).toMatchObject({ type: "prompt", message: "hello", images });
		expect(f.controller.draft()).toEqual({ text: "", images: [] });
		f.controller.dispose();
	});
	it("reply after deliberate stop revives saved conversation once", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		f.rows.get("a")!.status = "stopped";
		f.transports[0].record({
			type: "view_terminal",
			instanceId: "a",
			generation: "g-a",
			sequence: 1,
			reason: "stopped",
		});
		expect(f.controller.selected()?.instance.id).toBe("a");
		expect(f.client.spawn).not.toHaveBeenCalled();
		expect(await f.controller.submit(input)).toBe("accepted");
		expect(f.client.spawn).toHaveBeenCalledOnce();
		expect(f.client.spawn.mock.calls[0][0]).toMatchObject({ sessionFile: "/a.jsonl" });
		expect(f.views.open).toHaveBeenCalledTimes(2);
		expect(f.send).toHaveBeenCalledOnce();
		f.controller.dispose();
	});
	it("export and restore retain every session draft", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		f.controller.setDraft(input);
		await f.controller.select({ instanceId: "b" });
		f.controller.setDraft({ text: "second", images: [] });
		f.controller.blank();
		f.controller.setDraft({ text: "blank", images: [] });
		const saved = f.controller.exportState();
		f.controller.dispose();
		const restored = fixture();
		restored.controller.restoreDrafts(saved.drafts);
		expect(restored.controller.draft().text).toBe("blank");
		await restored.controller.select({ instanceId: "a" });
		expect(restored.controller.draft()).toEqual(input);
		await restored.controller.select({ instanceId: "b" });
		expect(restored.controller.draft().text).toBe("second");
		restored.controller.dispose();
	});
	it("busy prompt uses followUp", async () => {
		const f = fixture();
		const projection = createViewProjection();
		projection.running = true;
		projection.activity = "working";
		f.overrides.set("a", { projection });
		await f.controller.select({ instanceId: "a" });
		expect(await f.controller.submit(input)).toBe("accepted");
		expect(f.send.mock.calls[0][0]).toMatchObject({ type: "prompt", streamingBehavior: "followUp", images });
		f.controller.dispose();
	});
	it("uncertain acknowledgement never resends", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		f.send.mockRejectedValueOnce(new Error("ack lost"));
		expect(await f.controller.submit(input)).toBe("uncertain");
		expect(f.controller.draft()).toEqual(input);
		expect(f.controller.notice()).toMatch(/may.*accepted/i);
		await f.controller.reconnect();
		expect(f.send).toHaveBeenCalledOnce();
		expect(f.client.spawn).not.toHaveBeenCalled();
		f.controller.dispose();
	});
	it("deleted terminal record blanks selection", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		f.controller.setDraft(input);
		f.transports[0].record({
			type: "view_terminal",
			instanceId: "a",
			generation: "g-a",
			sequence: 1,
			reason: "deleted",
		});
		expect(f.controller.selected()).toBeUndefined();
		expect(f.controller.exportState().drafts.a).toBeUndefined();
		expect(f.controller.draft()).toEqual({ text: "", images: [] });
		expect(f.client.stop).not.toHaveBeenCalled();
		f.controller.dispose();
	});
	it("disconnect/reconnect replaces snapshot generation", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		const old = f.transports[0];
		old.disconnect(new Error("socket gone"));
		f.generations.set("a", "new-generation");
		const projection = createViewProjection();
		projection.partial = assistant("fresh partial");
		projection.running = true;
		projection.activity = "working";
		f.overrides.set("a", { projection });
		expect(await f.controller.reconnect()).toBe(true);
		old.record({ type: "view_event", generation: "g-a", sequence: 1, event: { type: "agent_settled" } });
		expect(f.controller.selected()?.generation).toBe("new-generation");
		expect(f.controller.projection()?.partial?.content).toEqual([{ type: "text", text: "fresh partial" }]);
		expect(f.client.spawn).not.toHaveBeenCalled();
		f.controller.dispose();
	});
	it("accepted old-session prompt cannot clear newer drafts", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		const gate = deferred<RpcResponse>();
		f.send.mockImplementationOnce(() => gate.promise);
		const submitting = f.controller.submit(input);
		f.controller.setDraft({ text: "new edit", images: [] });
		await f.controller.select({ instanceId: "b" });
		f.controller.setDraft({ text: "b edit", images: [] });
		gate.resolve({ type: "response", command: "prompt", success: true });
		expect(await submitting).toBe("accepted");
		expect(f.controller.draft().text).toBe("b edit");
		await f.controller.select({ instanceId: "a" });
		expect(f.controller.draft().text).toBe("new edit");
		f.controller.dispose();
	});
	it("late acknowledgement and events never resurrect a forgotten selection", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		const gate = deferred<RpcResponse>();
		f.send.mockImplementationOnce(() => gate.promise);
		const submitting = f.controller.submit(input);
		f.controller.forget("a");
		gate.resolve({ type: "response", command: "prompt", success: true });
		await submitting;
		f.transports[0].record({
			type: "view_event",
			generation: "g-a",
			sequence: 1,
			event: { type: "message_end", message: assistant("late") },
		});
		expect(f.controller.selected()).toBeUndefined();
		expect(f.controller.exportState().drafts.a).toBeUndefined();
		f.controller.dispose();
	});
	it("duplicate sequences are ignored and gaps require explicit reconnect", async () => {
		const f = fixture();
		await f.controller.select({ instanceId: "a" });
		const event: ViewEvent = {
			type: "view_event",
			generation: "g-a",
			sequence: 1,
			event: { type: "message_end", message: assistant("one") },
		};
		f.transports[0].record(event);
		f.transports[0].record(event);
		expect(f.controller.projection()?.messages).toHaveLength(1);
		f.transports[0].record({ ...event, sequence: 3 });
		expect(f.controller.connectionState()).toBe("disconnected");
		f.transports[0].record({ ...event, sequence: 2 });
		expect(f.controller.projection()?.messages).toHaveLength(1);
		expect(f.client.spawn).not.toHaveBeenCalled();
		f.controller.dispose();
	});
});
