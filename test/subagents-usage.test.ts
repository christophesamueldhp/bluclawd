import { describe, expect, it } from "vitest";
import { createEmptySubagentUsage, createGenerationUsage, toPiToolUsage } from "../ext/subagents/usage.ts";

const turn = {
	input: 10,
	output: 5,
	totalTokens: 15,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
const nested = { input: 1000, totalTokens: 1000 };

describe("generation usage", () => {
	it("leaves nested usage before the foreground result to the SDK and settles into the tool result", () => {
		const usage = createGenerationUsage({ kind: "foreground" });
		usage.addTurn(turn);
		usage.addNested(nested);
		usage.addTurn(turn);

		expect(usage.settle()).toBe("tool_result");
		expect(usage.totals.totalTokens).toBe(30);
		expect(usage.totals.cost.total).toBeCloseTo(0.6);
	});

	it("settles a foreground generation into the ledger when its result was emitted first", () => {
		const usage = createGenerationUsage({ kind: "foreground" });
		usage.addTurn(turn);
		usage.launchResultEmitted();
		usage.addNested(nested);

		expect(usage.settle()).toBe("ledger");
		expect(usage.totals.totalTokens).toBe(1015);
	});

	it("counts a background launch's nested usage only after its started result is emitted", () => {
		const usage = createGenerationUsage({ kind: "background" });
		usage.addNested(nested);
		usage.launchResultEmitted();
		usage.addNested(nested);
		usage.addTurn(turn);

		expect(usage.settle()).toBe("ledger");
		expect(usage.totals.totalTokens).toBe(1015);
	});

	it("settles a background launch into the ledger even before its started result is emitted", () => {
		const usage = createGenerationUsage({ kind: "background" });
		usage.addTurn(turn);

		expect(usage.settle()).toBe("ledger");
		expect(usage.totals.totalTokens).toBe(15);
	});

	it("counts a resumed generation's nested usage from the start", () => {
		const usage = createGenerationUsage({ kind: "resume" });
		usage.addNested(nested);
		usage.addTurn(turn);

		expect(usage.settle()).toBe("ledger");
		expect(usage.totals.totalTokens).toBe(1015);
	});

	it("labels unpriced usage unknown", () => {
		const usage = createGenerationUsage({ kind: "resume" });
		usage.addTurn({ ...turn, hasUnknownCost: true });
		usage.addTurn(turn);

		expect(usage.totals.hasUnknownCost).toBe(true);
	});

	it("hands out totals that later usage does not change", () => {
		const usage = createGenerationUsage({ kind: "resume" });
		usage.addTurn(turn);
		const before = usage.totals;
		usage.addTurn(turn);

		expect(before.totalTokens).toBe(15);
	});
});

describe("toPiToolUsage", () => {
	it("maps subagent usage into pi's tool usage shape", () => {
		const totals = {
			...createEmptySubagentUsage(),
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			hasUnknownCost: true,
		};

		expect(toPiToolUsage(totals)).toEqual({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		});
	});
});
