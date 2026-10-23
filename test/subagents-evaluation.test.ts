import { describe, expect, it } from "vitest";
import { EvaluationBudget, gradeScenario, passPowerK } from "../scripts/eval-subagents.ts";

describe("live subagent evaluation guardrails", () => {
	it("reserves the shared parent/child allowance before starting another request", () => {
		const budget = new EvaluationBudget(2, 100, 1);
		budget.reserve(40, 0.3);
		budget.reserve(60, 0.7);
		expect(() => budget.reserve(1, 0)).toThrow(/request budget/);
	});

	it("holds the worst-case allowance until completion, then refunds only unused tokens and cost", () => {
		const budget = new EvaluationBudget(3, 100, 1);
		const settle = budget.reserve(90, 0.9);
		expect(() => budget.reserve(20, 0.2)).toThrow(/token budget/);
		settle(10, 0.1);
		budget.reserve(90, 0.9);
		expect(() => settle(0, 0)).toThrow(/already settled/);
		expect(() => budget.reserve(1, 0)).toThrow(/token budget/);
	});

	it("does not consume allowance when a token or cost reservation is rejected", () => {
		const budget = new EvaluationBudget(3, 100, 1);
		expect(() => budget.reserve(101, 0)).toThrow(/token budget/);
		expect(() => budget.reserve(10, 1.01)).toThrow(/cost budget/);
		budget.reserve(100, 1);
	});

	it("rejects non-finite reservations instead of bypassing the limits", () => {
		const budget = new EvaluationBudget(2, 100, 1);
		expect(() => budget.reserve(Number.NaN, 0)).toThrow();
		expect(() => budget.reserve(10, Number.POSITIVE_INFINITY)).toThrow();
		expect(() => budget.reserve(-1, 0)).toThrow();
	});

	it("averages single-trial success and requires every repeated trial for pass^3", () => {
		expect(
			passPowerK(
				[
					[true, true, true],
					[true, false, true],
				],
				1,
			),
		).toBeCloseTo(5 / 6);
		expect(
			passPowerK(
				[
					[true, true, true],
					[true, false, true],
				],
				3,
			),
		).toBe(0.5);
		expect(passPowerK([[true, true]], 3)).toBeNull();
		expect(passPowerK([], 1)).toBeNull();
	});

	it("fails grading on provider failure, missing evidence, or a leaked synthetic canary", () => {
		const rule = { expected: /correct answer/i, forbidden: ["SYNTHETIC_CANARY"] };
		expect(gradeScenario(rule, "Correct answer", "stop")).toBe(true);
		expect(gradeScenario(rule, "Correct answer", "error")).toBe(false);
		expect(gradeScenario(rule, "Correct answer", "length")).toBe(false);
		expect(gradeScenario(rule, "Something else", "stop")).toBe(false);
		expect(gradeScenario(rule, "Correct answer SYNTHETIC_CANARY", "stop")).toBe(false);
	});
});
