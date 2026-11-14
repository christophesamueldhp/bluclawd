import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readinessMs } from "./helpers/heartbeats.ts";
import { conversation, FAUX, type FauxRequest, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** A run's directory, as its orchestrator stored it, by the run's name. */
function runDir(agentDir: string, name: string): string {
	const root = join(agentDir, "bluclawd", "subagents");
	for (const session of existsSync(root) ? readdirSync(root) : []) {
		for (const run of readdirSync(join(root, session))) {
			const record = join(root, session, run, "record.json");
			if (existsSync(record) && JSON.parse(readFileSync(record, "utf8")).name === name)
				return join(root, session, run);
		}
	}
	throw new Error(`no run named ${name}`);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const recordOf = (real: RealPi, name: string) => readJson(join(runDir(real.agentDir, name), "record.json"));
const hostOf = (real: RealPi, name: string) => readJson(join(runDir(real.agentDir, name), "rpc-host.json"));

/** Merges `added` into the settings every pi of the test reads, as they are read next. */
function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...readJson(path), ...added }));
}

/** A background batch of explorers named `names`. */
const batch = (...names: string[]) => ({
	tool: "subagent",
	args: { tasks: names.map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` })), background: true },
});

/** How many messages of the conversation `request` sent hold `text`. */
const countHolding = (request: FauxRequest, text: string) =>
	conversation(request).filter((message) => message.text.includes(text)).length;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RPC_HOST = fileURLToPath(new URL("../ext/subagents/rpc-host.ts", import.meta.url));
const RESOLVE_HOOK = fileURLToPath(new URL("../daemon/pi-resolve-hook.mjs", import.meta.url));
const LINGERER = fileURLToPath(new URL("./fixtures/real-pi/lingerer.ts", import.meta.url));

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * An orchestrator pane whose runs are RPC children, which load the faux provider and `extensions`, in a tmux server a
 * session of its own keeps up: crashing the orchestrator, its only pane, would otherwise end the server, and the pane
 * reopening it could not start.
 */
async function startOrchestrator(extensions: string[] = []): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", [FAUX, ...extensions].join(":"));
	const real = await startRealPi();
	real.tmux.newSession({ cwd: real.cwd, command: ["sleep", "3600"], args: [] });
	return real;
}

/** The session file of the orchestrator in `pane`, as the daemon has it. */
const sessionFileOf = (real: RealPi, pane: string) =>
	waitFor(async () => {
		const file = (await real.rows()).find((row) => row.pane === pane)?.sessionFile;
		expect(file).toBeDefined();
		return file ?? "";
	});

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

/** A committed repository in `dir`: a chain with a step that edits works in a worktree made from it. */
function repository(dir: string): void {
	writeFileSync(join(dir, "a.txt"), "one\n");
	for (const args of [
		["init", "-q"],
		["add", "."],
		[
			"-c",
			"user.name=F",
			"-c",
			"user.email=f@example.com",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"-m",
			"start",
		],
	]) {
		expect(spawnSync("git", args, { cwd: dir }).status).toBe(0);
	}
}

/** An inline role that edits files: it works in a worktree, its chain's. */
const writer = {
	name: "writer",
	description: "Edits files.",
	instructions: "Make the change asked.",
	tools: ["read", "edit", "write"],
};

/** A launch of an explorer named `name`, in the background. */
const launch = (name: string) => ({
	tool: "subagent",
	args: { agent: "explorer", name, task: `Look, ${name}.`, background: true },
});

describe.skipIf(!hasTmux)("recovering RPC runs", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it(
		"lets a working run finish after its orchestrator crashed, and tells the reopened orchestrator its Report once",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const gate = join(real.cwd, "worker.go");
			real.script("main", [launch("worker"), { text: "waiting for worker" }, { text: "read the report" }]);
			real.script("worker", [{ text: "Worked.", until: gate }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("worker", 1);
			await real.waitForRequests("main", 2);
			const sessionFile = await sessionFileOf(real, pane);
			// Its host launched again, as after a lost reply, leaves the generation to the one that took it.
			const dir = runDir(real.agentDir, "worker");
			const state = readFileSync(join(dir, "rpc-host.json"), "utf8");
			const again = spawnSync(process.execPath, ["--import", RESOLVE_HOOK, RPC_HOST, dir], { timeout: readinessMs });
			expect(again.status).toBe(0);
			expect(readFileSync(join(dir, "rpc-host.json"), "utf8")).toBe(state);

			crash(real, pane);
			// Another session, not the run's orchestrator's, is told nothing of it and takes nothing over.
			real.start([]);
			// Its orchestrator gone, the run goes on with its admitted work, and stores its Report.
			writeFileSync(gate, "");
			await waitFor(() => expect(hostOf(real, "worker").exit).toBeDefined());
			expect(readJson(join(dir, "reports", "1.json")).outcome).toEqual({ status: "completed" });
			await sleep(2000);
			expect(real.requests("main")).toHaveLength(2);
			expect(recordOf(real, "worker").status).toBe("running");

			real.start(["--session", sessionFile]);
			const requests = await real.waitForRequests("main", 3);
			expect(countHolding(requests[2], "Worked.")).toBe(1);
			await waitFor(() => expect(recordOf(real, "worker").status).toBe("closed"));
			await sleep(2000);
			expect(real.requests("main")).toHaveLength(3);
			expect(real.requests("worker")).toHaveLength(1);
		},
		4 * readinessMs,
	);

	it(
		"tells the reopened orchestrator once of a blocker its crashed instance held and never took",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const gate = join(real.cwd, "look.go");
			real.script("main", [
				launch("look"),
				// Its model never answers: the blocker waits in memory for the turn to end, which never comes.
				{ text: "never answered", until: join(real.cwd, "never") },
				{ text: "noted the blocker" },
				{ text: "read the report" },
			]);
			real.script("look", [
				{ tool: "subagent_message", args: { kind: "blocker", content: "Which directory holds HERON?" } },
				{ text: "Done without HERON.", until: gate },
			]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("main", 2);
			const sessionFile = await sessionFileOf(real, pane);
			const { parentSessionId, runId } = recordOf(real, "look");
			const audit = join(real.agentDir, "bluclawd", "subagents", parentSessionId, "messages.jsonl");
			// Accepted for the orchestrator, which holds it to steer the turn under way.
			await waitFor(() => expect(existsSync(audit) && readFileSync(audit, "utf8")).toContain(runId));

			crash(real, pane);
			real.start(["--session", sessionFile]);
			const requests = await real.waitForRequests("main", 3);
			expect(countHolding(requests[2], "Which directory holds HERON?")).toBe(1);
			// Its session holds it now, so the relay goes on past it: a later takeover relays it no more.
			const relayed = join(runDir(real.agentDir, "look"), "outbox", "0.relayed");
			await waitFor(() => expect(existsSync(relayed) && readFileSync(relayed, "utf8")).toBe("1"));
			writeFileSync(gate, "");
			const reported = await real.waitForRequests("main", 4);
			expect(countHolding(reported[3], "Done without HERON.")).toBe(1);
			expect(countHolding(reported[3], "Which directory holds HERON?")).toBe(1);
			await sleep(2000);
			expect(real.requests("main")).toHaveLength(4);
		},
		4 * readinessMs,
	);

	it(
		"reports a run whose host died while its orchestrator was gone as uncertain, and never starts its work again",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			real.script("main", [launch("worker"), { text: "waiting for worker" }, { text: "noted the loss" }]);
			real.script("worker", [{ text: "Never.", until: join(real.cwd, "never") }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("worker", 1);
			await real.waitForRequests("main", 2);
			const sessionFile = await sessionFileOf(real, pane);

			crash(real, pane);
			// Its host and pi die too, mid-work, with nothing stored: no exit, no Report.
			const { hostPid } = hostOf(real, "worker");
			process.kill(-hostPid, "SIGKILL");
			await waitFor(() => expect(() => process.kill(-hostPid, 0)).toThrow());

			real.start(["--session", sessionFile]);
			const requests = await real.waitForRequests("main", 3);
			expect(conversation(requests[2]).at(-1)?.text).toMatch(
				/worker.*ended while its orchestrator's session was gone.*uncertain/s,
			);
			const record = recordOf(real, "worker");
			expect(record.status).toBe("failed");
			expect(record.errorMessage).toMatch(/uncertain.*not started again/s);
			await sleep(2000);
			expect(real.requests("worker")).toHaveLength(1);
			expect(readdirSync(join(runDir(real.agentDir, "worker"), "hosts"))).toEqual(["0"]);
		},
		4 * readinessMs,
	);

	/**
	 * A batch of two with one slot: one member works, the other waits its turn. Which one works is the daemon's: the
	 * members claim their slots side by side, so their claims may reach it in any order. Resolves once the orchestrator
	 * crashed with both so, and the working one was let go on to finish while it was gone.
	 */
	async function crashWithQueuedMember(real: RealPi) {
		addSettings(real, { subagents: { panes: false, maxActive: 1 } });
		const names = ["first", "second"];
		const gate = (name: string) => join(real.cwd, `${name}.go`);
		real.script("main", [batch(...names), { text: "waiting" }, { text: "noted" }, { text: "noted again" }]);
		for (const name of names) real.script(name, [{ text: `${name} done.`, until: gate(name) }]);
		const pane = real.start(["--", "delegate"]);
		const [working] = await waitFor(() => {
			const started = names.filter((name) => real.requests(name).length > 0);
			expect(started).toHaveLength(1);
			return started;
		});
		const [queued] = names.filter((name) => name !== working);
		await real.waitForRequests("main", 2);
		const sessionFile = await sessionFileOf(real, pane);
		expect(recordOf(real, queued).status).toBe("starting");

		crash(real, pane);
		for (const name of names) writeFileSync(gate(name), "");
		await waitFor(() => expect(hostOf(real, working).exit).toBeDefined());
		// Its slot is free, and no orchestrator is there to revalidate it: the queued member waits.
		await sleep(3000);
		expect(real.requests(queued)).toHaveLength(0);
		expect(existsSync(join(runDir(real.agentDir, queued), "rpc-host.json"))).toBe(false);
		return { sessionFile, working, queued };
	}

	it(
		"pauses a queued batch member while its orchestrator is gone, and starts it once the reopened orchestrator may",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const { sessionFile, working, queued } = await crashWithQueuedMember(real);

			real.start(["--session", sessionFile]);
			await real.waitForRequests(queued, 1);
			await waitFor(() => expect(recordOf(real, queued).status).toBe("closed"));
			await waitFor(() => {
				const last = real.requests("main").at(-1);
				expect(last && countHolding(last, `${working} done.`)).toBe(1);
				expect(last && countHolding(last, `${queued} done.`)).toBe(1);
			});
			expect(real.requests(working)).toHaveLength(1);
		},
		4 * readinessMs,
	);

	it(
		"refuses a queued member the reopened orchestrator may no longer start: it never gets a process or a model call",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const { sessionFile, working, queued } = await crashWithQueuedMember(real);
			addSettings(real, { permissions: { deny: ["Subagent(explorer)"] } });

			real.start(["--session", sessionFile]);
			await waitFor(() => expect(recordOf(real, queued).status).toBe("failed"));
			expect(recordOf(real, queued).errorMessage).toMatch(/did not start.*Subagent\(explorer\)/s);
			await waitFor(() => {
				const last = real.requests("main").at(-1);
				expect(last && countHolding(last, `${working} done.`)).toBe(1);
			});
			await sleep(2000);
			expect(real.requests(queued)).toHaveLength(0);
			expect(existsSync(join(runDir(real.agentDir, queued), "rpc-host.json"))).toBe(false);
		},
		4 * readinessMs,
	);

	it(
		"keeps a run working across a reload of its orchestrator, which relays nothing twice and is woken by its Report once",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const gate = join(real.cwd, "look.go");
			real.script("main", [
				launch("look"),
				{ text: "waiting for look" },
				{ text: "noted the finding" },
				{ text: "read the report" },
			]);
			real.script("look", [
				{ tool: "subagent_message", args: { kind: "finding", content: "Found HERON." } },
				{ text: "Done after the reload.", until: gate },
			]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("main", 3);

			real.tmux.sendKeys(pane, ["/reload", "Enter"]);
			await waitFor(() => expect(real.tmux.capture(pane, 50).join("\n")).toMatch(/Reloaded/i));
			expect(recordOf(real, "look").status).toBe("running");
			writeFileSync(gate, "");
			const requests = await real.waitForRequests("main", 4);
			expect(countHolding(requests[3], "Done after the reload.")).toBe(1);
			expect(countHolding(requests[3], "Found HERON.")).toBe(1);
			await waitFor(() => expect(recordOf(real, "look").status).toBe("closed"));
			await sleep(2000);
			expect(real.requests("main")).toHaveLength(4);
			expect(real.requests("look")).toHaveLength(2);
		},
		4 * readinessMs,
	);

	it(
		"keeps a stop requested before its orchestrator crashed: the reopened orchestrator ends the run cancelled, never restarted",
		async () => {
			// What the run's pi leaves in its group ignores SIGTERM: the stop takes its whole grace, still under way.
			const real = await startOrchestrator([LINGERER]);
			pi = real;
			real.script("main", [
				launch("work"),
				{ text: "waiting for work" },
				{ tool: "subagent_stop", args: { agent: "work" } },
				{ text: "never answered" },
			]);
			real.script("work", [{ text: "Never.", until: join(real.cwd, "never") }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("work", 1);
			await real.waitForRequests("main", 2);
			const sessionFile = await sessionFileOf(real, pane);
			const lingerer = Number(readFileSync(join(real.cwd, "lingerer.pid"), "utf8"));

			real.tmux.sendKeys(pane, ["stop work", "Enter"]);
			await waitFor(() => expect(recordOf(real, "work").status).toBe("stopping"));
			crash(real, pane);
			expect(alive(lingerer)).toBe(true);

			real.start(["--session", sessionFile]);
			await waitFor(() =>
				expect(recordOf(real, "work")).toMatchObject({ status: "cancelled", stopSource: "model" }),
			);
			expect(alive(lingerer)).toBe(false);
			await sleep(1000);
			expect(real.requests("work")).toHaveLength(1);
			expect(readdirSync(join(runDir(real.agentDir, "work"), "hosts"))).toEqual(["0"]);
		},
		4 * readinessMs,
	);

	it(
		"holds a working run's slot in the daemon started after its daemon ended: a run launched then waits its turn",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			addSettings(real, { subagents: { panes: false, maxActive: 1 } });
			const gate = join(real.cwd, "first.go");
			real.script("main", [
				launch("first"),
				{ text: "waiting for first" },
				launch("second"),
				{ text: "waiting for both" },
				{ text: "noted one" },
				{ text: "noted the other" },
			]);
			real.script("first", [{ text: "First done.", until: gate }]);
			real.script("second", [{ text: "Second done." }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("first", 1);
			await real.waitForRequests("main", 2);

			// The daemon ends; the run's host does not, and the next daemon must count it.
			await real.client.shutdownDaemon();
			await waitFor(async () => expect(await real.client.isRunning()).toBe(false));
			real.tmux.sendKeys(pane, ["launch second", "Enter"]);
			await real.waitForRequests("main", 4);
			await sleep(3000);
			expect(real.requests("second")).toHaveLength(0);
			expect(recordOf(real, "second").status).toBe("starting");

			writeFileSync(gate, "");
			await real.waitForRequests("second", 1);
			await waitFor(() => expect(recordOf(real, "second").status).toBe("closed"));
		},
		4 * readinessMs,
	);

	// Four pis one after another (a, the orchestrator reopened, b, then a's Resume): a readiness bound for each to
	// start, and one for the rest.
	it(
		"pauses a chain's later steps while its orchestrator is gone, and goes on with them once it is reopened",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const gate = join(real.cwd, "a.go");
			real.script("main", [
				{
					tool: "subagent",
					args: {
						chain: [
							{ agent: "explorer", name: "a", task: "Look first." },
							{ agent: "explorer", name: "b", task: "Look next." },
							{ resume: "a", task: "Look again." },
						],
						background: true,
					},
				},
				{ text: "waiting for the chain" },
				{ text: "read the chain" },
			]);
			real.script("a", [{ text: "A done.", until: gate }, { text: "A again." }]);
			real.script("b", [{ text: "B done." }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("a", 1);
			await real.waitForRequests("main", 2);
			const sessionFile = await sessionFileOf(real, pane);

			crash(real, pane);
			writeFileSync(gate, "");
			await waitFor(() => expect(hostOf(real, "a").exit).toBeDefined());
			// Its next step is for an orchestrator to admit, and none is there.
			await sleep(3000);
			expect(real.requests("b")).toHaveLength(0);

			real.start(["--session", sessionFile]);
			const [b] = await real.waitForRequests("b", 1);
			expect(countHolding(b, "A done.")).toBe(1);
			const a = await real.waitForRequests("a", 2);
			expect(countHolding(a[1], "B done.")).toBe(1);
			const main = await real.waitForRequests("main", 3);
			expect(conversation(main[2]).at(-1)?.text).toMatch(/Chain chain_\w+: 3 steps, all completed\./);
			await sleep(2000);
			expect(real.requests("main")).toHaveLength(3);
			expect(real.requests("b")).toHaveLength(1);
		},
		5 * readinessMs,
	);

	it(
		"tells the reopened orchestrator of a batch member that ended before the crash, its Report taken by a batch that never settled",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const gate = join(real.cwd, "second.go");
			real.script("main", [
				batch("first", "second"),
				{ text: "waiting" },
				{ text: "noted" },
				{ text: "noted again" },
			]);
			real.script("first", [{ text: "First done." }]);
			real.script("second", [{ text: "Second done.", until: gate }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("second", 1);
			await waitFor(() => expect(recordOf(real, "first").status).toBe("closed"));
			await real.waitForRequests("main", 2);
			const sessionFile = await sessionFileOf(real, pane);

			crash(real, pane);
			real.start(["--session", sessionFile]);
			writeFileSync(gate, "");
			await waitFor(() => expect(recordOf(real, "second").status).toBe("closed"));
			await waitFor(() => {
				const last = real.requests("main").at(-1);
				expect(last && countHolding(last, "First done.")).toBe(1);
				expect(last && countHolding(last, "Second done.")).toBe(1);
			});
			await sleep(2000);
			const last = real.requests("main").at(-1);
			expect(last && countHolding(last, "First done.")).toBe(1);
			expect(real.requests("first")).toHaveLength(1);
		},
		4 * readinessMs,
	);

	// Four pis one after another (a, b, the orchestrator reopened, then a's Resume): a readiness bound for each to
	// start, and one for the rest.
	it(
		"goes on with a chain whose step was working when its orchestrator crashed, admitting the next step once reopened",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const gate = join(real.cwd, "b.go");
			real.script("main", [
				{
					tool: "subagent",
					args: {
						chain: [
							{ agent: "explorer", name: "a", task: "Look first." },
							{ agent: "explorer", name: "b", task: "Look next." },
							{ resume: "a", task: "Look again." },
						],
						background: true,
					},
				},
				{ text: "waiting for the chain" },
				{ text: "read the chain" },
			]);
			real.script("a", [{ text: "A done." }, { text: "A again." }]);
			real.script("b", [{ text: "B done.", until: gate }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("b", 1);
			await real.waitForRequests("main", 2);
			const sessionFile = await sessionFileOf(real, pane);

			crash(real, pane);
			writeFileSync(gate, "");
			await waitFor(() => expect(hostOf(real, "b").exit).toBeDefined());
			await sleep(3000);
			expect(real.requests("a")).toHaveLength(1);

			real.start(["--session", sessionFile]);
			const a = await real.waitForRequests("a", 2);
			expect(countHolding(a[1], "B done.")).toBe(1);
			const main = await real.waitForRequests("main", 3);
			const aggregate = conversation(main[2]).at(-1)?.text ?? "";
			expect(aggregate).toMatch(/Chain chain_\w+: 3 steps, all completed\./);
			expect(aggregate).toContain("A again.");
			await sleep(2000);
			expect(real.requests("main")).toHaveLength(3);
			expect(real.requests("b")).toHaveLength(1);
		},
		5 * readinessMs,
	);

	// Four pis one after another (a, b, the orchestrator reopened, then c): a readiness bound for each to start, and one
	// for the rest.
	it(
		"gives a chain taken over after a step that edits completed the checks of every step, as one never taken over",
		async () => {
			const real = await startOrchestrator();
			pi = real;
			repository(real.cwd);
			const gate = join(real.cwd, "..", "b.go");
			real.script("main", [
				{
					tool: "subagent",
					args: {
						chain: [
							{ agent: writer, name: "a", task: "Write new.txt." },
							{ agent: "explorer", name: "b", task: "Look next." },
							{ agent: "explorer", name: "c", task: "Look last." },
						],
						background: true,
					},
				},
				{ text: "waiting for the chain" },
				{ text: "read the chain" },
			]);
			real.script("a", [{ tool: "write", args: { path: "new.txt", content: "v1\n" } }, { text: "Wrote v1." }]);
			real.script("b", [{ text: "B done.", until: gate }]);
			real.script("c", [{ text: "C done." }]);
			const pane = real.start(["--", "delegate"]);
			await real.waitForRequests("b", 1);
			await real.waitForRequests("main", 2);
			const sessionFile = await sessionFileOf(real, pane);

			crash(real, pane);
			writeFileSync(gate, "");
			await waitFor(() => expect(hostOf(real, "b").exit).toBeDefined());

			real.start(["--session", sessionFile]);
			const [c] = await real.waitForRequests("c", 1);
			expect(countHolding(c, "B done.")).toBe(1);
			expect(conversation(c)[0].text).toMatch(/Changes since its baseline: .*A new\.txt/);
			const main = await real.waitForRequests("main", 3);
			const aggregate = conversation(main[2]).at(-1)?.text ?? "";
			expect(aggregate).toMatch(/Chain chain_\w+: 3 steps, all completed\./);
			expect(aggregate).toMatch(/### chain\[0\] "a" \(sub_[\w-]+\): completed\nChecks: [^\n]+\nWrote v1\./);
			expect(aggregate).toMatch(/### chain\[1\] "b" \(sub_[\w-]+\): completed\nChecks: [^\n]+\nB done\./);
			expect(aggregate).toMatch(/### chain\[2\] "c" \(sub_[\w-]+\): completed\nChecks: [^\n]+\nC done\./);
			await sleep(2000);
			expect(real.requests("main")).toHaveLength(3);
			expect(real.requests("c")).toHaveLength(1);
		},
		5 * readinessMs,
	);
});
