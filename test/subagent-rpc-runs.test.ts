import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { waitFor } from "./helpers/wait-for.ts";

const TASK_FRAME = /^\[Task from your orchestrator, from another session, not from the user\..*\]\n\n/s;

/** The last tool result the model was given: the active-run reminder may follow it. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

/** A run's directory, as its orchestrator stored it, by the run's name. */
function runDir(agentDir: string, name: string): string {
	const root = join(agentDir, "bluclawd", "subagents");
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const record = join(root, session, run, "record.json");
			if (existsSync(record) && JSON.parse(readFileSync(record, "utf8")).name === name)
				return join(root, session, run);
		}
	}
	throw new Error(`no run named ${name}`);
}

const alive = (pid: number) => {
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
	vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
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

		const dir = runDir(real.agentDir, "look");
		const host = JSON.parse(readFileSync(join(dir, "rpc-host.json"), "utf8"));
		const result = lastToolResult(main[1]);
		expect(result).toMatchObject({ role: "toolResult", toolName: "subagent" });
		expect(result?.text).toContain("The codeword is PELICAN.");
		expect(result?.text).toContain("Outcome: completed");
		expect(result?.text).toContain("Process: exited with code 0");
		expect(result?.text).toContain(`Transcript: ${host.sessionFile}`);

		// The Report and the session it came from stay on disk.
		expect(readFileSync(join(dir, "reports", "1.md"), "utf8")).toContain("The codeword is PELICAN.");
		expect(readFileSync(host.sessionFile, "utf8")).toContain("The codeword is PELICAN.");
		expect(JSON.parse(readFileSync(join(dir, "reports", "1.json"), "utf8"))).toMatchObject({
			outcome: { status: "completed" },
			sessionId: host.sessionId,
		});
		await waitFor(() =>
			expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8"))).toMatchObject({
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
		// Without the provider's extension the run's pi does not know its model, and exits at once.
		vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", "");
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

	it("stops when closed mid-work: its pi and host end, and its Report is kept without waking the orchestrator", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "slow", task: "Take your time.", background: true } },
			{ text: "waiting for slow" },
			{ tool: "subagent_close", args: { agent: "slow" } },
			{ text: "closed it" },
		]);
		real.script("slow", [{ text: "Too late.", stallMs: 120_000 }]);
		const pane = real.start(["--", "delegate in the background"]);
		await real.waitForRequests("main", 2);
		// The run's model is asked: its work is under way.
		await real.waitForRequests("slow", 1);
		real.tmux.sendKeys(pane, ["close slow", "Enter"]);
		await real.waitForRequests("main", 4);

		const dir = runDir(real.agentDir, "slow");
		await waitFor(() => expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).status).toBe("closed"));
		const host = JSON.parse(readFileSync(join(dir, "rpc-host.json"), "utf8"));
		expect(host.outcome).toMatchObject({ status: "stopped" });
		expect(JSON.parse(readFileSync(join(dir, "reports", "1.json"), "utf8")).outcome).toMatchObject({
			status: "stopped",
		});
		await waitFor(() => expect([alive(host.childPid), alive(host.hostPid)]).toEqual([false, false]));
		// Proves only that no Report woke it within this while.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(real.requests("main")).toHaveLength(4);
		expect(real.requests("slow")).toHaveLength(1);
	});

	it("refuses a role that names a shell before any child starts", async () => {
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

		expect(lastToolResult(main[1])?.text).toMatch(/read-only.*bash/s);
		expect(real.requests("shelly")).toHaveLength(0);
		expect(existsSync(join(real.agentDir, "bluclawd", "subagents"))).toBe(false);
	});

	it("starts a second run of the same role in a session of its own", async () => {
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
		const sessions = ["first", "second"].map(
			(name) => JSON.parse(readFileSync(join(runDir(real.agentDir, name), "rpc-host.json"), "utf8")).sessionFile,
		);
		expect(new Set(sessions).size).toBe(2);
	});
});
