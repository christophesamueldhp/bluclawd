/**
 * The comparative delegation evaluation (scripts/eval-delegation.ts) on the scripted faux model. The model's choices
 * are scripted here, so these trials measure what bluclawd's runs cost and keep for one way of doing each task (done
 * directly by stock pi, delegated where the guidance says delegation helps), never whether a real model delegates
 * well: only the live comparison measures that.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Arm,
	formatSummary,
	runTrial,
	SCENARIOS,
	summarize,
	type TrialResult,
} from "../scripts/eval-delegation.ts";
import { type FauxStep, fauxDir } from "./fixtures/real-pi/faux.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import { FAUX } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

const TRIALS = 2;
const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!;

const writer = {
	name: "writer",
	description: "Edits files.",
	instructions: "Make the change asked.",
	tools: ["read", "edit", "write"],
};
const write = (path: string, content: string) => ({ tool: "write", args: { path, content } });
const read = (path: string) => ({ tool: "read", args: { path } });
const runTests: FauxStep = { tool: "bash", args: { command: "node --test test/" } };
const progress = (content: string) => ({ tool: "subagent_message", args: { kind: "progress", content } });

const MINUTES =
	'export function parseDuration(text) {\n\treturn text.endsWith("m") ? Number(text.slice(0, -1)) * 60 : Number(text.replace("s", ""));\n}\n';
const PERCENT =
	'import { clamp } from "./util.js";\n\nexport function percent(part, total) {\n\treturn clamp(Math.round((part / total) * 100), 0, 100);\n}\n';
const BAR =
	'import { clamp } from "./util.js";\n\nexport function progressBar(ratio, width) {\n\tconst filled = Math.round(clamp(ratio, 0, 1) * width);\n\treturn "#".repeat(filled) + "-".repeat(width - filled);\n}\n';
// The worker's first version misses the unknown unit, which the review finds and the repair fixes.
const UNITS = "const UNITS = { s: 1, m: 60, h: 3600 };\n\n";
const FIRST = `${UNITS}export function parseDuration(text) {\n\treturn Number(text.slice(0, -1)) * UNITS[text.at(-1)];\n}\n`;
const REPAIRED = `${UNITS}export function parseDuration(text) {\n\tconst unit = text.at(-1);\n\tif (!(unit in UNITS)) throw new Error(\`Unknown unit: \${unit}\`);\n\treturn Number(text.slice(0, -1)) * UNITS[unit];\n}\n`;
const ANSWER = "percent in src/percent.js and progressBar in src/bar.js call clamp.";

/** Each arm's scripted way of doing a task: stock pi does it all itself. */
const scripts: Record<string, Record<"stock" | "bluclawd", Record<string, FauxStep[]>>> = {
	trivial: {
		stock: { main: [write("src/duration.js", MINUTES), runTests, { text: "parseDuration reads minutes now." }] },
		// Delegating a one-file edit adds nothing: the guidance has the orchestrator do it itself.
		bluclawd: { main: [write("src/duration.js", MINUTES), runTests, { text: "parseDuration reads minutes now." }] },
	},
	investigate: {
		stock: {
			main: [{ calls: [read("src/percent.js"), read("src/bar.js"), read("src/bytes.js")] }, { text: ANSWER }],
		},
		bluclawd: {
			main: [
				{
					tool: "subagent",
					args: { agent: "explorer", name: "scan", task: "Which functions in src/ call clamp?" },
				},
				{ text: ANSWER },
			],
			scan: [{ calls: [read("src/percent.js"), read("src/bar.js"), read("src/bytes.js")] }, { text: ANSWER }],
		},
	},
	parallel: {
		stock: {
			main: [
				{ calls: [write("src/percent.js", PERCENT), write("src/bar.js", BAR)] },
				runTests,
				{ text: "Added percent and progressBar." },
			],
		},
		bluclawd: {
			main: [
				{
					tool: "subagent",
					args: {
						tasks: [
							{ agent: writer, name: "percent", task: "Add percent(part, total) in src/percent.js." },
							{ agent: writer, name: "bar", task: "Add progressBar(ratio, width) in src/bar.js." },
						],
					},
				},
				{ tool: "subagent_integrate", args: { agent: "percent" } },
				{ tool: "subagent_integrate", args: { agent: "bar", check: "node --test test/" } },
				{ text: "Added percent and progressBar." },
			],
			// Their progress must not wake the orchestrator.
			percent: [
				{ calls: [progress("Writing src/percent.js."), write("src/percent.js", PERCENT)] },
				{ calls: [progress("Written.")] },
				{ text: "Added src/percent.js, reusing clamp." },
			],
			bar: [
				{ calls: [progress("Writing src/bar.js."), write("src/bar.js", BAR)] },
				{ calls: [progress("Written.")] },
				{ text: "Added src/bar.js, reusing clamp." },
			],
		},
	},
	review: {
		stock: {
			main: [
				write("src/duration.js", FIRST),
				runTests,
				write("src/duration.js", REPAIRED),
				runTests,
				{ text: "parseDuration reads s, m and h, and refuses other units." },
			],
		},
		bluclawd: {
			main: [
				{
					tool: "subagent",
					args: {
						chain: [
							{ agent: writer, name: "impl", task: "Implement parseDuration in src/duration.js." },
							{ agent: "reviewer", name: "review", task: "Review src/duration.js against its tests." },
							{ resume: "impl", task: "Fix what the review found." },
						],
					},
				},
				// The chain's Integration, once its ID is known.
				{ text: "placeholder" },
				{ text: "parseDuration reads s, m and h, and refuses other units." },
			],
			impl: [
				write("src/duration.js", FIRST),
				{ text: "Implemented parseDuration." },
				write("src/duration.js", REPAIRED),
				{ text: "An unknown unit throws now." },
			],
			review: [
				{ calls: [read("src/duration.js"), read("test/duration.test.js")] },
				{ text: "Finding: src/duration.js:4 returns NaN for an unknown unit, where the test expects a throw." },
			],
		},
	},
};

/** The chain ID of the first run record of a chain under `agentDir`. */
function chainId(agentDir: string): string | undefined {
	const dir = join(agentDir, "bluclawd", "subagents");
	for (const session of existsSync(dir) ? readdirSync(dir) : []) {
		for (const run of session.endsWith(".json") ? [] : readdirSync(join(dir, session))) {
			const path = join(dir, session, run, "record.json");
			const chain = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).chain : undefined;
			if (chain) return chain;
		}
	}
	return undefined;
}

async function trial(name: string, arm: Arm): Promise<TrialResult> {
	const steps = scripts[name][arm as "stock" | "bluclawd"];
	let dirs: { agentDir: string; cwd: string } | undefined;
	const gate = (agentDir: string) => join(agentDir, "..", "repair.go");
	const running = runTrial({
		arm,
		scenario: scenario(name),
		model: "faux/faux-1",
		thinking: "off",
		providerExtensions: [FAUX],
		timeoutMs: 2 * readinessMs,
		prepare: (made) => {
			dirs = made;
			mkdirSync(fauxDir(made.agentDir), { recursive: true });
			const held = name === "review" && arm === "bluclawd";
			for (const [session, script] of Object.entries(steps)) {
				// The repair waits until the orchestrator's next step can name the chain.
				const ready =
					held && session === "impl"
						? script.map((s, i) => (i === 2 ? { ...s, until: gate(made.agentDir) } : s))
						: script;
				writeFileSync(join(fauxDir(made.agentDir), `${session}.json`), JSON.stringify(ready));
			}
		},
	});
	if (name === "review" && arm === "bluclawd" && dirs) {
		const { agentDir } = dirs;
		const chain = await waitFor(() => chainId(agentDir) ?? false);
		const main = [...steps.main];
		main[1] = { tool: "subagent_integrate", args: { agent: chain, check: "node --test test/" } };
		writeFileSync(join(fauxDir(agentDir), "main.json"), JSON.stringify(main));
		writeFileSync(gate(agentDir), "");
	}
	return running;
}

/** Each arm's trials of `name`, one after another. */
async function trials(name: string): Promise<Record<"stock" | "bluclawd", TrialResult[]>> {
	const results = { stock: [] as TrialResult[], bluclawd: [] as TrialResult[] };
	for (let i = 0; i < TRIALS; i++) {
		for (const arm of ["stock", "bluclawd"] as const) results[arm].push(await trial(name, arm));
	}
	console.log(formatSummary(summarize([...results.stock, ...results.bluclawd])));
	return results;
}

/** What holds for every trial of either arm: correct, settled on its own, nothing left running. */
function expectSound(results: Record<"stock" | "bluclawd", TrialResult[]>): void {
	const all = [...results.stock, ...results.bluclawd];
	for (const result of all) {
		expect(result, `${result.scenario} ${result.arm}: ${JSON.stringify(result.grade)}`).toMatchObject({
			correct: true,
			cutShort: false,
			leftover: 0,
			parentWakeups: 0,
		});
		expect(result.parentUsage.totalTokens).toBeGreaterThan(0);
	}
	// Both arms leave the same tree.
	expect(new Set(all.map((r) => r.finalTree)).size).toBe(1);
	for (const result of results.stock) expect(result).toMatchObject({ childRequests: {}, conflicts: null });
	for (const result of results.bluclawd) expect(result.conflicts).toBe(0);
}

// Each trial starts pis of its own, one after another: a failure bound, not a timing estimate.
describe("comparing delegation with stock pi on a scripted model", { timeout: 2 * TRIALS * 2 * readinessMs }, () => {
	it("does trivial work directly: no run, no extra request", async () => {
		const results = await trials("trivial");
		expectSound(results);
		for (const result of results.bluclawd) {
			expect(result).toMatchObject({ childRequests: {}, parentRequests: 3, startupMs: [] });
			expect(result.childUsage.totalTokens).toBe(0);
		}
	});

	it("investigates read-only in the checkout, with no worktree, and the parent does not read what the run read", async () => {
		const results = await trials("investigate");
		expectSound(results);
		for (const result of results.bluclawd) {
			expect(result).toMatchObject({ childRequests: { scan: 2 }, isolated: [], overlap: [], parentRequests: 2 });
			expect(result.answer).toBe(ANSWER);
			expect(result.startupMs).toHaveLength(1);
			expect(result.childUsage.totalTokens).toBeGreaterThan(0);
		}
	});

	it("makes independent edits side by side, integrates them without conflict, and their progress wakes nobody", async () => {
		const results = await trials("parallel");
		expectSound(results);
		for (const result of results.bluclawd) {
			expect(result).toMatchObject({
				childRequests: { percent: 3, bar: 3 },
				isolated: ["bar", "percent"],
				overlap: [],
				parentRequests: 4,
			});
			expect(result.grade.duplicates).toEqual([]);
			expect(result.startupMs).toHaveLength(2);
		}
	});

	it("runs worker, review and repair as one chain and integrates its result", async () => {
		const results = await trials("review");
		expectSound(results);
		for (const result of results.bluclawd) {
			expect(result).toMatchObject({
				childRequests: { impl: 4, review: 2 },
				isolated: ["impl", "review"],
				overlap: [],
				parentRequests: 3,
			});
		}
	});
});
