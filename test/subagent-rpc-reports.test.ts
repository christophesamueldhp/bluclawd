import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RUN_REPORT_BYTES } from "../ext/subagents/rpc-runs.ts";
import { storedRunReportTextPath } from "../ext/subagents/storage.ts";
import {
	conversation,
	DEFAULT_EXTENSIONS,
	FAUX,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
} from "./helpers/real-pi.ts";
import { findRun } from "./helpers/run-files.ts";
import { piStartsTimeout, whicheverStarted } from "./helpers/run-timing.ts";
import { waitFor } from "./helpers/wait-for.ts";

const ABOUT_2000_TOKENS_BYTES = MAX_RUN_REPORT_BYTES + 512;
const toolResults = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.map(({ text }) => text);

const started = (real: RealPi, session: string, before = 0) =>
	waitFor(() => expect(real.requests(session).length).toBeGreaterThan(before));

async function startOrchestrator(extensions = DEFAULT_EXTENSIONS): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi({ extensions });
}

describe.skipIf(!hasTmux)("an RPC run's Report", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("is bounded: the runtime's own account whole, the run's claim cut with where its full text is", async () => {
		const real = await startOrchestrator();
		pi = real;
		const gate = join(real.cwd, "..", "look.go");
		const claim = `CLAIM BEGINS. All tests pass.\n${"A finding on its own line.\n".repeat(1200)}CLAIM ENDS.`;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look around." } },
			{ text: "read its report" },
		]);
		real.script("look", [{ text: claim, until: gate }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);
		await started(real, "look");
		const full = storedRunReportTextPath(findRun(real.agentDir, "look")?.runDir ?? "", 1);
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look around." } },
			{ tool: "read", args: { path: full } },
			{ text: "read it all" },
		]);
		writeFileSync(gate, "");

		const main = await real.waitForRequests("main", 3);
		const [report] = toolResults(main[1]);
		expect(Buffer.byteLength(report)).toBeLessThanOrEqual(ABOUT_2000_TOKENS_BYTES);
		expect(report).toContain("CLAIM BEGINS. All tests pass.");
		expect(report).not.toContain("CLAIM ENDS.");
		expect(report).toContain(`[Cut short; its full Report: ${full}]`);
		expect(report).toContain("Outcome: completed");
		expect(report).toContain("Process: exited with code 0");
		expect(report).toMatch(/^Checks: none ran: it had no tool that runs commands\./m);
		expect(report).toMatch(/^Changes: none: it had no tool that changes files\.$/m);
		expect(report).toMatch(/^Transcript: \S+\.jsonl$/m);
		expect(report).toContain(`Report: ${full}`);

		expect(systemPrompt(real.requests("look")[0])).toMatch(
			/## Your Report\n.*Never claim a check you did not run\./s,
		);

		expect(toolResults(main[2]).at(-1)).toContain("CLAIM ENDS.");
		expect(JSON.stringify(main)).not.toContain("ran dry");
	});

	it.skipIf(process.platform !== "darwin")(
		"lists the checks its transcript shows it ran, with how each ended, whatever its text claims",
		{ timeout: piStartsTimeout(2) },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			writeFileSync(join(real.cwd, "a.txt"), "one\n");
			for (const args of [
				["init", "-q"],
				["add", "."],
				["-c", "user.name=F", "-c", "user.email=f@example.com", "commit", "-q", "-m", "start"],
			]) {
				expect(spawnSync("git", args, { cwd: real.cwd }).status).toBe(0);
			}
			real.script("main", [
				{ tool: "subagent", args: { agent: "general-purpose", name: "gp", task: "Check it." } },
				{ tool: "subagent_resume", args: { agent: "gp", task: "Check once more." } },
				{ text: "waiting for gp" },
				{ text: "done" },
			]);
			real.script("gp", [
				{ tool: "bash", args: { command: "grep -q one a.txt" } },
				{ tool: "bash", args: { command: "test -f missing.txt" } },
				{ text: "All tests pass." },
				{ tool: "bash", args: { command: "grep -c one a.txt" } },
				{ text: "Still passing." },
			]);
			real.start(["--", "delegate"]);
			await real.waitForRequests("main", 1);
			await started(real, "gp");
			const [report] = toolResults((await real.waitForRequests("main", 2))[1]);

			expect(report).toContain("All tests pass.");
			expect(report).toMatch(/^Checks: the commands its transcript shows it ran, 2:$/m);
			expect(report).toMatch(/^- `grep -q one a\.txt`: exit 0$/m);
			expect(report).toMatch(/^- `test -f missing\.txt`: exit 1$/m);

			await started(real, "gp", 3);
			const resumed = conversation((await real.waitForRequests("main", 4))[3]).at(-1)?.text ?? "";
			expect(resumed).toContain("Still passing.");
			expect(resumed).toMatch(/^Checks: the commands its transcript shows it ran, 1:$/m);
			expect(resumed).toMatch(/^- `grep -c one a\.txt`: exit 0$/m);
			expect(resumed).not.toContain("missing.txt");
		},
	);

	it(
		"keeps every batch member's status reachable while it works, and a cancelled call gives the Reports stored",
		{ timeout: piStartsTimeout(2) },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const settings = join(real.agentDir, "settings.json");
			writeFileSync(
				settings,
				JSON.stringify({
					...JSON.parse(readFileSync(settings, "utf8")),
					subagents: { panes: false, maxActive: 1 },
				}),
			);
			const names = ["a", "b", "c"];
			const tasks = names.map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` }));
			const gate = (name: string) => join(real.cwd, `${name}.go`);
			real.script("main", [{ tool: "subagent", args: { tasks } }]);
			for (const name of names) real.script(name, [{ text: `${name} found it.`, until: gate(name) }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("main", 1);
			const startedRuns = () => whicheverStarted(real, names);
			const [done] = await waitFor(() => {
				expect(startedRuns()).toHaveLength(1);
				return startedRuns();
			});
			writeFileSync(gate(done), "");
			const [working] = await waitFor(() => {
				expect(startedRuns()).toHaveLength(2);
				return startedRuns().filter((name) => name !== done);
			});
			const [queued] = names.filter((name) => name !== done && name !== working);
			const entry = (name: string) => `- tasks\\[${names.indexOf(name)}\\] "${name}" \\(sub_[\\w-]+\\)`;

			const manifest = await waitFor(() => {
				const dir = join(dirname(findRun(real.agentDir, done)?.runDir ?? ""), "batches");
				const [file] = readdirSync(dir);
				const text = readFileSync(join(dir, file), "utf8");
				expect(text).toMatch(new RegExp(`${entry(done)}: completed`));
				expect(text).toMatch(new RegExp(`${entry(working)}: not settled yet: (queued|running)`));
				expect(text).toMatch(new RegExp(`${entry(queued)}: not settled yet: queued`));
				return join(dir, file);
			});
			const doneReport = storedRunReportTextPath(findRun(real.agentDir, done)?.runDir ?? "", 1);
			expect(readFileSync(manifest, "utf8")).toContain(`Report: ${doneReport}`);

			real.tmux.sendKeys(pane, ["Escape"]);
			real.script("main", [
				{ tool: "subagent", args: { tasks } },
				{ tool: "read", args: { path: manifest } },
				{ text: "noted" },
			]);
			await waitFor(() => expect(readFileSync(manifest, "utf8")).toMatch(/Settled: all 3 members\./));
			real.tmux.sendKeys(pane, ["What became of the batch?", "Enter"]);
			const main = await real.waitForRequests("main", 3);
			const [cancelled] = toolResults(main[1]);
			expect(cancelled).toMatch(/^Cancelling batch batch_\w+: every member was asked to stop\./);
			expect(cancelled).toContain(`Every member's status, full Report and transcript: ${manifest}`);
			expect(cancelled).toMatch(
				new RegExp(
					`### "${done}" \\(sub_[\\w-]+\\): completed\\nChecks: none ran: it had no tool that runs commands\\.\\n${done} found it\\.`,
				),
			);
			expect(cancelled).toMatch(
				new RegExp(`- "${working}" \\(sub_[\\w-]+\\): (not settled yet: stopping|cancelled)`),
			);
			expect(cancelled).toMatch(
				new RegExp(`- "${queued}" \\(sub_[\\w-]+\\): (not settled yet: (queued|stopping)|cancelled)`),
			);
			const read = toolResults(main[2]).at(-1) ?? "";
			expect(read).toMatch(new RegExp(`${entry(working)}: cancelled`));
			expect(read).toMatch(new RegExp(`${entry(queued)}: cancelled`));
			expect(real.requests(queued)).toEqual([]);
		},
	);

	it(
		"counts its session once, apart from the orchestrator's own usage, however many generations and Reports",
		{ timeout: piStartsTimeout(3) },
		async () => {
			const real = await startOrchestrator([...DEFAULT_EXTENSIONS, "help"]);
			pi = real;
			real.script("main", [
				{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look around." } },
				{ tool: "subagent_resume", args: { agent: "look", task: "Look again." } },
				{ text: "waiting for look" },
				{ tool: "subagent_resume", args: { agent: "look", task: "Once more." } },
				{ text: "waiting for look again" },
				{ text: "done" },
			]);
			real.script("look", [{ text: "First look." }, { text: "Second look." }, { text: "Third look." }]);
			const orchestrator = real.start(["--", "delegate"]);
			await real.waitForRequests("main", 1);
			await started(real, "look");
			await started(real, "look", 1);
			await started(real, "look", 2);
			await real.waitForRequests("main", 6);

			const dir = findRun(real.agentDir, "look")?.runDir ?? "";
			const sessions = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
			expect(sessions).toHaveLength(1);
			const tokens = entries(join(dir, sessions[0]))
				.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
				.reduce((sum, entry) => sum + (entry.message?.usage?.totalTokens ?? 0), 0);
			expect(tokens).toBeGreaterThan(0);
			const own = readdirSync(join(real.agentDir, "sessions"), { recursive: true, encoding: "utf8" })
				.filter((file) => file.endsWith(".jsonl"))
				.flatMap((file) => entries(join(real.agentDir, "sessions", file)))
				.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult");
			expect(own.length).toBeGreaterThanOrEqual(3);
			for (const entry of own) expect(entry.message).not.toHaveProperty("usage");
			real.tmux.sendKeys(orchestrator, ["/status", "Enter"]);
			await waitFor(() =>
				expect(real.tmux.capture(orchestrator, 200).join("\n")).toMatch(
					new RegExp(`Subagents\\s+1 runs, ${tokens} tokens, cost unknown`),
				),
			);
		},
	);
});

const entries = (path: string) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; message?: { role: string; usage?: { totalTokens: number } } });
