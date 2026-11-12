import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_PROBE = fileURLToPath(new URL("./fixtures/real-pi/env-probe.ts", import.meta.url));

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

/**
 * Starts the host of the run in `runDir` in its pane `pane` ahead of the daemon, which launches the run into that pane
 * as it finds it: the host waits there until `gate` exists.
 */
function gatedHost(real: RealPi, pane: string, runDir: string, gate: string): void {
	real.tmux.startRunHost(pane, runDir, [
		"/bin/sh",
		"-c",
		`while [ ! -e '${gate}' ]; do sleep 0.05; done; exec "$@"`,
		"sh",
		process.execPath,
		"--import",
		join(ROOT, "daemon/pi-resolve-hook.mjs"),
		join(ROOT, "ext/subagents/rpc-host.ts"),
		runDir,
	]);
}

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

	it("does not start when the daemon restarted before its host took the run's environment, and frees its slot", async () => {
		const real = await startOrchestrator();
		pi = real;
		vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, ENV_PROBE].join(":"));
		const settings = join(real.agentDir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), subagents: { maxActive: 1 } }),
		);
		const [holdGo, lookGo, nextGo, nextDone, hostGo] = ["hold", "look", "next", "next.done", "host"].map((name) =>
			join(real.cwd, `${name}.go`),
		);
		const launch = (name: string) => ({
			tool: "subagent",
			args: { agent: "explorer", name, task: "Look.", background: true },
		});
		real.script("main", [
			launch("hold"),
			{ ...launch("look"), until: lookGo },
			{ ...launch("next"), until: nextGo },
			...Array(6).fill({ text: "waiting" }),
		]);
		real.script("hold", [{ text: "Held.", until: holdGo }]);
		real.script("look", [{ text: "Looked." }]);
		real.script("next", [{ text: "Next.", until: nextDone }]);
		// In the orchestrator's environment only, not tmux's once it started: a run gets it from the daemon alone.
		const secret = `SECRET-${randomUUID()}`;
		vi.stubEnv("BC_TEST_SECRET", secret);
		real.start(["--", "delegate"]);
		spawnSync("tmux", ["-S", real.tmux.socket, "set-environment", "-g", "-u", "BC_TEST_SECRET"]);
		await real.waitForRequests("hold", 1);
		writeFileSync(lookGo, "");
		const record = (name: string) =>
			JSON.parse(readFileSync(join(runRecord(real.agentDir, name).dir, "record.json"), "utf8"));
		await waitFor(() => expect(record("look").status).toBe("starting"));

		// Its host waits in its pane until the daemon that launched it is gone and another runs.
		const { runId, dir } = runRecord(real.agentDir, "look");
		gatedHost(real, runPaneSession(runId, 0), dir, hostGo);
		writeFileSync(holdGo, "");
		await waitFor(() => expect(record("look").status).toBe("running"));
		writeFileSync(nextGo, "");
		await waitFor(() => expect(record("next").status).toBe("starting"));
		expect((await real.client.shutdownDaemon()).ok).toBe(true);
		// Its orchestrator starts the next daemon, claiming next's turn.
		await waitFor(async () => expect(await real.client.isRunning()).toBe(true));
		writeFileSync(hostGo, "");

		await waitFor(() =>
			expect(record("look")).toMatchObject({
				status: "failed",
				errorMessage: expect.stringMatching(
					/^It did not start: the daemon restarted, or could not be reached, between launching the run.s host and that host taking/,
				),
			}),
		);
		await waitFor(() =>
			expect(JSON.stringify(real.requests("main").map(conversation))).toMatch(
				/Subagent \\"look\\" \(sub_[^)]+\) did not start: the daemon restarted/,
			),
		);
		expect(real.requests("look")).toEqual([]);
		// Its slot is free: next starts, with the orchestrator's environment from the daemon.
		await real.waitForRequests("next", 1);
		const next = runRecord(real.agentDir, "next");
		await waitFor(() => expect(readFileSync(join(next.dir, "env-probe"), "utf8")).toBe("set"));
		// Neither on disk nor on a command line: what its pane was started with holds pi's state directories only.
		const base = dirname(real.agentDir);
		const found = spawnSync("grep", ["-rlF", "-D", "skip", secret, base], { encoding: "utf8" });
		expect({ status: found.status, stdout: found.stdout }).toEqual({ status: 1, stdout: "" });
		const started = spawnSync(
			"tmux",
			["-S", real.tmux.socket, "show-environment", "-t", `=${runPaneSession(next.runId, 0)}`],
			{ encoding: "utf8" },
		).stdout;
		expect(started).toContain("PI_SERVER_DIR=");
		expect(started).not.toContain(secret);
		const commands = spawnSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" })
			.stdout.split("\n")
			.filter((line) => line.includes(basename(base)))
			.join("\n");
		const panes = spawnSync("tmux", ["-S", real.tmux.socket, "list-panes", "-a", "-F", "#{pane_start_command}"], {
			encoding: "utf8",
		}).stdout;
		expect(`${commands}${panes}`).not.toContain(secret);
		writeFileSync(nextDone, "");
	}, 90_000);

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

	it("resumes once finished in a pane the user types its next instruction in, opened from /tasks", async () => {
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
		const main = await real.waitForRequests("main", 3);
		expect(conversation(main[2]).at(-1)?.text).toContain("You also said HERON.");
		await waitFor(() => expect(real.tmux.hasSession(pane)).toBe(false));
		await waitFor(() => expect(real.shown()).toBe(orchestrator));
	});

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

	it("ends as stopped when its pane is ended from outside: its orchestrator gets its Report, its changes are kept", async () => {
		const real = await startOrchestrator();
		pi = real;
		writeFileSync(join(real.cwd, "a.txt"), "one\n");
		for (const args of [
			["init", "-q"],
			["add", "."],
			["commit", "-q", "-m", "start"],
		]) {
			spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args], {
				cwd: real.cwd,
			});
		}
		const settings = join(real.agentDir, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), subagents: { maxActive: 1 } }),
		);
		const writer = { name: "writer", description: "Edits.", instructions: "Edit.", tools: ["read", "write"] };
		const nextGo = join(real.cwd, "next.go");
		real.script("main", [
			{ tool: "subagent", args: { agent: writer, name: "edit", task: "Edit.", background: true } },
			{
				tool: "subagent",
				args: { agent: "explorer", name: "next", task: "Look.", background: true },
				until: nextGo,
			},
			...Array(4).fill({ text: "waiting" }),
		]);
		real.script("edit", [
			{ tool: "write", args: { path: "new.txt", content: "new\n" } },
			{ text: "Never.", until: join(real.cwd, "never") },
		]);
		real.script("next", [{ text: "Next." }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("edit", 2);
		// Queued behind it.
		writeFileSync(nextGo, "");
		await waitFor(() =>
			expect(
				JSON.parse(readFileSync(join(runRecord(real.agentDir, "next").dir, "record.json"), "utf8")).status,
			).toBe("starting"),
		);
		expect(real.requests("next")).toEqual([]);
		const { runId, dir } = runRecord(real.agentDir, "edit");
		const pane = runPaneSession(runId, 0);

		expect(spawnSync("tmux", ["-S", real.tmux.socket, "kill-session", "-t", `=${pane}`]).status).toBe(0);
		const told = () =>
			real
				.requests("main")
				.flatMap(conversation)
				.find(({ text }) => text.includes("Outcome: stopped"))?.text;
		await waitFor(() => expect(told()).toBeDefined());
		const report = told() ?? "";
		expect(report).toContain("Outcome: stopped: its pane was ended.");
		expect(report).toMatch(/^Changes since its baseline: A new\.txt$/m);
		const workspace = /^Workspace: (.+?), an isolated Git worktree/m.exec(report)?.[1] ?? "";
		expect(readFileSync(join(workspace, "new.txt"), "utf8")).toBe("new\n");
		await waitFor(() =>
			expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8"))).toMatchObject({ status: "closed" }),
		);
		// Its slot is free.
		await real.waitForRequests("next", 1);
	});

	it("leaves a Resume as it was when the daemon has no environment for its host", async () => {
		const real = await startOrchestrator();
		pi = real;
		const resume = join(real.cwd, "resume.go");
		const hostGo = join(real.cwd, "host.go");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "kept", task: "Remember PELICAN." } },
			{ tool: "subagent_resume", args: { agent: "kept", task: "Look again." }, until: resume },
			...Array(3).fill({ text: "waiting" }),
		]);
		real.script("kept", [{ text: "Remembered." }, { text: "Looked again." }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("kept", 1);
		const { runId, dir } = runRecord(real.agentDir, "kept");
		const record = () => JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
		await waitFor(() => expect(record()).toMatchObject({ status: "closed", generation: 0 }));
		const pane = runPaneSession(runId, 1);
		gatedHost(real, pane, dir, hostGo);
		writeFileSync(resume, "");
		await waitFor(() => expect(record()).toMatchObject({ status: "running", generation: 1 }));

		// Taken before its host asks, as a daemon started since would not have it.
		await real.client.takeRunEnv(pane);
		writeFileSync(hostGo, "");
		await waitFor(() =>
			expect(record()).toMatchObject({
				status: "closed",
				generation: 1,
				errorMessage: expect.stringMatching(/^It did not start: the daemon restarted/),
			}),
		);
		expect(real.requests("kept")).toHaveLength(1);
	}, 60_000);

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
