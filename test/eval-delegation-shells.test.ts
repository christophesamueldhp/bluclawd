/**
 * The delegation evaluation's background-shell scenarios (scripts/eval-delegation.ts), `watch` and `slow`, on the
 * scripted faux model, in an arm that loads bluclawd's tool extensions from a checkout. The scripts call the tools one
 * way or another, so these trials show that the scenarios grade and count what the live comparison reads, never how a
 * real model does.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	checkCredentials,
	formatSummary,
	runTrial,
	SCENARIOS,
	type Scenario,
	summarize,
	type TrialResult,
} from "../scripts/eval-delegation.ts";
import { type FauxStep, fauxDir } from "./fixtures/real-pi/faux.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import { FAUX } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The ID of the first background task the parent's session was told of. */
function firstTaskId(agentDir: string): string | false {
	const dir = join(agentDir, "sessions");
	const files = existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }) : [];
	for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
		const id = /task (b[0-9a-z]{8})\b|"backgroundTaskId":"(b[0-9a-z]{8})"/.exec(
			readFileSync(join(dir, file), "utf8"),
		);
		if (id) return id[1] ?? id[2];
	}
	return false;
}

/** Whether watch's server has listened: its record, beside the fixture, has its port. */
function listened(cwd: string): boolean {
	try {
		return JSON.parse(readFileSync(join(cwd, "..", "server.json"), "utf8")).port !== undefined;
	} catch {
		// Not written yet, or caught mid-write.
		return false;
	}
}

type Stop = { stop: true; after?: (cwd: string) => boolean };

/**
 * One trial of `name` with the parent following `steps`. A step `{ stop: true }` is a `task_stop` of the first
 * background task, named once the parent has been told its ID and `after` holds for the trial's checkout: the step
 * before it is held until then.
 */
async function trial(name: string | Scenario, steps: (FauxStep | Stop)[], timeoutMs = 2 * readinessMs) {
	const at = steps.findIndex((step) => "stop" in step);
	const gate = (agentDir: string) => join(agentDir, "..", "stop.go");
	let dirs: { agentDir: string; cwd: string } | undefined;
	const script = (agentDir: string, id?: string) =>
		steps.map((step, i) =>
			"stop" in step
				? { tool: "task_stop", args: { task_id: id ?? "unknown" } }
				: i === at - 1
					? { ...step, until: gate(agentDir) }
					: step,
		);
	const running = runTrial({
		arm: "after",
		checkout: ROOT,
		scenario: typeof name === "string" ? SCENARIOS.find((s) => s.name === name)! : name,
		model: "faux/faux-1",
		thinking: "off",
		providerExtensions: [FAUX],
		timeoutMs,
		prepare: (made) => {
			dirs = made;
			mkdirSync(fauxDir(made.agentDir), { recursive: true });
			writeFileSync(join(fauxDir(made.agentDir), "main.json"), JSON.stringify(script(made.agentDir)));
		},
	});
	if (at >= 0 && dirs) {
		const { agentDir, cwd } = dirs;
		const { after } = steps[at] as Stop;
		try {
			// waitFor returns only once it is not false.
			const id = (await waitFor(() => firstTaskId(agentDir))) as string;
			writeFileSync(join(fauxDir(agentDir), "main.json"), JSON.stringify(script(agentDir, id)));
			if (after) await waitFor(() => after(cwd));
		} finally {
			// Released even if no ID was seen, so the trial ends, and with it all its processes.
			writeFileSync(gate(agentDir), "");
		}
	}
	return running;
}

const bash = (command: string, extra: Record<string, unknown> = {}): FauxStep => ({
	tool: "bash",
	args: { command, ...extra },
});

/** Watching the server's output for the line is one monitor; its port is then read from the copy tee keeps. */
const WATCH = (stop: boolean) => [
	{ tool: "monitor", args: { command: "node server.js | tee server.log", description: "server readiness" } },
	{ text: "I will tell you once it is ready." },
	bash("sed -n 's/^READY port=//p' server.log > port.txt"),
	...(stop ? [{ stop: true } as const] : []),
	{ text: "The server was ready; its port is in port.txt and it is stopped." },
];

/**
 * Waiting for the line without monitor: the server runs as one background job, and a second exits once the line is
 * there, which wakes the model as any finished job does.
 */
const WATCH_WITHOUT_MONITOR = [
	bash("node server.js > server.log", { run_in_background: true }),
	bash("until grep -q READY server.log; do sleep 0.2; done", { run_in_background: true }),
	{ text: "I will tell you once it is ready." },
	bash("sed -n 's/^READY port=//p' server.log > port.txt"),
	{ stop: true } as const,
	{ text: "The server was ready; its port is in port.txt and it is stopped." },
];

function expectOutcome(result: TrialResult, correct: boolean): void {
	expect(result.correct, JSON.stringify({ ...result, parentUsage: undefined, childUsage: undefined })).toBe(correct);
}

describe("background shells in the delegation evaluation, on a scripted model", { timeout: 4 * readinessMs }, () => {
	it("watch: passes when the server's port is written once it is ready and the server is stopped", async () => {
		const result = await trial("watch", WATCH(true));
		expectOutcome(result, true);
		// Woken once, by the line.
		expect(result).toMatchObject({ parentWakeups: 1, leftover: 0, failedToolCalls: 0, bashTimeouts: 0 });
		expect(result.toolCalls).toEqual({ monitor: 1, bash: 1, task_stop: 1 });
	});

	it("watch: passes without monitor, woken by a background bash that exits once the line is there", async () => {
		const { tools: _, ...withoutMonitor } = SCENARIOS.find((s) => s.name === "watch")!;
		const result = await trial(withoutMonitor, WATCH_WITHOUT_MONITOR);
		expectOutcome(result, true);
		expect(result).toMatchObject({ leftover: 0, failedToolCalls: 0, bashTimeouts: 0 });
		expect(result.toolCalls).toEqual({ bash: 3, task_stop: 1 });
	});

	it("watch: fails when the server is left running, once the trial's time is up", async () => {
		const result = await trial("watch", WATCH(false), 10_000);
		expectOutcome(result, false);
		expect(result.cutShort).toBe(true);
		expect(result.leftover).toBeGreaterThan(0);
	});

	it("watch: fails when the port is written before the server is ready", async () => {
		const result = await trial("watch", [
			{ tool: "monitor", args: { command: "node server.js | tee server.log", description: "server readiness" } },
			bash("sed -n 's/^READY port=//p' server.log > port.txt"),
			// Held until the server has listened, so it is stopped while it is up but not yet ready.
			{ tool: "read", args: { path: "server.js" } },
			{ stop: true, after: listened },
			{ text: "Done." },
		]);
		expectOutcome(result, false);
		expect(result.checkFailure).toMatch(/^port\.txt holds ""/);
	});

	it("watch: tells a server stopped before it listened from one that never started", () => {
		const base = mkdtempSync(join(tmpdir(), "bc-eval-watch-"));
		try {
			const cwd = join(base, "work");
			mkdirSync(cwd);
			const check = SCENARIOS.find((s) => s.name === "watch")!.check!;
			expect(check(cwd)).toBe("the server never started");
			// As server.js leaves its record when it is stopped between its start and its listen().
			writeFileSync(join(base, "server.json"), "{}");
			expect(check(cwd)).toBe("the server was stopped before it listened");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("slow: passes with the limit given in seconds, no bash call ends at its timeout, and keeps the limit sent", async () => {
		const result = await trial("slow", [bash("node build.js", { timeout: 10 }), { text: "Built." }]);
		expectOutcome(result, true);
		expect(result).toMatchObject({ parentWakeups: 0, failedToolCalls: 0, bashTimeouts: 0, toolCalls: { bash: 1 } });
		expect(result.bashTimeoutsSent).toEqual([10]);
	});

	it("slow: keeps a limit sent in milliseconds, which the cap leaves with no other trace", async () => {
		const result = await trial("slow", [bash("node build.js", { timeout: 10_000 }), { text: "Built." }]);
		expectOutcome(result, true);
		expect(result).toMatchObject({ failedToolCalls: 0, bashTimeouts: 0, bashTimeoutsSent: [10_000] });
	});

	it("slow: counts a limit shorter than the build as a bash call ended at its timeout, though the build still finishes", async () => {
		const result = await trial("slow", [
			bash("node build.js", { timeout: 1 }),
			{ text: "The build went on in the background; I will wait for it." },
			{ text: "Built." },
		]);
		expectOutcome(result, true);
		// Moved to the background at once, which is not an error; its exit woke the parent.
		expect(result).toMatchObject({ parentWakeups: 1, failedToolCalls: 0, bashTimeouts: 1 });
	});

	it("slow: fails when the build is stopped once it passed a limit shorter than the build", async () => {
		const result = await trial("slow", [
			bash("node build.js", { timeout: 1 }),
			{ tool: "read", args: { path: "build.js" } },
			{ stop: true },
			{ text: "It ran past its limit, so I stopped it." },
		]);
		expectOutcome(result, false);
		expect(result).toMatchObject({
			failedToolCalls: 0,
			bashTimeouts: 1,
			toolCalls: { bash: 1, read: 1, task_stop: 1 },
		});
	});

	it("slow: counts a command killed at its timeout as both a failed call and a bash call ended at its timeout", async () => {
		// A command that starts with `sleep` is killed at its timeout rather than moved to the background.
		const result = await trial("slow", [bash("sleep 2; node build.js", { timeout: 1 }), { text: "It timed out." }]);
		expectOutcome(result, false);
		expect(result).toMatchObject({ failedToolCalls: 1, bashTimeouts: 1 });
		expect(result.failedCalls).toEqual([expect.stringMatching(/^bash: \S/)]);
	});
});

describe("credentials of a live comparison, on a scripted model", { timeout: 4 * readinessMs }, () => {
	/** A stand-in for the user's auth.json: its owner's credentials never come near a test. */
	function standIn(): { auth: string; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), "bc-eval-auth-"));
		writeFileSync(join(dir, "auth.json"), "{}\n");
		return { auth: join(dir, "auth.json"), dir };
	}

	it("makes one call per provider through an agent dir whose auth.json links to the user's", async () => {
		const { auth, dir } = standIn();
		try {
			const checked = await checkCredentials({
				auth,
				models: ["faux/faux-1", "faux/faux-2"],
				thinking: "off",
				providerExtensions: [FAUX],
			});
			expect(checked).toEqual([{ provider: "faux", model: "faux/faux-1", writtenThrough: false }]);
			expect(readFileSync(auth, "utf8")).toBe("{}\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a trial's agent dir, and says so, when its auth.json is no longer the link", async () => {
		const { auth, dir } = standIn();
		let agentDir = "";
		try {
			const running = runTrial({
				arm: "after",
				checkout: ROOT,
				scenario: SCENARIOS.find((s) => s.name === "slow")!,
				model: "faux/faux-1",
				thinking: "off",
				providerExtensions: [FAUX],
				auth,
				prepare: (made) => {
					agentDir = made.agentDir;
					expect(lstatSync(join(agentDir, "auth.json")).isSymbolicLink()).toBe(true);
					// As a pi that saved its credentials beside the link, not through it, would leave it.
					rmSync(join(agentDir, "auth.json"));
					writeFileSync(join(agentDir, "auth.json"), "{}\n");
					mkdirSync(fauxDir(agentDir), { recursive: true });
					writeFileSync(join(fauxDir(agentDir), "main.json"), JSON.stringify([{ text: "Nothing to do." }]));
				},
			});
			await expect(running).rejects.toThrow(/auth\.json .* no longer a link/);
			expect(existsSync(join(agentDir, "auth.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			if (agentDir) rmSync(join(agentDir, ".."), { recursive: true, force: true });
		}
	});
});

describe("the comparison's summary", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	const result = (fields: Partial<TrialResult>) =>
		({
			scenario: "slow",
			arm: "after",
			model: "openai-codex/gpt-6.1-sol",
			correct: true,
			parentUsage: usage,
			childUsage: usage,
			startupMs: [],
			overlap: [],
			conflicts: 0,
			toolCalls: {},
			failedToolCalls: 0,
			failedCalls: [],
			bashTimeouts: 0,
			...fields,
		}) as TrialResult;

	it("has a row per model, scenario and arm, with its failed calls, bash timeouts and tools called", () => {
		const rows = summarize([
			result({ toolCalls: { bash: 2 }, failedToolCalls: 1, bashTimeouts: 1 }),
			result({ toolCalls: { bash: 1, task_stop: 1 }, bashTimeouts: 1, correct: false }),
			result({ arm: "before", toolCalls: { bash: 1 } }),
			result({ model: "anthropic/claude-opus-5-5", toolCalls: { bash: 1 } }),
		]);
		expect(rows.map((row) => [row.model, row.arm, row.trials, row.passAt1])).toEqual([
			["openai-codex/gpt-6.1-sol", "after", 2, 0.5],
			["openai-codex/gpt-6.1-sol", "before", 1, 1],
			["anthropic/claude-opus-5-5", "after", 1, 1],
		]);
		expect(rows[0]).toMatchObject({ failedToolCalls: 1, bashTimeouts: 2, tools: ["bash", "task_stop"] });
		const table = formatSummary(rows).split("\n");
		expect(table[0]).toMatch(/^\| model \| scenario \| arm \|.*\| failed calls \| bash timeouts \| tools \|$/);
		expect(table[2]).toMatch(
			/^\| openai-codex\/gpt-6\.1-sol \| slow \| after \| 2 \|.*\| 1 \| 2 \| bash, task_stop \|$/,
		);
	});
});
