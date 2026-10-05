import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentView from "../ext/agent-view/index.ts";
import {
	bootstrapManagedSession,
	type ManagedUiState,
	managedUiRef,
	type ReplacedSessionContext,
} from "../ext/agent-view/managed-state.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	managedUiRef.set({ phase: "native", drafts: {}, pendingInput: [] });
	vi.restoreAllMocks();
});
function state(): ManagedUiState {
	return { phase: "native", drafts: {}, pendingInput: [] };
}
function context(saved = true) {
	const dir = mkdtempSync(join(tmpdir(), "view-bootstrap-"));
	dirs.push(dir);
	const file = join(dir, "native.jsonl");
	if (saved) writeFileSync(file, "saved transcript");
	let disposed = false;
	const fresh = { cwd: dir } as ReplacedSessionContext;
	const ctx = {
		cwd: dir,
		mode: "tui",
		model: { provider: "test", id: "model" },
		isIdle: () => true,
		abort: vi.fn(),
		waitForIdle: vi.fn(async () => {}),
		sessionManager: {
			getSessionFile: () => file,
			getCwd: () => dir,
			getEntries: () => (saved ? [{ type: "message", message: { role: "user", content: "task" } }] : []),
		},
		newSession: vi.fn(async (options: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> }) => {
			disposed = true;
			await options.withSession?.(fresh);
			return { cancelled: false };
		}),
	} as unknown as ExtensionCommandContext;
	return { ctx, file, fresh, disposed: () => disposed };
}
describe("safe native bootstrap", () => {
	it("saved native writer disposed before child starts", async () => {
		const f = context();
		const start = vi.fn(async (fresh: ReplacedSessionContext, target) => {
			expect(f.disposed()).toBe(true);
			expect(fresh).toBe(f.fresh);
			expect(target).toEqual({ sessionFile: f.file, cwd: f.ctx.cwd, model: { provider: "test", id: "model" } });
		});
		const s = state();
		expect(await bootstrapManagedSession(f.ctx, s, start)).toEqual({ cancelled: false });
		expect(start).toHaveBeenCalledOnce();
		expect(s.phase).toBe("managed");
		expect(f.ctx.abort).not.toHaveBeenCalled();
	});
	it("legacy working migration waits without abort", async () => {
		const f = context();
		let finish!: () => void;
		f.ctx.isIdle = () => false;
		f.ctx.waitForIdle = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const start = vi.fn(async () => {});
		const running = bootstrapManagedSession(f.ctx, state(), start);
		expect(f.ctx.newSession).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(f.ctx.abort).not.toHaveBeenCalled();
		finish();
		await running;
		expect(start).toHaveBeenCalledOnce();
	});
	it("cancelled replacement starts no child", async () => {
		const f = context();
		f.ctx.newSession = vi.fn(async () => ({ cancelled: true }));
		const start = vi.fn(async () => {});
		const s = state();
		expect(await bootstrapManagedSession(f.ctx, s, start)).toEqual({ cancelled: true });
		expect(start).not.toHaveBeenCalled();
		expect(s.phase).toBe("native");
	});
	it("cancellation while waiting starts no replacement", async () => {
		const f = context();
		let finish!: () => void;
		f.ctx.isIdle = () => false;
		f.ctx.waitForIdle = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const s = state();
		const start = vi.fn(async () => {});
		const running = bootstrapManagedSession(f.ctx, s, start);
		s.phase = "native";
		finish();
		expect(await running).toEqual({ cancelled: true });
		expect(f.ctx.newSession).not.toHaveBeenCalled();
	});
	it("blank host produces no child target", async () => {
		const f = context(false);
		const start = vi.fn(async (_fresh: ReplacedSessionContext, _target?: unknown) => {});
		await bootstrapManagedSession(f.ctx, state(), start);
		expect(start.mock.calls[0]?.[1]).toBeUndefined();
	});
	it("factory starts no resources", () => {
		const on = vi.fn();
		const sendUserMessage = vi.fn();
		agentView({ on, registerCommand: vi.fn(), sendUserMessage } as unknown as ExtensionAPI);
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(on).toHaveBeenCalledWith("input", expect.any(Function));
	});
	it("RPC children never bootstrap", () => {
		const handlers = new Map<string, Function>();
		const sendUserMessage = vi.fn();
		agentView({
			on: (name: string, handler: Function) => handlers.set(name, handler),
			registerCommand: vi.fn(),
			sendUserMessage,
		} as unknown as ExtensionAPI);
		handlers.get("session_start")!({}, { mode: "rpc", ui: { theme: {} } });
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(managedUiRef.get().phase).toBe("native");
	});
});
