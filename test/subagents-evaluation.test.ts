import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	createFixture,
	EvaluationBudget,
	gradeFixture,
	passPowerK,
	readSessionSummary,
	summarizePiEvents,
} from "../scripts/eval-subagents.ts";
import { createParentSessionWithSubagents } from "./helpers/subagent-session.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = (files: Record<string, string>) => {
	const dir = createFixture(files);
	dirs.push(dir);
	return dir;
};
const scratch = () => fixture({ ".keep": "" });

describe("live subagent evaluation guardrails", () => {
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

	it("reads the session, orchestrator messages and parent-attributed usage from a pi event stream", () => {
		const events = [
			{ type: "session", id: "sess_1" },
			{ type: "tool_execution_start", toolName: "subagent" },
			{ type: "tool_execution_start", toolName: "subagent" },
			{ type: "tool_execution_start", toolName: "subagent_message" },
			{ type: "message_end", message: { role: "assistant", usage: { totalTokens: 10, cost: { total: 0.01 } } } },
			{ type: "message_end", message: { role: "toolResult", usage: { totalTokens: 90, cost: { total: 0.09 } } } },
		]
			.map((event) => JSON.stringify(event))
			.join("\n");
		const summary = summarizePiEvents(`${events}\nnot json`);
		expect(summary).toMatchObject({ sessionId: "sess_1", spawns: 2, orchestratorMessages: 1, tokens: 100 });
		expect(summary.cost).toBeCloseTo(0.1);
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
const FIXED_DURATION =
	"const UNITS = { s: 1, m: 60, h: 3600 };\nexport function parseDuration(text) {\n\treturn Number(text.slice(0, -1)) * UNITS[text.at(-1)];\n}\n";

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

type Reply =
	| ReturnType<typeof fauxAssistantMessage>
	| ((context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>);

const transcriptText = (context: TranscriptContext) => JSON.stringify(context.messages);
const isChild = (context: TranscriptContext) => {
	const system = context.messages.find((message) => message.role === "system");
	return system?.role === "system" && getSystemMessageText(system).includes("operating in a fresh context");
};
/** The marker that starts the child's own task; sibling tasks appear later in its roster. */
const childMarker = (context: TranscriptContext) => {
	for (const message of context.messages) {
		if (message.role !== "user") continue;
		const marker = JSON.stringify(message.content).match(/^"?(?:\[\{"type":"text","text":")?\[([a-z]+)\]/)?.[1];
		if (marker) return marker;
	}
	return undefined;
};

/** One faux responder for the orchestrator's replies and each child's script, keyed by its task marker. */
function scripted(
	parent: Reply[],
	children: Record<string, (context: TranscriptContext, step: number) => ReturnType<typeof fauxAssistantMessage>>,
) {
	let parentStep = 0;
	const childSteps: Record<string, number> = {};
	return Array.from({ length: 80 }, () => (context: TranscriptContext) => {
		if (isChild(context)) {
			const marker = childMarker(context);
			if (!marker || !children[marker]) return fauxAssistantMessage("Unscripted child.");
			childSteps[marker] = (childSteps[marker] ?? 0) + 1;
			return children[marker](context, childSteps[marker]);
		}
		const reply = parent[parentStep++];
		if (!reply) return fauxAssistantMessage("Orchestrator idle.");
		return typeof reply === "function" ? reply(context) : reply;
	});
}
const write = (path: string, content: string) => fauxToolCall("write", { path, content });
const bash = (command: string) => fauxToolCall("bash", { command });
const spawn = (name: string, task: string, extra: Record<string, unknown> = {}) =>
	fauxToolCall("subagent", { agent: "general-purpose", name, task: `[${name}] ${task}`, ...extra });
const say = (to: string, content: string) => fauxToolCall("subagent_message", { to, content });

async function runOrchestration(options: {
	files: Record<string, string>;
	script: ReturnType<typeof scripted>;
	extensions?: ExtensionFactory[];
}) {
	const cwd = fixture(options.files);
	const agentDir = scratch();
	const { session, faux } = await createParentSessionWithSubagents({
		cwd,
		agentDir,
		builtinTools: ["read", "write", "edit", "bash"],
		extensions: options.extensions,
	});
	await session.bindExtensions({ mode: "rpc" });
	faux.setResponses(options.script);
	const started = performance.now();
	await session.prompt("Run the scenario.", { expandPromptTemplates: false });
	return { cwd, agentDir, session, faux, elapsedMs: performance.now() - started };
}

describe("Ticket #15 — Orchestrated acceptance scenarios on a shared fixture checkout", () => {
	it("resolves an overlapping utility edit by explicit handoff: correct, one clamp, both messages logged", async () => {
		let handedOff = false;
		let barWrote = false;
		const run = await runOrchestration({
			files: OVERLAP_FILES,
			script: scripted(
				[
					fauxAssistantMessage([
						spawn("percent", "Add percent in src/percent.js with tests; you own src/util.js and its clamp."),
						spawn("bar", "Add progressBar in src/bar.js with tests; ask percent for clamp, do not write it."),
					]),
					fauxAssistantMessage([bash("node --test test/")]),
					fauxAssistantMessage("Both done; tests pass."),
				],
				{
					percent: (context, step) => {
						if (step === 1)
							return fauxAssistantMessage([
								write(
									"src/util.js",
									`export function round(value) {\n\treturn Math.round(value);\n}\n${CLAMP}`,
								),
								write("src/percent.js", `import { clamp } from "./util.js";\n${PERCENT}`),
								write("test/percent.test.js", PERCENT_TEST),
							]);
						if (!transcriptText(context).includes("REQUEST-CLAMP"))
							return fauxAssistantMessage([bash("sleep 0.05")]);
						if (!handedOff) {
							handedOff = true;
							return fauxAssistantMessage([say("bar", "HANDOFF-CLAMP: clamp is exported from src/util.js")]);
						}
						return fauxAssistantMessage("percent done.");
					},
					bar: (context, step) => {
						if (step === 1)
							return fauxAssistantMessage([
								say("percent", "REQUEST-CLAMP: please export clamp from src/util.js"),
							]);
						if (!transcriptText(context).includes("HANDOFF-CLAMP"))
							return fauxAssistantMessage([bash("sleep 0.05")]);
						if (!barWrote) {
							barWrote = true;
							return fauxAssistantMessage([
								write("src/bar.js", `import { clamp } from "./util.js";\n${BAR}`),
								write("test/bar.test.js", BAR_TEST),
							]);
						}
						return fauxAssistantMessage("bar done.");
					},
				},
			),
		});
		try {
			const grade = gradeFixture(run.cwd, ["clamp", "percent", "progressBar"]);
			expect(grade).toMatchObject({ correct: true, failed: 0, duplicates: [], missing: [] });
			expect([...grade.changedFiles].sort()).toEqual([
				"src/bar.js",
				"src/percent.js",
				"src/util.js",
				"test/bar.test.js",
				"test/percent.test.js",
			]);
			const summary = readSessionSummary(run.agentDir, run.session.sessionId);
			expect(summary.messages).toEqual([
				{ from: "bar", to: "percent", status: "accepted" },
				{ from: "percent", to: "bar", status: "accepted" },
			]);
			expect(summary.runs.map((r) => [r.name, r.status]).sort()).toEqual([
				["bar", "completed"],
				["percent", "completed"],
			]);
			for (const r of summary.runs) {
				expect(r.tokens).toBeGreaterThan(0);
				expect(r.ms).toBeGreaterThanOrEqual(0);
			}
		} finally {
			run.session.dispose();
		}
	});
});

describe("Ticket #15 — Failure, denial, cancellation and disposal scenarios", () => {
	it("reports a failing shell run to the orchestrator, repairs it, and a reviewer adds no implementation", async () => {
		const run = await runOrchestration({
			files: DURATION_FILES,
			script: scripted(
				[
					fauxAssistantMessage([spawn("fixer", "Make npm test pass by fixing src/duration.js.")]),
					fauxAssistantMessage([
						fauxToolCall("subagent", {
							agent: "reviewer",
							name: "review",
							task: "[review] Review src/duration.js without editing.",
						}),
					]),
					fauxAssistantMessage([bash("node --test test/")]),
					fauxAssistantMessage("Fixed and reviewed."),
				],
				{
					fixer: (context, step) => {
						if (step === 1) return fauxAssistantMessage([bash("node --test test/")]);
						if (step === 2)
							return fauxAssistantMessage([say("parent", "node --test fails: minutes are not parsed.")]);
						if (step === 3) return fauxAssistantMessage([write("src/duration.js", FIXED_DURATION)]);
						if (step === 4) return fauxAssistantMessage([bash("node --test test/")]);
						return fauxAssistantMessage(
							transcriptText(context).includes("fail 0") ? "Fixed; tests pass." : "Still failing.",
						);
					},
					review: (_context, step) =>
						step === 1
							? fauxAssistantMessage([fauxToolCall("read", { path: "src/duration.js" })])
							: fauxAssistantMessage("No actionable issues."),
				},
			),
		});
		try {
			const grade = gradeFixture(run.cwd, ["parseDuration"]);
			expect(grade).toMatchObject({ correct: true, failed: 0, duplicates: [], changedFiles: ["src/duration.js"] });
			const summary = readSessionSummary(run.agentDir, run.session.sessionId);
			const fixer = summary.runs.find((r) => r.name === "fixer");
			const review = summary.runs.find((r) => r.name === "review");
			expect(fixer?.toolExecutions.bash).toEqual({ ok: 1, error: 1 });
			expect(Object.keys(review?.toolExecutions ?? {})).toEqual(["read"]);
			expect(summary.messages).toEqual([{ from: "fixer", to: "parent", status: "accepted" }]);
			expect(JSON.stringify(run.session.messages)).toContain("minutes are not parsed");
		} finally {
			run.session.dispose();
		}
	});

	it("keeps a parent-denied file untouched and lets the child report the denial", async () => {
		const denyLocked: ExtensionFactory = (pi) => {
			pi.on("tool_call", async (event) =>
				String((event.input as { path?: unknown }).path ?? "").endsWith("src/locked.js")
					? { block: true, reason: "Denied by permission rule" }
					: undefined,
			);
		};
		const run = await runOrchestration({
			files: { ...DURATION_FILES, "src/locked.js": "export const locked = true;\n" },
			extensions: [denyLocked],
			script: scripted(
				[fauxAssistantMessage([spawn("editor", "Edit src/locked.js.")]), fauxAssistantMessage("Reported.")],
				{
					editor: (context, step) => {
						if (step === 1)
							return fauxAssistantMessage([write("src/locked.js", "export const locked = false;\n")]);
						if (step === 2) return fauxAssistantMessage([say("parent", "Blocked: src/locked.js is denied.")]);
						return fauxAssistantMessage(
							transcriptText(context).includes("Denied by permission rule")
								? "Denied; reported."
								: "Unexpected.",
						);
					},
				},
			),
		});
		try {
			expect(readFileSync(join(run.cwd, "src/locked.js"), "utf8")).toBe("export const locked = true;\n");
			expect(gradeFixture(run.cwd, ["parseDuration"]).changedFiles).toEqual([]);
			const summary = readSessionSummary(run.agentDir, run.session.sessionId);
			expect(summary.runs[0]).toMatchObject({ status: "completed", toolExecutions: { write: { ok: 0, error: 1 } } });
			expect(summary.messages).toEqual([{ from: "editor", to: "parent", status: "accepted" }]);
		} finally {
			run.session.dispose();
		}
	});

	const waitFor = async (condition: () => boolean) => {
		for (let i = 0; i < 2000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(condition()).toBe(true);
	};
	const waiting = (name: string) => ({
		[name]: () => fauxAssistantMessage([bash("echo tick >> progress.log; sleep 0.05")]),
	});
	const background = (name: string) =>
		fauxAssistantMessage([
			spawn(name, "Wait for a message from the orchestrator before editing.", { background: true }),
		]);
	const ticks = (cwd: string) =>
		existsSync(join(cwd, "progress.log")) ? statSync(join(cwd, "progress.log")).size : 0;

	it("stops a child that is waiting for a message, and it does nothing afterwards", async () => {
		const run = await runOrchestration({
			files: DURATION_FILES,
			script: scripted([background("waiter"), fauxAssistantMessage("Launched.")], waiting("waiter")),
		});
		try {
			await waitFor(() => ticks(run.cwd) > 0);
			run.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent_stop", { agent: "waiter" })]),
				fauxAssistantMessage("Stopped."),
			]);
			await run.session.prompt("Stop it.", { expandPromptTemplates: false });
			await waitFor(() => readSessionSummary(run.agentDir, run.session.sessionId).runs[0]?.status === "cancelled");
			const after = ticks(run.cwd);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(ticks(run.cwd)).toBe(after);
			expect(readSessionSummary(run.agentDir, run.session.sessionId).runs[0]).toMatchObject({
				name: "waiter",
				status: "cancelled",
			});
		} finally {
			run.session.dispose();
		}
	});

	it("settles a running child when the orchestrator's session is disposed, with no write afterwards", async () => {
		const run = await runOrchestration({
			files: DURATION_FILES,
			script: scripted([background("racer"), fauxAssistantMessage("Launched.")], waiting("racer")),
		});
		await waitFor(() => ticks(run.cwd) > 0);
		const runId = readSessionSummary(run.agentDir, run.session.sessionId).runs[0]?.name;
		expect(runId).toBe("racer");
		run.session.dispose();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const after = ticks(run.cwd);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(ticks(run.cwd)).toBe(after);
		const status = readSessionSummary(run.agentDir, run.session.sessionId).runs[0]?.status;
		expect(["cancelled", "interrupted", "failed"]).toContain(status);
	});
});

describe("Ticket #15 — Single-agent and orchestrated runs on the same fixture", () => {
	const SLUG =
		'export function slugify(text) {\n\treturn text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n';
	const MEDIAN =
		'export function median(values) {\n\tif (values.length === 0) throw new Error("empty");\n\tconst s = [...values].sort((a, b) => a - b);\n\tconst m = Math.floor(s.length / 2);\n\treturn s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n}\n';
	const FILES = {
		"package.json": PACKAGE,
		"test/existing.test.js": testFile("", 'test("ok", () => assert.ok(true));'),
	};
	const SLUG_TEST = testFile(
		'import { slugify } from "../src/strings.js";',
		'test("slug", () => assert.equal(slugify(" Hi There! "), "hi-there"));',
	);
	const MEDIAN_TEST = testFile(
		'import { median } from "../src/math.js";',
		'test("median", () => assert.equal(median([3, 1, 2, 4]), 2.5));',
	);

	it("grades both modes from the final tree and reports their correctness, messages, elapsed time and usage", async () => {
		const single = await runOrchestration({
			files: FILES,
			script: scripted(
				[
					fauxAssistantMessage([
						write("src/strings.js", SLUG),
						write("test/strings.test.js", SLUG_TEST),
						write("src/math.js", MEDIAN),
						write("test/math.test.js", MEDIAN_TEST),
					]),
					fauxAssistantMessage("Done alone."),
				],
				{},
			),
		});
		const orchestrated = await runOrchestration({
			files: FILES,
			script: scripted(
				[
					fauxAssistantMessage([
						spawn("strings", "Add slugify with tests."),
						spawn("math", "Add median with tests."),
					]),
					fauxAssistantMessage("Done together."),
				],
				{
					strings: (_c, step) =>
						step === 1
							? fauxAssistantMessage([write("src/strings.js", SLUG), write("test/strings.test.js", SLUG_TEST)])
							: fauxAssistantMessage("strings done."),
					math: (_c, step) =>
						step === 1
							? fauxAssistantMessage([write("src/math.js", MEDIAN), write("test/math.test.js", MEDIAN_TEST)])
							: fauxAssistantMessage("math done."),
				},
			),
		});
		try {
			const report = [single, orchestrated].map((run) => {
				const summary = readSessionSummary(run.agentDir, run.session.sessionId);
				return {
					...gradeFixture(run.cwd, ["slugify", "median"]),
					runs: summary.runs.length,
					messages: summary.messages.length,
					elapsedMs: run.elapsedMs,
					childTokens: summary.runs.reduce((sum, r) => sum + r.tokens, 0),
				};
			});
			expect(report[0]).toMatchObject({ correct: true, duplicates: [], runs: 0, messages: 0, childTokens: 0 });
			expect(report[1]).toMatchObject({ correct: true, duplicates: [], runs: 2, messages: 0 });
			expect(report[1].childTokens).toBeGreaterThan(0);
			for (const row of report) expect(row.elapsedMs).toBeGreaterThan(0);
		} finally {
			single.session.dispose();
			orchestrated.session.dispose();
		}
	});
});

describe("Ticket #15 — The active subagent path does not reach the retained isolation code", () => {
	it("imports none of the snapshot, workspace, native-inspector or isolated-policy modules", () => {
		const seen = new Set<string>();
		const pending = ["ext/subagents/index.ts"];
		while (pending.length > 0) {
			const file = pending.pop() as string;
			if (seen.has(file)) continue;
			seen.add(file);
			for (const match of readFileSync(file, "utf8").matchAll(/from "(\.[^"]+)"/g)) {
				const target = normalize(join(dirname(file), match[1]));
				if (existsSync(target)) pending.push(target);
			}
		}
		for (const retained of [
			"ext/subagents/source-snapshot.ts",
			"ext/subagents/workspace.ts",
			"ext/subagents/native-inspector.ts",
			"ext/subagents/execution-policy.ts",
			"ext/subagents/preparation.ts",
		]) {
			expect(seen.has(retained), retained).toBe(false);
		}
	});
});
