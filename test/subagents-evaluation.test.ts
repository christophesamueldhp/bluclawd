import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, EvaluationBudget, gradeFixture, passPowerK } from "../scripts/eval-subagents.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = (files: Record<string, string>) => {
	const dir = createFixture(files);
	dirs.push(dir);
	return dir;
};

describe("subagent evaluation guardrails", () => {
	it("reserves the shared parent/child allowance before starting another request", () => {
		const budget = new EvaluationBudget(1, 100, 1);
		budget.reserve(10, 0.1);
		expect(() => budget.reserve(1, 0)).toThrow(/request budget/);
	});

	it("holds the worst-case allowance until completion, then refunds only unused tokens and cost", () => {
		const budget = new EvaluationBudget(3, 100, 1);
		const settle = budget.reserve(80, 0.8);
		expect(() => budget.reserve(30, 0.1)).toThrow(/token budget/);
		settle(20, 0.2);
		expect(() => budget.reserve(30, 0.1)).not.toThrow();
		expect(() => settle(1, 0)).toThrow(/already settled/);
	});

	it("does not consume allowance when a token or cost reservation is rejected", () => {
		const budget = new EvaluationBudget(2, 100, 1);
		expect(() => budget.reserve(200, 0)).toThrow(/token budget/);
		expect(() => budget.reserve(1, 2)).toThrow(/cost budget/);
		expect(() => budget.reserve(100, 1)).not.toThrow();
	});

	it("rejects non-finite reservations instead of bypassing the limits", () => {
		const budget = new EvaluationBudget(2, 100, 1);
		expect(() => budget.reserve(Number.POSITIVE_INFINITY, 0)).toThrow(/Invalid/);
		expect(() => budget.reserve(1, Number.NaN)).toThrow(/Invalid/);
	});

	it("averages single-trial success and requires every repeated trial for pass^3", () => {
		const groups = [
			[true, true, true],
			[true, false, true],
		];
		expect(passPowerK(groups, 1)).toBeCloseTo(5 / 6);
		expect(passPowerK(groups, 3)).toBe(0.5);
		expect(passPowerK([[true, true]], 3)).toBeNull();
		expect(passPowerK([], 1)).toBeNull();
	});
});

const PACKAGE = JSON.stringify({ name: "fixture", private: true, type: "module" });
const testFile = (module: string, body: string) =>
	`import { test } from "node:test";\nimport assert from "node:assert/strict";\n${module}\n${body}\n`;
const OVERLAP_FILES = {
	"package.json": PACKAGE,
	"src/util.js": "export function round(value) {\n\treturn Math.round(value);\n}\n",
	"test/existing.test.js": testFile(
		'import { round } from "../src/util.js";',
		'test("round", () => assert.equal(round(1.6), 2));',
	),
};
const CLAMP = "export function clamp(value, min, max) {\n\treturn Math.min(max, Math.max(min, value));\n}\n";
const PERCENT =
	"export function percent(part, total) {\n\treturn clamp(Math.round((part / total) * 100), 0, 100);\n}\n";
const BAR =
	'export function progressBar(ratio, width) {\n\tconst filled = Math.round(clamp(ratio, 0, 1) * width);\n\treturn "#".repeat(filled) + "-".repeat(width - filled);\n}\n';
const PERCENT_TEST = testFile(
	'import { percent } from "../src/percent.js";',
	'test("percent", () => assert.equal(percent(1, 4), 25));',
);
const BAR_TEST = testFile(
	'import { progressBar } from "../src/bar.js";',
	'test("bar", () => assert.equal(progressBar(0.5, 4), "##--"));',
);
const DURATION_FILES = {
	"package.json": PACKAGE,
	"src/duration.js": "export function parseDuration(text) {\n\treturn Number(text.replace('s', ''));\n}\n",
	"test/duration.test.js": testFile(
		'import { parseDuration } from "../src/duration.js";',
		'test("seconds", () => assert.equal(parseDuration("5s"), 5));\ntest("minutes", () => assert.equal(parseDuration("2m"), 120));',
	),
};

describe("Ticket #15 — Grading uses the fixture's tests and final tree", () => {
	it("grades an optimistic run whose fixture tests still fail as incorrect", () => {
		const cwd = fixture(DURATION_FILES);
		const grade = gradeFixture(cwd, ["parseDuration"]);
		expect(grade).toMatchObject({ correct: false, passed: 1, failed: 1, duplicates: [], missing: [] });
	});

	it("flags a helper implemented twice even when every test passes", () => {
		const cwd = fixture({
			...OVERLAP_FILES,
			"src/percent.js": `${CLAMP}${PERCENT}`,
			"src/bar.js": `${CLAMP}${BAR}`,
			"test/percent.test.js": PERCENT_TEST,
			"test/bar.test.js": BAR_TEST,
		});
		const grade = gradeFixture(cwd, ["clamp", "percent", "progressBar"]);
		expect(grade).toMatchObject({ correct: false, failed: 0, duplicates: ["clamp"] });
	});
});
