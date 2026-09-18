import { describe, expect, it, vi } from "vitest";
import {
	countingPrompt,
	createToolBudgetExtension,
	createToolTimer,
	DEFAULT_BUDGET_BLOCK,
	parseToolBudget,
} from "../ext/subagents/limits.ts";

describe("parseToolBudget", () => {
	it("needs a positive hard limit, and defaults the block list to the read/search tools", () => {
		expect(parseToolBudget(undefined)).toBeUndefined();
		expect(parseToolBudget({ soft: 3 })).toBeUndefined();
		expect(parseToolBudget({ hard: 0 })).toBeUndefined();
		expect(parseToolBudget({ hard: 10 })).toEqual({ hard: 10, block: DEFAULT_BUDGET_BLOCK });
	});

	it("keeps a soft limit only at or below hard, and accepts * or a list for block", () => {
		expect(parseToolBudget({ soft: 12, hard: 10 })).toEqual({ hard: 10, block: DEFAULT_BUDGET_BLOCK });
		expect(parseToolBudget({ soft: 5, hard: 10, block: "*" })).toEqual({ soft: 5, hard: 10, block: "*" });
		expect(parseToolBudget({ hard: 2, block: ["Read", " bash "] })?.block).toEqual(["read", "bash"]);
	});
});

/** Registers an extension against a recorder and hands back its handlers. */
function load(ext: any) {
	const handlers: Record<string, (event: any, ctx?: any) => Promise<any>> = {};
	ext.factory({
		on: (name: string, fn: any) => {
			handlers[name] = fn;
		},
	});
	return handlers;
}

describe("createToolBudgetExtension", () => {
	const call = (h: ReturnType<typeof load>, toolName: string) => h.tool_call({ toolName, input: {} });

	it("refuses block-listed tools past hard, and lets the others through", async () => {
		const h = load(createToolBudgetExtension({ hard: 2, block: ["read"] }));
		expect(await call(h, "read")).toBeUndefined();
		expect(await call(h, "bash")).toBeUndefined();
		expect((await call(h, "read"))?.block).toBe(true);
		expect(await call(h, "edit")).toBeUndefined();
	});

	it("never counts contact_supervisor or task", async () => {
		const h = load(createToolBudgetExtension({ hard: 1, block: "*" }));
		await call(h, "contact_supervisor");
		await call(h, "task");
		expect(await call(h, "read")).toBeUndefined();
		expect((await call(h, "read"))?.block).toBe(true);
	});

	it("appends the soft nudge to one tool result only", async () => {
		const h = load(createToolBudgetExtension({ soft: 1, hard: 5, block: "*" }));
		await call(h, "read");
		const first = await h.tool_result({ content: [{ type: "text", text: "file" }] });
		expect(first.content).toHaveLength(2);
		expect(first.content[1].text).toContain("Tool budget");
		await call(h, "read");
		expect(await h.tool_result({ content: [] })).toBeUndefined();
	});
});

describe("countingPrompt", () => {
	it("counts questions while they are open, including ones that throw", async () => {
		const open = { count: 0 };
		let release: (v: boolean) => void = () => {};
		const wrapped = countingPrompt(
			() =>
				new Promise<boolean>((r) => {
					release = r;
				}),
			open,
		);
		const pending = wrapped?.({ title: "t", message: "m" });
		expect(open.count).toBe(1);
		release(true);
		await pending;
		expect(open.count).toBe(0);
		const failing = countingPrompt(() => Promise.reject(new Error("x")), open);
		await expect(failing?.({ title: "t", message: "m" })).rejects.toThrow("x");
		expect(open.count).toBe(0);
		expect(countingPrompt(undefined, open)).toBeUndefined();
	});
});

describe("createToolTimer", () => {
	it("fires for a call that outlives the limit, not for one that ended", () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			const timer = createToolTimer({ ms: 100, paused: () => false, onTimeout });
			timer.start("a", "bash");
			timer.start("b", "read");
			timer.end("b");
			vi.advanceTimersByTime(100);
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(onTimeout).toHaveBeenCalledWith("bash");
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-arms instead of firing while a permission question is open", () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			let paused = true;
			const timer = createToolTimer({ ms: 100, paused: () => paused, onTimeout });
			timer.start("a", "bash");
			vi.advanceTimersByTime(350);
			expect(onTimeout).not.toHaveBeenCalled();
			paused = false;
			vi.advanceTimersByTime(100);
			expect(onTimeout).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never times contact_supervisor or a nested task call, and clear stops everything", () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			const timer = createToolTimer({ ms: 10, paused: () => false, onTimeout });
			timer.start("a", "contact_supervisor");
			timer.start("b", "task");
			timer.start("c", "bash");
			timer.clear();
			vi.advanceTimersByTime(100);
			expect(onTimeout).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
