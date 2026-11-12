import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { waitFor } from "./helpers/wait-for.ts";

/** The texts of the tool results the model was given in `request`, in order. */
const toolResults = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.map(({ text }) => text);

/** A run's directory, as its orchestrator stored it, by the run's name; undefined before it is admitted. */
function runDir(agentDir: string, name: string): string | undefined {
	const root = join(agentDir, "bluclawd", "subagents");
	if (!existsSync(root)) return undefined;
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const record = join(root, session, run, "record.json");
			if (existsSync(record) && JSON.parse(readFileSync(record, "utf8")).name === name)
				return join(root, session, run);
		}
	}
	return undefined;
}

/** Waits until the model of `session` got more than `before` requests: each pi start gets a wait of its own. */
const started = (real: RealPi, session: string, before = 0) =>
	waitFor(() => expect(real.requests(session).length).toBeGreaterThan(before));

/** An orchestrator pane whose runs are RPC children, which load the faux provider as the pane does. */
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
		// Its full Report will be its first: the orchestrator's model reads it once the cut one arrives.
		const full = join(runDir(real.agentDir, "look") ?? "", "reports", "1.md");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look around." } },
			{ tool: "read", args: { path: full } },
			{ text: "read it all" },
		]);
		writeFileSync(gate, "");

		const main = await real.waitForRequests("main", 3);
		const [report] = toolResults(main[1]);
		// About 2,000 tokens at most, however long the run's text.
		expect(Buffer.byteLength(report)).toBeLessThanOrEqual(8 * 1024 + 512);
		expect(report).toContain("CLAIM BEGINS. All tests pass.");
		expect(report).not.toContain("CLAIM ENDS.");
		expect(report).toContain(`[Cut short; its full Report: ${full}]`);
		// What the runtime itself saw, never cut and never taken from the run's claim.
		expect(report).toContain("Outcome: completed");
		expect(report).toContain("Process: exited with code 0");
		expect(report).toMatch(/^Checks: none ran: it had no tool that runs commands\./m);
		expect(report).toMatch(/^Changes: none: it had no tool that changes files\.$/m);
		expect(report).toMatch(/^Transcript: \S+\.jsonl$/m);
		expect(report).toContain(`Report: ${full}`);

		// Told what its Report is for, and that a check it did not run is not to be claimed.
		expect(systemPrompt(real.requests("look")[0])).toMatch(
			/## Your Report\n.*Never claim a check you did not run\./s,
		);

		// The full Report is there for the orchestrator to read.
		expect(toolResults(main[2]).at(-1)).toContain("CLAIM ENDS.");
		expect(JSON.stringify(main)).not.toContain("ran dry");
	});

	// Commands run only where a backend can confirm their processes ended.
	it.skipIf(process.platform !== "darwin")(
		"lists the checks its transcript shows it ran, with how each ended, whatever its text claims",
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

			// Its next generation's Report lists only what that generation ran, though one session holds all three.
			await started(real, "gp", 3);
			const resumed = conversation((await real.waitForRequests("main", 4))[3]).at(-1)?.text ?? "";
			expect(resumed).toContain("Still passing.");
			expect(resumed).toMatch(/^Checks: the commands its transcript shows it ran, 1:$/m);
			expect(resumed).toMatch(/^- `grep -c one a\.txt`: exit 0$/m);
			expect(resumed).not.toContain("missing.txt");
		},
	);

	it("keeps every batch member's status reachable while it works, and a cancelled call gives the Reports stored", async () => {
		const real = await startOrchestrator();
		pi = real;
		const settings = join(real.agentDir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), subagents: { panes: false, maxActive: 1 } }),
		);
		const tasks = ["a", "b", "c"].map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` }));
		real.script("main", [{ tool: "subagent", args: { tasks } }]);
		real.script("a", [{ text: "a found it." }]);
		real.script("b", [{ text: "Never.", until: join(real.cwd, "never") }]);
		real.script("c", [{ text: "Never started." }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);
		await started(real, "a");
		await started(real, "b");

		// Before it settles, the manifest says what each member did: one settled, one working, one queued.
		const manifest = await waitFor(() => {
			const dir = join(dirname(runDir(real.agentDir, "a") ?? ""), "batches");
			const [file] = readdirSync(dir);
			const text = readFileSync(join(dir, file), "utf8");
			expect(text).toMatch(/- tasks\[0\] "a" \(sub_[\w-]+\): completed/);
			expect(text).toMatch(/- tasks\[1\] "b" \(sub_[\w-]+\): not settled yet: (queued|running)/);
			expect(text).toMatch(/- tasks\[2\] "c" \(sub_[\w-]+\): not settled yet: queued/);
			return join(dir, file);
		});
		const aReport = join(runDir(real.agentDir, "a") ?? "", "reports", "1.md");
		expect(readFileSync(manifest, "utf8")).toContain(`Report: ${aReport}`);

		// Cancelled, the call still gives what settled, its Report with it, and where the rest will be.
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
			/### "a" \(sub_[\w-]+\): completed\nChecks: none ran: it had no tool that runs commands\.\na found it\./,
		);
		expect(cancelled).toMatch(/- "b" \(sub_[\w-]+\): (not settled yet: stopping|cancelled)/);
		expect(cancelled).toMatch(/- "c" \(sub_[\w-]+\): (not settled yet: (queued|stopping)|cancelled)/);
		// Every member's final status, for the orchestrator to read.
		const read = toolResults(main[2]).at(-1) ?? "";
		expect(read).toMatch(/- tasks\[1\] "b" \(sub_[\w-]+\): cancelled/);
		expect(read).toMatch(/- tasks\[2\] "c" \(sub_[\w-]+\): cancelled/);
		expect(real.requests("c")).toEqual([]);
	});

	it("counts its session once, apart from the orchestrator's own usage, however many generations and Reports", async () => {
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

		// Three generations in one session: what that session's file holds is the run's usage, each token once.
		const dir = runDir(real.agentDir, "look") ?? "";
		const sessions = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
		expect(sessions).toHaveLength(1);
		const tokens = entries(join(dir, sessions[0]))
			.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
			.reduce((sum, entry) => sum + (entry.message?.usage?.totalTokens ?? 0), 0);
		expect(tokens).toBeGreaterThan(0);
		// None of it in the orchestrator's own session, whose tool results carry no usage.
		const own = readdirSync(join(real.agentDir, "sessions"), { recursive: true, encoding: "utf8" })
			.filter((file) => file.endsWith(".jsonl"))
			.flatMap((file) => entries(join(real.agentDir, "sessions", file)))
			.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult");
		expect(own.length).toBeGreaterThanOrEqual(3);
		for (const entry of own) expect(entry.message).not.toHaveProperty("usage");
		// Its faux model has no price: the cost is unknown, not $0.
		real.tmux.sendKeys(orchestrator, ["/status", "Enter"]);
		await waitFor(() =>
			expect(real.tmux.capture(orchestrator, 200).join("\n")).toMatch(
				new RegExp(`Subagents\\s+1 runs, ${tokens} tokens, cost unknown`),
			),
		);
	});
});

/** Each entry of the session file `path`, as far as these tests read it. */
const entries = (path: string) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; message?: { role: string; usage?: { totalTokens: number } } });
