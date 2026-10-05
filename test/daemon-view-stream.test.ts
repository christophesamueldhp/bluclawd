import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewEvent, ViewTerminal } from "../daemon/view-types.ts";
import { FakeViewChild } from "./support/fake-view-child.ts";
import { assistant, textDelta } from "./support/view-fixtures.ts";

vi.mock("../daemon/rpc-process.ts", () => ({
	createRpcProcessInstance: (opts: { sessionFile?: string }) => new FakeViewChild(opts),
}));
const { ServerSupervisor } = await import("../daemon/supervisor.ts");
let dir: string;
let supervisor: InstanceType<typeof ServerSupervisor>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "view-stream-"));
	vi.stubEnv("PI_SERVER_DIR", dir);
	FakeViewChild.children = [];
	supervisor = new ServerSupervisor();
});
afterEach(async () => {
	await supervisor.shutdown();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
describe("daemon persistent view streams", () => {
	it("attach returns existing partial and active tools", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir });
		const child = FakeViewChild.children[0];
		child.emit({ type: "agent_start" });
		child.emit({ type: "message_start", message: assistant("") });
		child.emit(textDelta("earlier"));
		child.emit({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "sleep 10" } });
		const a = supervisor.openViewStream(row.id, () => {})!;
		expect(a.ready.projection.partial?.content).toEqual([{ type: "text", text: "earlier" }]);
		expect(a.ready.projection.tools.tool.toolName).toBe("bash");
		expect(a.ready.state.isStreaming).toBe(true);
		a.close();
		expect(child.disposed).toBe(false);
	});
	it("snapshot watermark has no gaps and snapshots stay immutable", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir });
		const events: Array<ViewEvent | ViewTerminal> = [];
		const a = supervisor.openViewStream(row.id, (e) => events.push(e))!;
		FakeViewChild.children[0].emit({ type: "agent_start" });
		expect(events[0].sequence).toBe(a.ready.sequence + 1);
		expect(a.ready.projection.activity).toBe("idle");
		a.close();
	});
	it("detach keeps child alive without submitting a continuation", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir });
		const child = FakeViewChild.children[0];
		for (let i = 0; i < 5; i++) {
			supervisor.openViewStream(row.id, () => {})!.close();
		}
		expect(child.disposed).toBe(false);
		expect(child.sent.map((c) => c.type)).toEqual(["get_state"]);
	});
	it("two viewers receive dialogs and only first matching answer succeeds", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir });
		const left: Array<ViewEvent | ViewTerminal> = [];
		const right: Array<ViewEvent | ViewTerminal> = [];
		const a = supervisor.openViewStream(row.id, (e) => left.push(e))!;
		const b = supervisor.openViewStream(row.id, (e) => right.push(e))!;
		FakeViewChild.children[0].ui({
			type: "extension_ui_request",
			method: "confirm",
			id: "q",
			title: "allow?",
			message: "tool",
		});
		expect(left).toHaveLength(1);
		expect(right).toHaveLength(1);
		expect(a.handleUiResponse({ type: "extension_ui_response", id: "q", confirmed: true })).toBe(true);
		expect(b.handleUiResponse({ type: "extension_ui_response", id: "q", confirmed: false })).toBe(false);
		expect(supervisor.getPendingNeeds(row.id)).toBeUndefined();
		expect(FakeViewChild.children[0].answered).toHaveLength(1);
		a.close();
		b.close();
	});
	it("compaction and retries survive reattach and preserve pending questions", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir });
		const child = FakeViewChild.children[0];
		child.emit({ type: "agent_start" });
		child.emit({ type: "agent_end", messages: [], willRetry: true });
		child.emit({ type: "compaction_start", reason: "threshold" });
		child.ui({ type: "extension_ui_request", method: "input", id: "q", title: "answer" });
		const a = supervisor.openViewStream(row.id, () => {})!;
		expect(a.ready.projection.compacting).toBe(true);
		expect(a.ready.projection.pendingDialog?.id).toBe("q");
		a.close();
		expect(supervisor.getPendingNeeds(row.id)?.requestId).toBe("q");
	});
	it("unexpected exit sends a terminal failure to every viewer", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir });
		const events: Array<ViewEvent | ViewTerminal> = [];
		supervisor.openViewStream(row.id, (e) => events.push(e));
		FakeViewChild.children[0].crash();
		await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "view_terminal", reason: "failed" }));
	});
});
