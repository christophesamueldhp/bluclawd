import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPaneSession } from "../daemon/run-queue.ts";
import {
	conversation,
	DEFAULT_EXTENSIONS,
	FAUX,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
	toolNames,
} from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

const GATE = fileURLToPath(new URL("./fixtures/real-pi/approval-gate.ts", import.meta.url));

/** A run's record, as its orchestrator stored it, by the run's name. */
function runRecord(agentDir: string, name: string): { runId: string; dir: string } {
	const root = join(agentDir, "bluclawd", "subagents");
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const dir = join(root, session, run);
			try {
				const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
				if (record.name === name) return { runId: record.runId, dir };
			} catch {
				// Not written yet.
			}
		}
	}
	throw new Error(`no run named ${name}`);
}

/** Kills the pi in `pane` as a crash does: it never ends its session, and its pane goes with it. */
function crash(real: RealPi, pane: string): void {
	const pid = Number(
		spawnSync("tmux", ["-S", real.tmux.socket, "display-message", "-p", "-t", `=${pane}:`, "#{pane_pid}"], {
			encoding: "utf8",
		}).stdout.trim(),
	);
	// Never 0, which would kill this whole process group.
	expect(pid).toBeGreaterThan(0);
	process.kill(pid, "SIGKILL");
}

/** The notes of what the user typed to a run, in a request of its orchestrator's. */
const notes = (request: FauxRequest) =>
	conversation(request).flatMap(({ text }) => text.match(/The user instructed subagent .*/g) ?? []);

/** An orchestrator pane whose runs run in panes of their own (ADR-0013), loading the faux provider as it does. */
async function startOrchestrator(extensions?: string[]): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi({ runsInPanes: true, ...(extensions ? { extensions } : {}) });
}

describe.skipIf(!hasTmux)("a run in a pane of its own", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("works in a pane the user can watch, as it would on RPC, and its pane closes once its Report is stored", async () => {
		const real = await startOrchestrator();
		pi = real;
		writeFileSync(join(real.cwd, "notes.txt"), "the codeword is PELICAN\n");
		const gate = join(real.cwd, "look.go");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Read notes.txt and say the codeword." } },
			{ text: "the look is done" },
		]);
		real.script("look", [
			{ tool: "read", args: { path: "notes.txt" } },
			{ text: "The codeword is PELICAN.", until: gate },
		]);
		real.start(["--", "Delegate the look."]);
		const look = await real.waitForRequests("look", 2);

		// Its model sees what it would on RPC: its role, its framed task, and its tools only.
		expect(systemPrompt(look[0])).toContain("You are `explorer`, an exploration subagent");
		expect(conversation(look[0])).toEqual([
			{ role: "user", text: expect.stringContaining("Read notes.txt and say the codeword.") },
		]);
		expect(toolNames(look[0]).sort()).toEqual(["codemode", "read", "subagent_message"]);

		// Its pi is interactive, in a tmux session of agent view's server named after its run and generation.
		const { runId, dir } = runRecord(real.agentDir, "look");
		const pane = runPaneSession(runId, 0);
		expect(real.tmux.hasSession(pane)).toBe(true);
		await waitFor(() => expect(real.tmux.capture(pane, 200).join("\n")).toContain("Read notes.txt"));
		// It is no row of its own.
		expect((await real.rows()).map((row) => row.label)).not.toContain("look");

		writeFileSync(gate, "");
		const main = await real.waitForRequests("main", 2);
		const result = conversation(main[1]).at(-1);
		expect(result?.text).toContain("The codeword is PELICAN.");
		expect(result?.text).toContain("Outcome: completed");
		expect(result?.text).toContain("Process: exited with code 0");
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
		expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8"))).toMatchObject({
			backend: "rpc",
			status: "closed",
		});
	});

	it("asks the user for an approval in its own pane, its orchestrator's panel saying it needs input", async () => {
		const real = await startOrchestrator();
		pi = real;
		vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, GATE].join(":"));
		writeFileSync(join(real.cwd, "secret.gated"), "OSPREY\n");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Read secret.gated." } },
			{ text: "done" },
		]);
		real.script("look", [{ tool: "read", args: { path: "secret.gated" } }, { text: "It says OSPREY." }]);
		real.start(["--", "Delegate the look."]);
		await real.waitForRequests("look", 1);
		const { runId, dir } = runRecord(real.agentDir, "look");
		const pane = runPaneSession(runId, 0);
		await waitFor(() => expect(real.tmux.capture(pane, 200).join("\n")).toContain("Allow this subagent read"));
		await waitFor(() =>
			expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).activity).toBe("awaiting_input"),
		);

		// The first choice allows it.
		real.tmux.sendKeys(pane, ["Enter"]);
		const look = await real.waitForRequests("look", 2);
		expect(conversation(look[1]).at(-1)?.text).toContain("OSPREY");
		const main = await real.waitForRequests("main", 2);
		expect(conversation(main[1]).at(-1)?.text).toContain("It says OSPREY.");
	});

	it("keeps an approval waiting while its orchestrator is there, and blocks it once that orchestrator is gone", async () => {
		const real = await startOrchestrator();
		pi = real;
		vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, GATE].join(":"));
		writeFileSync(join(real.cwd, "secret.gated"), "OSPREY\n");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Read secret.gated.", background: true } },
			{ text: "waiting" },
		]);
		real.script("look", [{ tool: "read", args: { path: "secret.gated" } }, { text: "It was blocked." }]);
		const orchestrator = real.start(["--", "Delegate the look."]);
		await real.waitForRequests("look", 1);
		const { runId, dir } = runRecord(real.agentDir, "look");
		const pane = runPaneSession(runId, 0);
		await waitFor(() => expect(real.tmux.capture(pane, 200).join("\n")).toContain("Allow this subagent read"));

		// No one watches its pane, but its orchestrator's panel says it needs input: it waits, past RPC's 5 s.
		await new Promise((resolve) => setTimeout(resolve, 7000));
		expect(real.requests("look")).toHaveLength(1);
		expect(real.tmux.capture(pane, 200).join("\n")).toContain("Allow this subagent read");

		// Its orchestrator crashed, and its pane with it. Another session, not its orchestrator's, takes nothing over: once
		// it is up and no terminal shows the run's pane, no one is left to answer, so it is blocked, and the run goes on.
		real.attach(pane);
		await waitFor(() => expect(real.shown()).toBe(pane));
		crash(real, orchestrator);
		const other = real.start([]);
		await waitFor(() => expect(real.tmux.capture(other, 80).join("\n")).toContain("← for agents"));
		real.tmux.moveClients(pane, other);
		const look = await real.waitForRequests("look", 2);
		expect(conversation(look[1]).at(-1)?.text).toContain("Blocked: read");
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
		expect(JSON.parse(readFileSync(join(dir, "reports", "1.json"), "utf8")).outcome).toEqual({ status: "completed" });
	}, 60_000);

	it("follows its orchestrator to the pane its session is reopened in after a crash: its approval waits for it there", async () => {
		const real = await startOrchestrator();
		pi = real;
		vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, GATE].join(":"));
		writeFileSync(join(real.cwd, "secret.gated"), "OSPREY\n");
		const gate = join(real.cwd, "look.go");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Read secret.gated.", background: true } },
			{ text: "waiting" },
			{ text: "read the report" },
		]);
		real.script("look", [
			{ tool: "read", args: { path: "secret.gated" } },
			{ text: "It says OSPREY.", until: gate },
		]);
		const orchestrator = real.start(["--", "Delegate the look."]);
		await real.waitForRequests("main", 2);
		await real.waitForRequests("look", 1);
		const sessionFile = await waitFor(async () => {
			const file = (await real.rows()).find((row) => row.pane === orchestrator)?.sessionFile;
			expect(file).toBeDefined();
			return file ?? "";
		});
		const { runId } = runRecord(real.agentDir, "look");
		const pane = runPaneSession(runId, 0);
		const asking = () => real.tmux.capture(pane, 200).join("\n");
		await waitFor(() => expect(asking()).toContain("Allow this subagent read"));

		// Watched until its session is reopened, however long that takes: its approval is not blocked meanwhile.
		real.attach(pane);
		await waitFor(() => expect(real.shown()).toBe(pane));
		crash(real, orchestrator);
		const reopened = real.start(["--session", sessionFile]);
		const panel = () => real.tmux.capture(reopened, 80).join("\n");
		await waitFor(() => expect(panel()).toMatch(/look\s.*needs input/));

		// No one watches its pane, but its reopened orchestrator's panel says it needs input: it waits, past RPC's 5 s.
		real.tmux.moveClients(pane, reopened);
		await waitFor(() => expect(real.shown()).toBe(reopened));
		await new Promise((resolve) => setTimeout(resolve, 7000));
		expect(real.requests("look")).toHaveLength(1);
		expect(asking()).toContain("Allow this subagent read");
		expect(panel()).toMatch(/look\s.*needs input/);

		// Answered in its pane, it goes on; ← goes back to the reopened orchestrator.
		real.tmux.moveClients(reopened, pane);
		await waitFor(() => expect(real.shown()).toBe(pane));
		real.tmux.sendKeys(pane, ["Enter"]);
		const look = await real.waitForRequests("look", 2);
		expect(conversation(look[1]).at(-1)?.text).toContain("OSPREY");
		real.tmux.sendKeys(pane, ["Left"]);
		await waitFor(() => expect(real.shown()).toBe(reopened));

		// Shown when it ends, its pane hands the terminal to the reopened orchestrator, which gets its Report.
		real.tmux.moveClients(reopened, pane);
		await waitFor(() => expect(real.shown()).toBe(pane));
		writeFileSync(gate, "");
		const main = await real.waitForRequests("main", 3);
		expect(conversation(main[2]).at(-1)?.text).toContain("It says OSPREY.");
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
		await waitFor(() => expect(real.shown()).toBe(reopened));
	}, 90_000);

	it("stops when its orchestrator stops it: its pane closes, and its work so far is its Report", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "work", task: "Look.", background: true } },
			{ text: "waiting" },
			{ tool: "subagent_stop", args: { agent: "work" } },
			{ text: "stopped it" },
		]);
		real.script("work", [{ text: "Never.", until: join(real.cwd, "never") }]);
		const orchestrator = real.start(["--", "delegate"]);
		await real.waitForRequests("work", 1);
		await real.waitForRequests("main", 2);
		const { runId, dir } = runRecord(real.agentDir, "work");
		const pane = runPaneSession(runId, 0);
		expect(real.tmux.hasSession(pane)).toBe(true);

		real.tmux.sendKeys(orchestrator, ["stop work", "Enter"]);
		await real.waitForRequests("main", 4);
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
		expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8"))).toMatchObject({ status: "cancelled" });
		expect(JSON.parse(readFileSync(join(dir, "reports", "1.json"), "utf8")).outcome).toMatchObject({
			status: "stopped",
		});
	});

	it("opens from its orchestrator's panel by switching the terminal to its pane, and ← goes back", async () => {
		const real = await startOrchestrator();
		pi = real;
		const gate = join(real.cwd, "look.go");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look.", background: true } },
			{ text: "waiting for look" },
			{ text: "read the report" },
		]);
		real.script("look", [{ text: "Looked.", until: gate }]);
		const orchestrator = real.start(["--", "delegate"]);
		real.attach(orchestrator);
		await real.waitForRequests("main", 2);
		await real.waitForRequests("look", 1);
		const { runId } = runRecord(real.agentDir, "look");
		const pane = runPaneSession(runId, 0);
		const screen = () => real.tmux.capture(orchestrator, 80).join("\n");
		await waitFor(() => expect(screen()).toMatch(/^\s+look\s+explorer\s/m));

		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(pane));
		real.tmux.sendKeys(pane, ["Left"]);
		await waitFor(() => expect(real.shown()).toBe(orchestrator));

		writeFileSync(gate, "");
		await real.waitForRequests("main", 3);
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
	});

	it("resumes once finished in a pane the user types its next instruction in, opened from /tasks; its orchestrator is told of it (#357)", async () => {
		const real = await startOrchestrator([...DEFAULT_EXTENSIONS, "background-bash"]);
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "kept", task: "Remember PELICAN." } },
			{ text: "kept remembered" },
			{ text: "read its next report" },
		]);
		real.script("kept", [{ text: "Remembered." }, { text: "You also said HERON." }]);
		const orchestrator = real.start(["--", "delegate"]);
		real.attach(orchestrator);
		await real.waitForRequests("main", 2);
		const { runId, dir } = runRecord(real.agentDir, "kept");
		await waitFor(() => expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).status).toBe("closed"));
		await waitFor(() => expect(real.tmux.hasSession(runPaneSession(runId, 0))).toBe(false));

		const screen = () => real.tmux.capture(orchestrator, 80).join("\n");
		await waitFor(() => expect(screen()).toContain("kept remembered"));
		real.tmux.sendKeys(orchestrator, ["/tasks", "Enter"]);
		await waitFor(() => expect(screen()).toMatch(/Done \(1\)/));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		const pane = runPaneSession(runId, 1);
		await waitFor(() => expect(real.shown()).toBe(pane));
		// Its earlier conversation is there, and it waits for the user: nothing asked its model yet.
		await waitFor(() => expect(real.tmux.capture(pane, 200).join("\n")).toContain("Remembered."));
		expect(real.requests("kept")).toHaveLength(1);

		real.tmux.sendKeys(pane, ["Also remember HERON.", "Enter"]);
		const kept = await real.waitForRequests("kept", 2);
		expect(conversation(kept[1]).at(-1)?.text).toBe("Also remember HERON.");
		// Told once of the instruction, which woke it for no turn of its own: its next turn is the Report's.
		const main = await real.waitForRequests("main", 3);
		expect(conversation(main[2]).at(-1)?.text).toContain("You also said HERON.");
		expect(notes(main[2])).toEqual([`The user instructed subagent "kept" (${runId}) directly: Also remember HERON.`]);
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
		await waitFor(() => expect(real.shown()).toBe(orchestrator));
	});

	it("tells its orchestrator of each prompt the user types in its pane while it works, without a turn, and of none its orchestrator sent (#357)", async () => {
		const real = await startOrchestrator();
		pi = real;
		const gate = join(real.cwd, "look.go");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look.", background: true } },
			{ text: "waiting for look" },
			{ tool: "subagent_message", args: { to: "look", content: "Also say OSPREY." } },
			{ text: "told look" },
			{ text: "read the report" },
		]);
		real.script("look", [
			{ text: "Looked.", until: gate },
			{ text: "Said HERON." },
			{ text: "Said IBIS." },
			{ text: "Said them all." },
		]);
		const orchestrator = real.start(["--", "delegate"]);
		real.attach(orchestrator);
		await real.waitForRequests("main", 2);
		await real.waitForRequests("look", 1);
		const { runId } = runRecord(real.agentDir, "look");
		const pane = runPaneSession(runId, 0);
		const screen = () => real.tmux.capture(orchestrator, 80).join("\n");
		await waitFor(() => expect(screen()).toMatch(/^\s+look\s+explorer\s/m));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(pane));

		// Each prompt typed while its model works is noted to its orchestrator, which takes no turn for it.
		real.tmux.sendKeys(pane, ["Also say HERON.", "Enter"]);
		await waitFor(() => expect(screen()).toContain("Also say HERON."));
		real.tmux.sendKeys(pane, ["And say IBIS.", "Enter"]);
		await waitFor(() => expect(screen()).toContain("And say IBIS."));
		expect(real.requests("main")).toHaveLength(2);

		// Its orchestrator's own message to it is noted nowhere. The user goes back as agent view would: ← may take
		// back a prompt pi still queues.
		real.tmux.moveClients(pane, orchestrator);
		await waitFor(() => expect(real.shown()).toBe(orchestrator));
		real.tmux.sendKeys(orchestrator, ["tell look"]);
		await waitFor(() => expect(screen()).toContain("tell look"));
		real.tmux.sendKeys(orchestrator, ["Enter"]);
		const told = await real.waitForRequests("main", 3);
		expect(conversation(told[2]).map(({ text }) => text)).toContain("tell look");
		const typed = [
			`The user instructed subagent "look" (${runId}) directly: Also say HERON.`,
			`The user instructed subagent "look" (${runId}) directly: And say IBIS.`,
		];
		expect(notes(told[2])).toEqual(typed);
		await real.waitForRequests("main", 4);

		writeFileSync(gate, "");
		// pi gives its run the queued prompts one per turn.
		const look = await real.waitForRequests("look", 4);
		expect(conversation(look[3]).at(-1)?.text).toContain("Also say OSPREY.");
		const main = await real.waitForRequests("main", 5);
		expect(conversation(main[4]).at(-1)?.text).toContain("Said them all.");
		expect(notes(main[4])).toEqual(typed);
	}, 60_000);

	it("starts nothing when opened finished with every slot taken, and says why; opened again once one is free, it resumes (#353)", async () => {
		const real = await startOrchestrator([...DEFAULT_EXTENSIONS, "background-bash"]);
		pi = real;
		const settings = join(real.agentDir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), subagents: { maxActive: 1, panes: true } }),
		);
		const gate = join(real.cwd, "busy.go");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "kept", task: "Remember PELICAN." } },
			{ tool: "subagent", args: { agent: "explorer", name: "busy", task: "Hold.", background: true } },
			{ text: "waiting for busy" },
			{ text: "busy is done" },
			{ text: "read its next report" },
		]);
		real.script("kept", [{ text: "Remembered." }, { text: "You also said HERON." }]);
		real.script("busy", [{ text: "Held.", until: gate }]);
		const orchestrator = real.start(["--", "delegate"]);
		real.attach(orchestrator);
		await real.waitForRequests("busy", 1);
		await real.waitForRequests("main", 3);
		const { runId, dir } = runRecord(real.agentDir, "kept");
		const record = () => JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
		await waitFor(() => expect(record().status).toBe("closed"));
		const before = record();
		const screen = () => real.tmux.capture(orchestrator, 80).join("\n");
		/** Opens kept from /tasks: the cursor starts on the first run listed. */
		const openKept = async () => {
			real.tmux.sendKeys(orchestrator, ["/tasks", "Enter"]);
			await waitFor(() => expect(screen()).toMatch(/Done \(\d\)/));
			const rows = screen()
				.split("\n")
				.filter((line) => line.includes("explorer: "));
			const at = rows.findIndex((line) => line.includes("Remember PELICAN"));
			expect(at).toBeGreaterThanOrEqual(0);
			real.tmux.sendKeys(orchestrator, [...Array(at).fill("Down"), "Enter"]);
		};

		// busy holds the only slot: kept starts nothing, and the user is told why.
		await openKept();
		await waitFor(() => expect(screen()).toMatch(/No slot is free for kept \(1 of 1 runs active\)/));
		expect(screen()).not.toMatch(/waiting for 2/);
		expect(record()).toMatchObject({ status: "closed", generation: 0, summaryText: before.summaryText });

		// Once busy's slot is free, nothing of kept starts in it: its next generation was never admitted.
		writeFileSync(gate, "");
		const main = await real.waitForRequests("main", 4);
		expect(conversation(main[3]).at(-1)?.text).toContain("Held.");
		await waitFor(() =>
			expect(real.tmux.hasSession(runPaneSession(runRecord(real.agentDir, "busy").runId, 0))).toBe(false),
		);
		expect(real.tmux.hasSession(runPaneSession(runId, 1))).toBe(false);
		expect(record()).toMatchObject({ status: "closed", generation: 0, summaryText: "Remembered." });
		expect(real.requests("kept")).toHaveLength(1);

		// Opened again with the slot free, it resumes in its pane as ever.
		await openKept();
		const pane = runPaneSession(runId, 1);
		await waitFor(() => expect(real.shown()).toBe(pane));
		await waitFor(() => expect(real.tmux.capture(pane, 200).join("\n")).toContain("Remembered."));
		real.tmux.sendKeys(pane, ["Also remember HERON.", "Enter"]);
		const kept = await real.waitForRequests("kept", 2);
		expect(conversation(kept[1]).at(-1)?.text).toBe("Also remember HERON.");
		const next = await real.waitForRequests("main", 5);
		expect(conversation(next[4]).at(-1)?.text).toContain("You also said HERON.");
	}, 90_000);

	it("ends with nothing done when the user looks at a finished run and leaves without typing", async () => {
		const real = await startOrchestrator([...DEFAULT_EXTENSIONS, "background-bash"]);
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "kept", task: "Remember PELICAN." } },
			{ text: "kept remembered" },
			{ text: "nothing more" },
		]);
		real.script("kept", [{ text: "Remembered." }]);
		const orchestrator = real.start(["--", "delegate"]);
		real.attach(orchestrator);
		await real.waitForRequests("kept", 1);
		const { runId, dir } = runRecord(real.agentDir, "kept");
		const record = () => JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
		await waitFor(() => expect(record().status).toBe("closed"));
		const screen = () => real.tmux.capture(orchestrator, 80).join("\n");
		await waitFor(() => expect(screen()).toContain("kept remembered"));

		real.tmux.sendKeys(orchestrator, ["/tasks", "Enter"]);
		await waitFor(() => expect(screen()).toMatch(/Done \(1\)/));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		const pane = runPaneSession(runId, 1);
		await waitFor(() => expect(real.shown()).toBe(pane));
		await waitFor(() => expect(real.tmux.capture(pane, 200).join("\n")).toContain("Remembered."));
		real.tmux.sendKeys(pane, ["Left"]);
		await waitFor(() => expect(real.shown()).toBe(orchestrator));

		// Its pane ends, its slot with it; its model and its orchestrator's were asked nothing.
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
		await waitFor(() =>
			expect(record()).toMatchObject({ status: "closed", generation: 1, summaryText: "Remembered." }),
		);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(real.requests("kept")).toHaveLength(1);
		expect(real.requests("main")).toHaveLength(2);
		expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("Remembered.");
	});

	it("holds its work for the user after Esc in its pane, and ends as stopped once they leave", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look.", background: true } },
			{ text: "waiting for look" },
			{ text: "the user stopped it" },
		]);
		real.script("look", [{ text: "Never.", until: join(real.cwd, "never") }]);
		const orchestrator = real.start(["--", "delegate"]);
		real.attach(orchestrator);
		await real.waitForRequests("main", 2);
		await real.waitForRequests("look", 1);
		const { runId, dir } = runRecord(real.agentDir, "look");
		const pane = runPaneSession(runId, 0);
		const screen = () => real.tmux.capture(orchestrator, 80).join("\n");
		await waitFor(() => expect(screen()).toMatch(/^\s+look\s+explorer\s/m));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(pane));

		real.tmux.sendKeys(pane, ["Escape"]);
		// Held while the user is there.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(real.tmux.hasSession(pane)).toBe(true);
		real.tmux.sendKeys(pane, ["Left"]);
		await waitFor(() => expect(real.shown()).toBe(orchestrator));
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
		expect(JSON.parse(readFileSync(join(dir, "reports", "1.json"), "utf8")).outcome).toEqual({
			status: "stopped",
			error: "the user stopped its work in its pane",
		});
		// Its orchestrator is told.
		const main = await real.waitForRequests("main", 3);
		expect(conversation(main[2]).at(-1)?.text).toContain("the user stopped its work in its pane");
	});

	it("gives its model the same system prompt and tools as a run of the same role on RPC, byte for byte", async () => {
		const real = await startOrchestrator();
		pi = real;
		const settings = join(real.agentDir, "settings.json");
		const panes = (on: boolean) =>
			writeFileSync(
				settings,
				JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), subagents: { panes: on } }),
			);
		panes(false);
		const second = join(real.cwd, "second.go");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "rpc", task: "Look." } },
			{ tool: "subagent", args: { agent: "explorer", name: "pane", task: "Look." }, until: second },
			{ text: "done" },
		]);
		real.script("rpc", [{ text: "Looked." }]);
		real.script("pane", [{ text: "Looked." }]);
		real.start(["--", "delegate"]);
		const [rpc] = await real.waitForRequests("rpc", 1);
		panes(true);
		writeFileSync(second, "");
		const [pane] = await real.waitForRequests("pane", 1);
		expect(real.tmux.hasSession(runPaneSession(runRecord(real.agentDir, "pane").runId, 0))).toBe(true);

		const context = (request: FauxRequest) =>
			JSON.stringify(
				request.messages.map(({ role, content, sections, toolsAdded, toolsRemoved }) => ({
					role,
					content,
					sections,
					toolsAdded,
					toolsRemoved,
				})),
			);
		expect(real.tmux.hasSession(runPaneSession(runRecord(real.agentDir, "rpc").runId, 0))).toBe(false);
		expect(context(rpc)).toContain("You are `explorer`");
		expect(context(rpc)).toContain("subagent_message");
		expect(context(pane)).toBe(context(rpc));
	});
});
