import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readinessMs } from "./helpers/heartbeats.ts";
import {
	conversation,
	FAUX,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
	toolNames,
} from "./helpers/real-pi.ts";
import { reportOf, reportText, runDirOf, runNamed, storedHost } from "./helpers/run-files.ts";
import { waitFor } from "./helpers/wait-for.ts";

const TASK_FRAME = /^\[Task from your orchestrator, from another session, not from the user\..*\]\n\n/s;

/** The last tool result the model was given: the active-run reminder may follow it. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

const alive = (pid: number | undefined) => {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** An orchestrator pane whose runs are RPC children, which load the faux provider as the pane does. */
async function startOrchestrator(): Promise<RealPi> {
	// Before the pane starts: the tmux server, and so the pane, takes this process's environment.
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi();
}

describe.skipIf(!hasTmux)("a read-only run on pi's RPC", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("takes its task in a fresh session, reads the workspace, stores its Report, and its pi exits", async () => {
		const real = await startOrchestrator();
		pi = real;
		// Outside Git: a read-only run needs no repository.
		writeFileSync(join(real.cwd, "notes.txt"), "the codeword is PELICAN\n");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Read notes.txt and say the codeword." } },
			{ text: "the look is done" },
		]);
		real.script("look", [{ tool: "read", args: { path: "notes.txt" } }, { text: "The codeword is PELICAN." }]);
		real.start(["--", "Only the orchestrator knows SECRET-123. Delegate the look."]);
		const main = await real.waitForRequests("main", 2);

		const look = real.requests("look");
		expect(look).toHaveLength(2);
		expect(look[0]).toMatchObject({ piVersion: "1.5.2", model: "faux-1" });
		expect(systemPrompt(look[0])).toContain("You are `explorer`, an exploration subagent");
		// Its own conversation: the framed task and nothing of its orchestrator's.
		expect(conversation(look[0])).toEqual([
			{
				role: "user",
				text: expect.stringMatching(new RegExp(`${TASK_FRAME.source}Read notes.txt and say the codeword.$`, "s")),
			},
		]);
		expect(JSON.stringify(look)).not.toContain("SECRET-123");
		expect(toolNames(look[0]).sort()).toEqual(["codemode", "read", "subagent_message"]);
		expect(lastToolResult(look[1])).toMatchObject({ toolName: "read", text: "the codeword is PELICAN\n" });

		const dir = runDirOf(real.agentDir, "look");
		const host = storedHost(dir);
		const result = lastToolResult(main[1]);
		expect(result).toMatchObject({ role: "toolResult", toolName: "subagent" });
		expect(result?.text).toContain("The codeword is PELICAN.");
		expect(result?.text).toContain("Outcome: completed");
		expect(result?.text).toContain("Process: exited with code 0");
		// What to do after the call is said in its result.
		expect(result?.text).toContain("after its Report was stored: there is nothing to close.");
		expect(result?.text).toContain("What the run says above is its own claim; the runtime verified none of it.");
		expect(result?.text).toContain("Checks: ");
		expect(result?.text).toContain(`Transcript: ${host.sessionFile}`);

		// The Report and the session it came from stay on disk.
		expect(reportText(dir, 1)).toContain("The codeword is PELICAN.");
		expect(readFileSync(String(host.sessionFile), "utf8")).toContain("The codeword is PELICAN.");
		expect(reportOf(dir, 1)).toMatchObject({
			outcome: { status: "completed" },
			sessionId: host.sessionId,
		});
		await waitFor(() =>
			expect(runNamed(real.agentDir, "look").record).toMatchObject({
				backend: "rpc",
				generation: 0,
				status: "closed",
				transcriptPath: host.sessionFile,
			}),
		);
		expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("The codeword is PELICAN.");
		// Its pi and the host that held it ended; no pane or row was ever needed.
		await waitFor(() => expect([alive(host.childPid), alive(host.hostPid)]).toEqual([false, false]));
		expect((await real.rows()).map((row) => row.label)).not.toContain("look");

		// Nothing asked the model more after the run ended.
		expect(real.requests("main")).toHaveLength(2);
		expect(real.requests("look")).toHaveLength(2);
		expect(JSON.stringify([...real.requests("main"), ...real.requests("look")])).not.toContain("ran dry");
	});

	it("reports a pi that could not start as failed, with how it exited, and no claim of its own", async () => {
		const real = await startOrchestrator();
		pi = real;
		// Given an extension that is not there in place of the provider's, the run's pi exits at once.
		vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", join(real.cwd, "missing-provider.ts"));
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "broken", task: "Look." } },
			{ text: "it failed" },
		]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 2);

		const text = lastToolResult(main[1])?.text ?? "";
		expect(text).toMatch(/Outcome: failed: its pi exited first \(code 1\)/);
		expect(text).toContain("Process: exited with code 1");
		expect(text).not.toContain("Outcome: completed");
		expect(real.requests("broken")).toHaveLength(0);
	});

	it("stops mid-work: its pi and host end, and its Report is kept without waking the orchestrator", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "slow", task: "Take your time.", background: true } },
			{ text: "waiting for slow" },
			{ tool: "subagent_stop", args: { agent: "slow" } },
			{ text: "stopped it" },
		]);
		real.script("slow", [{ text: "Too late.", stallMs: 120_000 }]);
		const pane = real.start(["--", "delegate in the background"]);
		await real.waitForRequests("main", 2);
		// The run's model is asked: its work is under way.
		await real.waitForRequests("slow", 1);
		real.tmux.sendKeys(pane, ["stop slow", "Enter"]);
		await real.waitForRequests("main", 4);

		const dir = runDirOf(real.agentDir, "slow");
		await waitFor(() => expect(runNamed(real.agentDir, "slow").record.status).toBe("cancelled"));
		const host = storedHost(dir);
		expect(host.outcome).toMatchObject({ status: "stopped" });
		expect(reportOf(dir, 1)?.outcome).toMatchObject({
			status: "stopped",
		});
		await waitFor(() => expect([alive(host.childPid), alive(host.hostPid)]).toEqual([false, false]));
		// Proves only that no Report woke it within this while.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(real.requests("main")).toHaveLength(4);
		expect(real.requests("slow")).toHaveLength(1);
	});

	it("refuses a role that names a shell where it cannot work in a worktree of its own, before any child starts", async () => {
		const real = await startOrchestrator();
		pi = real;
		const agent = {
			name: "shelly",
			description: "Runs things.",
			instructions: "Run things.",
			tools: ["read", "bash"],
		};
		real.script("main", [
			{ tool: "subagent", args: { agent, name: "shelly", task: "Run ls." } },
			{ text: "refused" },
		]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 2);

		expect(lastToolResult(main[1])?.text).toMatch(/isolated Git worktree, and none can be made|gets no shell here/);
		expect(real.requests("shelly")).toHaveLength(0);
		expect(existsSync(join(real.agentDir, "bluclawd", "subagents"))).toBe(false);
	});

	// Two pis one after another (first, then second): a readiness bound for each to start, and one for the rest.
	it("starts a second run of the same role in a session of its own", { timeout: 3 * readinessMs }, async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "first", task: "Say one." } },
			{ tool: "subagent", args: { agent: "explorer", name: "second", task: "Say two." } },
			{ text: "both done" },
		]);
		real.script("first", [{ text: "One." }]);
		real.script("second", [{ text: "Two." }]);
		real.start(["--", "delegate twice"]);
		await real.waitForRequests("main", 3);

		expect(real.requests("first")).toHaveLength(1);
		expect(real.requests("second")).toHaveLength(1);
		const [second] = real.requests("second");
		expect(conversation(second)).toEqual([{ role: "user", text: expect.stringMatching(/Say two\.$/) }]);
		const sessions = ["first", "second"].map((name) => storedHost(runDirOf(real.agentDir, name)).sessionFile);
		expect(new Set(sessions).size).toBe(2);
	});
});
