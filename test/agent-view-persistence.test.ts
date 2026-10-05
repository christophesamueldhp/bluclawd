import { describe, expect, it } from "vitest";
import { CONTINUE_PROMPT } from "../ext/agent-view/hand-off.ts";
import { probePersistentSessionViews, withPersistentViewHarness } from "../scripts/probe-persistent-session-views.ts";

describe("real subprocess persistent views", () => {
	it("A B A during gated tool preserves real pid and runs once", async () => {
		const result = await probePersistentSessionViews({});
		expect(result).toEqual({
			pidStable: true,
			toolExecutions: 1,
			deletedRowAbsent: true,
			transcriptPreserved: true,
			childToolsLoaded: true,
		});
	}, 30_000);
	it("terminal disconnect preserves active work", async () => {
		await withPersistentViewHarness(async (h) => {
			await h.controller.select({ instanceId: h.a.id });
			await h.controller.submit({ text: "gated", images: [] });
			await h.wait(() => !!h.controller.projection()?.tools.gate);
			const pid = await h.pid(h.a.id);
			h.controller.dispose();
			const next = h.newController();
			await next.select({ instanceId: h.a.id });
			expect(await h.pid(h.a.id)).toBe(pid);
			expect(next.projection()?.tools.gate).toBeDefined();
		});
	});
	it("reattach recovers earlier partial and pending dialog", async () => {
		await withPersistentViewHarness(async (h) => {
			await h.controller.select({ instanceId: h.a.id });
			await h.controller.submit({ text: "question", images: [] });
			await h.wait(() => !!h.controller.projection()?.pendingDialog);
			const before = h.controller.projection()?.partial?.content;
			await h.controller.select({ instanceId: h.b.id });
			await h.controller.select({ instanceId: h.a.id });
			expect(h.controller.projection()?.partial?.content).toEqual(before);
			expect(h.controller.projection()?.pendingDialog?.id).toBe("pending-request");
			expect(
				await h.controller.answer({ type: "extension_ui_response", id: "pending-request", value: "answer" }),
			).toBe(true);
		});
	});
	it("delete current blanks view and leaves other pid alive", async () => {
		await withPersistentViewHarness(async (h) => {
			await h.controller.select({ instanceId: h.a.id });
			const otherPid = await h.pid(h.b.id);
			await h.client.delete(h.a.id);
			await h.wait(() => h.controller.selected() === undefined);
			expect(h.controller.draft()).toEqual({ text: "", images: [] });
			expect(await h.pid(h.b.id)).toBe(otherPid);
		});
	});
	it("late metadata cannot resurrect row", async () => {
		await withPersistentViewHarness(async (h) => {
			await h.controller.select({ instanceId: h.a.id });
			await h.controller.submit({ text: "gated", images: [] });
			await h.wait(() => !!h.controller.projection()?.tools.gate);
			await h.client.delete(h.a.id);
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect((await h.client.list()).some((row) => row.id === h.a.id)).toBe(false);
		});
	});
	it("explicit resume does not automatically prompt", async () => {
		await withPersistentViewHarness(async (h) => {
			await h.controller.select({ instanceId: h.a.id });
			await h.controller.submit({ text: "gated", images: [] });
			await h.wait(() => !!h.controller.projection()?.tools.gate);
			const file = h.controller.selected()!.state.sessionFile!;
			await h.client.delete(h.a.id);
			await h.controller.select({ sessionFile: file, cwd: h.dir });
			const messages = await h.commands();
			expect(messages).not.toContain(CONTINUE_PROMPT);
			expect(messages).toEqual([]);
		});
	});
});
