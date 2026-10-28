import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSubagentsRootDir, readPersistedRunRecord } from "../ext/subagents/storage.ts";

/** The harness's own spend allowance for live trials; never a limit on production runs. */
export class EvaluationBudget {
	private requests = 0;
	private tokens = 0;
	private dollars = 0;
	private maxRequests: number;
	private maxTokens: number;
	private maxDollars: number;
	constructor(maxRequests: number, maxTokens: number, maxDollars: number) {
		this.maxRequests = maxRequests;
		this.maxTokens = maxTokens;
		this.maxDollars = maxDollars;
	}
	reserve(tokens: number, dollars: number): (actualTokens: number, actualDollars: number) => void {
		if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(dollars) || dollars < 0) {
			throw new Error("Invalid budget reservation");
		}
		if (this.requests + 1 > this.maxRequests) throw new Error("Evaluation request budget exhausted");
		if (this.tokens + tokens > this.maxTokens) throw new Error("Evaluation token budget exhausted");
		if (this.dollars + dollars > this.maxDollars) throw new Error("Evaluation cost budget exhausted");
		this.requests++;
		this.tokens += tokens;
		this.dollars += dollars;
		let settled = false;
		return (actualTokens, actualDollars) => {
			if (settled) throw new Error("Reservation already settled");
			if (!Number.isFinite(actualTokens) || actualTokens < 0 || !Number.isFinite(actualDollars) || actualDollars < 0)
				throw new Error("Invalid actual usage");
			settled = true;
			this.tokens += actualTokens - tokens;
			this.dollars += actualDollars - dollars;
		};
	}
}

export function passPowerK(groups: readonly (readonly boolean[])[], k: number): number | null {
	if (!Number.isInteger(k) || k < 1 || groups.length === 0 || groups.some((g) => g.length < k)) return null;
	if (k === 1) return groups.flat().filter(Boolean).length / groups.flat().length;
	return groups.filter((group) => group.slice(0, k).every(Boolean)).length / groups.length;
}

export interface FixtureTestRun {
	readonly passed: number;
	readonly failed: number;
}

/** Runs the fixture's own tests; a crash or no tests counts as failure. */
export function runFixtureTests(cwd: string): FixtureTestRun {
	const run = spawnSync(process.execPath, ["--test", "test/"], { cwd, encoding: "utf8", timeout: 120_000 });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	const count = (label: string) => Number(output.match(new RegExp(`^ℹ ${label} (\\d+)`, "m"))?.[1] ?? 0);
	const passed = count("pass");
	const failed = count("fail");
	return { passed, failed: run.status === 0 || failed > 0 ? failed : failed + 1 };
}

function sourceFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sourceFiles(join(dir, entry.name))
			: /\.[cm]?js$/.test(entry.name)
				? [join(dir, entry.name)]
				: [],
	);
}

/** Source files under `src/` that define each function, so a function written twice shows up. */
export function findImplementations(cwd: string, functions: readonly string[]): Record<string, string[]> {
	const files = sourceFiles(join(cwd, "src"));
	return Object.fromEntries(
		functions.map((name) => {
			const definition = new RegExp(`(function\\s+${name}\\s*\\(|(const|let|var)\\s+${name}\\s*=)`);
			return [
				name,
				files
					.filter((file) => definition.test(readFileSync(file, "utf8")))
					.map((file) => file.slice(cwd.length + 1)),
			];
		}),
	);
}

export interface FixtureGrade extends FixtureTestRun {
	/** Tests pass and every required function is implemented exactly once. */
	readonly correct: boolean;
	readonly duplicates: readonly string[];
	readonly missing: readonly string[];
	readonly changedFiles: readonly string[];
}

/** Grades a run from the final tree: the fixture's tests and its source, never the transcript. */
export function gradeFixture(cwd: string, requiredFunctions: readonly string[]): FixtureGrade {
	const tests = runFixtureTests(cwd);
	const implementations = findImplementations(cwd, requiredFunctions);
	const duplicates = requiredFunctions.filter((name) => implementations[name].length > 1);
	const missing = requiredFunctions.filter((name) => implementations[name].length === 0);
	const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
	const changedFiles = (status.stdout ?? "")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => line.slice(3));
	return {
		...tests,
		correct: tests.failed === 0 && tests.passed > 0 && duplicates.length === 0 && missing.length === 0,
		duplicates,
		missing,
		changedFiles,
	};
}

/** Creates a committed fixture repository from a map of relative paths to contents. */
export function createFixture(
	files: Readonly<Record<string, string>>,
	root = mkdtempSync(join(tmpdir(), "bluclawd-eval-")),
): string {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		["-c", "user.name=Evaluation", "-c", "user.email=evaluation@example.invalid", "commit", "-qm", "fixture"],
		{
			cwd: root,
		},
	);
	return root;
}

const PACKAGE = JSON.stringify({
	name: "fixture",
	private: true,
	type: "module",
	scripts: { test: "node --test test/" },
});
const testFile = (module: string, body: string) =>
	`import { test } from "node:test";\nimport assert from "node:assert/strict";\n${module}\n${body}\n`;

/** Live scenarios: each orchestrated prompt has a single-agent counterpart over the same fixture. */
export const LIVE_SCENARIOS = [
	{
		id: "independent",
		required: ["slugify", "median"],
		files: {
			"package.json": PACKAGE,
			"src/strings.js":
				"export function capitalize(text) {\n\treturn text.charAt(0).toUpperCase() + text.slice(1);\n}\n",
			"src/math.js": "export function sum(values) {\n\treturn values.reduce((a, b) => a + b, 0);\n}\n",
			"test/existing.test.js": testFile(
				'import { sum } from "../src/math.js";',
				'test("sum", () => assert.equal(sum([1, 2]), 3));',
			),
		},
		task: "Add and export slugify(text) in src/strings.js (lowercase, non-alphanumerics to single hyphens, no leading/trailing hyphens) with tests in test/strings.test.js, and add and export median(values) in src/math.js (average of the two middle values for even length, throw on empty) with tests in test/math.test.js.",
		split: "Delegate the two functions to two general-purpose subagents in one message, one per function, each owning its own source and test file.",
	},
	{
		id: "overlap",
		required: ["clamp", "percent", "progressBar"],
		files: {
			"package.json": PACKAGE,
			"src/util.js": "export function round(value) {\n\treturn Math.round(value);\n}\n",
			"test/existing.test.js": testFile(
				'import { round } from "../src/util.js";',
				'test("round", () => assert.equal(round(1.6), 2));',
			),
		},
		task: "Add percent(part, total) in src/percent.js and progressBar(ratio, width) in src/bar.js, each with tests in test/. Both need a shared clamp(value, min, max) helper exported from src/util.js; it must exist exactly once.",
		split: 'Delegate percent and progressBar to two general-purpose subagents in one message. Tell them both need clamp in src/util.js, that only the "percent" child owns util.js, and that the other must ask it through subagent_message instead of writing clamp itself.',
	},
	{
		id: "repair",
		required: ["parseDuration"],
		files: {
			"package.json": PACKAGE,
			"src/duration.js": "export function parseDuration(text) {\n\treturn Number(text.replace('s', ''));\n}\n",
			"test/duration.test.js": testFile(
				'import { parseDuration } from "../src/duration.js";',
				'test("seconds", () => assert.equal(parseDuration("5s"), 5));\ntest("minutes", () => assert.equal(parseDuration("2m"), 120));\ntest("hours", () => assert.equal(parseDuration("1h"), 3600));',
			),
		},
		task: "npm test fails. Find out why by running it, fix src/duration.js so every test passes, and do not change the tests.",
		split: "Delegate the diagnosis and fix to one general-purpose subagent and a separate reviewer subagent that only reviews the final change without editing.",
	},
] as const;

/** The runs and agent messages one parent session left on disk, for the evaluation report. */
export function readSessionSummary(agentDir: string, parentSessionId: string) {
	const dir = join(getSubagentsRootDir(agentDir), parentSessionId);
	const runs = existsSync(dir)
		? readdirSync(dir)
				.filter((name) => name.startsWith("sub_"))
				.flatMap((runId) => {
					const run = readPersistedRunRecord(agentDir, parentSessionId, runId);
					return run ? [run] : [];
				})
		: [];
	const log = join(dir, "messages.jsonl");
	const messages = existsSync(log)
		? readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => {
					const record = JSON.parse(line) as {
						from: string;
						fromName?: string;
						to: string;
						toName?: string;
						status: string;
					};
					return { from: record.fromName ?? record.from, to: record.toName ?? record.to, status: record.status };
				})
		: [];
	return {
		runs: runs.map((run) => ({
			name: run.name ?? run.runId,
			agent: run.agentName,
			model: `${run.provider}/${run.modelId}`,
			status: run.status,
			generation: run.generation ?? 0,
			toolExecutions: run.toolExecutions ?? {},
			tokens: run.usage.totalTokens,
			ms: run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null,
		})),
		messages,
	};
}

/** What the harness reads back from a `pi --mode json` event stream. */
export function summarizePiEvents(jsonl: string): {
	sessionId?: string;
	spawns: number;
	orchestratorMessages: number;
	tokens: number;
	cost: number;
} {
	let sessionId: string | undefined;
	let spawns = 0;
	let orchestratorMessages = 0;
	let tokens = 0;
	let cost = 0;
	for (const line of jsonl.split("\n")) {
		let event: {
			type?: string;
			id?: string;
			toolName?: string;
			message?: { role?: string; usage?: { totalTokens?: number; cost?: { total?: number } } };
		};
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "session") sessionId ??= event.id;
		if (event.type === "tool_execution_start" && event.toolName === "subagent") spawns++;
		if (event.type === "tool_execution_start" && event.toolName === "subagent_message") orchestratorMessages++;
		if (
			event.type === "message_end" &&
			(event.message?.role === "assistant" || event.message?.role === "toolResult")
		) {
			tokens += event.message.usage?.totalTokens ?? 0;
			cost += event.message.usage?.cost?.total ?? 0;
		}
	}
	return { sessionId, spawns, orchestratorMessages, tokens, cost };
}

const LIMITATIONS = [
	"Three small synthetic fixtures; not a production quality benchmark",
	"One model per role and one trial per mode unless --trials is raised",
	"The message count covers the orchestrator's own subagent_message calls; child-to-child traffic is logged in the session's messages.jsonl, not counted here",
	"Cost is the provider's price-table estimate, not a subscription invoice",
	"Cancellation, permission denials and disposal races are covered by the deterministic suite, not live trials",
];

async function main(): Promise<void> {
	const arg = (name: string) => {
		const index = process.argv.indexOf(name);
		return index < 0 ? undefined : process.argv[index + 1];
	};
	const maxUsd = Number(arg("--max-usd"));
	if (!process.argv.includes("--live") || !Number.isFinite(maxUsd) || maxUsd <= 0) {
		console.log(
			"Usage: node --experimental-strip-types scripts/eval-subagents.ts --live --max-usd <dollars> [--model provider/model] [--child-model provider/model] [--trials n] [--output file.json]",
		);
		console.log(
			"Opt-in only: runs the installed `pi` against scratch fixtures with this checkout's extensions, single-agent and orchestrated. Stops scheduling trials once the estimated spend reaches --max-usd.",
		);
		return;
	}
	const model = arg("--model") ?? "openai-codex/gpt-6.1-sol";
	const childModel = arg("--child-model") ?? model;
	const trials = Number(arg("--trials") ?? 1);
	const root = mkdtempSync(join(tmpdir(), "bluclawd-live-eval-"));
	const output = resolve(arg("--output") ?? join(root, "results.json"));
	const ext = join(dirname(fileURLToPath(import.meta.url)), "..", "ext");
	const extensions = ["permissions", "sandbox", "background-bash", "subagents"].flatMap((name) => [
		"-e",
		join(ext, name, "index.ts"),
	]);
	const results: Array<Record<string, unknown>> = [];
	let spent = 0;
	const save = () =>
		writeFileSync(
			output,
			`${JSON.stringify({ model, childModel, maxUsd, spent, scratch: root, limitations: LIMITATIONS, results }, null, 2)}\n`,
		);
	console.log(`Evaluation model=${model} child=${childModel} maxUsd=${maxUsd} scratch=${root} output=${output}`);
	for (const scenario of LIVE_SCENARIOS) {
		for (let trial = 1; trial <= trials; trial++) {
			for (const mode of ["single", "orchestrated"] as const) {
				if (spent >= maxUsd) {
					console.log(`Stopping: estimated spend $${spent.toFixed(4)} reached --max-usd`);
					save();
					return;
				}
				const cwd = createFixture(scenario.files, mkdtempSync(join(root, `${scenario.id}-${mode}-`)));
				const prompt =
					mode === "single"
						? `${scenario.task} Do it yourself without subagents. Run npm test before you finish.`
						: `You are the orchestrator. ${scenario.task} ${scenario.split} Use model "${childModel}" for every child. Run npm test yourself after they return.`;
				const started = performance.now();
				const run = spawnSync(
					"pi",
					[
						"-p",
						"--mode",
						"json",
						"-ne",
						...extensions,
						"--no-mcp",
						"-ns",
						"-np",
						"--no-themes",
						"-nc",
						"--model",
						model,
						"--no-session",
						prompt,
					],
					{ cwd, encoding: "utf8", input: "", timeout: 900_000, maxBuffer: 256 * 1024 * 1024 },
				);
				const events = summarizePiEvents(run.stdout ?? "");
				spent += events.cost;
				const grade = gradeFixture(cwd, scenario.required);
				const session = events.sessionId ? readSessionSummary(getAgentDir(), events.sessionId) : undefined;
				results.push({
					...session,
					id: scenario.id,
					mode,
					trial,
					exit: run.status,
					ms: Math.round(performance.now() - started),
					...events,
					...grade,
				});
				console.log(
					`${scenario.id} ${mode} trial=${trial} correct=${grade.correct} tests=${grade.passed}/${grade.passed + grade.failed} duplicates=${grade.duplicates.length} spawns=${events.spawns} cost=$${events.cost.toFixed(4)}`,
				);
				save();
			}
		}
	}
	console.log(`Evaluation complete: ${results.length} trials, estimated $${spent.toFixed(4)}; results=${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
