import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { remoteSessions } from "../daemon/remote/sessions.ts";
import { collectRows } from "../daemon/rows.ts";
import { HEARTBEAT_MS } from "../ext/agent-view/self-registration.ts";
import { writePersistedRunRecord } from "../ext/subagents/storage.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";
import {
	conversation,
	DEFAULT_EXTENSIONS,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
} from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The last tool result the model was given: the active-run reminder may follow it. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

/** The tmux sessions running. */
const panes = (real: RealPi) => [...real.screens().matchAll(/^--- (\S+) ---$/gm)].map((match) => match[1]);

/** The run's directory, wherever the orchestrator's session keeps it. */
function sessionDir(agentDir: string, runId: string): string {
	const root = join(agentDir, "bluclawd", "subagents");
	const session = readdirSync(root).find((dir) => existsSync(join(root, dir, runId)));
	return join(root, session ?? "", runId);
}

/** The session files kept in a run's directory. */
function sessionFiles(agentDir: string, runId: string): string[] {
	const dir = sessionDir(agentDir, runId);
	return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".jsonl")) : [];
}

describe.skipIf(!hasTmux)("closing a run", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("ends its pi without asking it, keeps its session, and leaves no row in agent view or on the phone", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around." } },
			{ tool: "subagent_close", args: { agent: "probe-run" } },
			{ tool: "subagent_status", args: {} },
			{ text: "closed" },
		]);
		real.script("probe-run", [{ text: "Looked." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		const requests = await real.waitForRequests("main", 4);

		const close = lastToolResult(requests[2]);
		expect(close).toMatchObject({ role: "toolResult", toolName: "subagent_close" });
		expect(close?.text).toMatch(
			/^Closed "probe-run" \(sub_[0-9a-f-]+\)\. Its session is kept: a message resumes it\.$/,
		);
		const runId = close?.text.match(/sub_[0-9a-f-]+/)?.[0] ?? "";
		expect(lastToolResult(requests[3])?.text).toBe("No subagents are running.");

		await waitFor(() => expect(panes(real)).toEqual([orchestrator]));
		expect(sessionFiles(real.agentDir, runId)).toHaveLength(1);
		// Its pi saves its row once it is gone: a run's row keeps its parent.
		await waitFor(async () =>
			expect((await real.rows()).find((row) => row.label === "probe-run")).toMatchObject({
				status: "stopped",
				parent: orchestrator,
			}),
		);
		await waitFor(async () => {
			const rows = await real.rows();
			expect(collectRows(rows, undefined).map((row) => row.pane)).toEqual([orchestrator]);
			expect(remoteSessions(rows).map((session) => session.id)).toEqual([orchestrator]);
		});
	});

	it("is what x does in the panel, and a closed run leaves the panel", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
		]);
		real.script("probe-run", [{ text: "Looked." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 3);
		const screen = () => real.tmux.capture(orchestrator, 50).join("\n");
		const panelRow = /^\s+probe-run\s+explorer\s/m;
		await waitFor(() => expect(screen()).toMatch(panelRow));
		expect(panes(real)).toHaveLength(2);

		real.tmux.sendKeys(orchestrator, ["Down"]);
		await waitFor(() => expect(screen()).toContain("x to close"));
		real.tmux.sendKeys(orchestrator, ["x"]);
		await waitFor(() => expect(panes(real)).toEqual([orchestrator]));
		await waitFor(() => expect(screen()).not.toMatch(panelRow));
	});

	it("leaves a run the terminal shows open until the terminal leaves it", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
			{ tool: "subagent_close", args: { agent: "probe-run" } },
			{ text: "closed" },
		]);
		real.script("probe-run", [{ text: "Looked." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		real.attach(orchestrator);
		await real.waitForRequests("main", 3);
		const run = (await real.rows()).find((row) => row.label === "probe-run")?.pane ?? "";
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(run));

		real.tmux.sendKeys(orchestrator, ["close it", "Enter"]);
		await real.waitForRequests("main", 5);
		const screen = () => real.tmux.capture(run, 50).join("\n");
		await waitFor(() => expect(screen()).toContain("Closed by its orchestrator"));
		expect(real.shown()).toBe(run);
		expect(panes(real)).toHaveLength(2);
		// Closed, it takes no more prompts.
		real.tmux.sendKeys(run, ["go on", "Enter"]);
		await waitFor(() => expect(screen()).toContain("ask its orchestrator to resume it"));
		expect(real.requests("probe-run")).toHaveLength(1);

		real.tmux.sendKeys(run, ["C-u", "Left", "Left"]);
		await waitFor(() => expect(real.shown()).toBe(orchestrator));
		await waitFor(() => expect(panes(real)).toEqual([orchestrator]));
	});

	it("moves the terminal on to a closed run's next Generation when its orchestrator resumes it", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
			{ tool: "subagent_close", args: { agent: "probe-run" } },
			{ text: "closed" },
			{ tool: "subagent_message", args: { to: "probe-run", content: "Look again." } },
			{ text: "resumed" },
			{ text: "read the second report" },
		]);
		real.script("probe-run", [{ text: "Looked." }, { text: "Looked again." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		real.attach(orchestrator);
		await real.waitForRequests("main", 3);
		const first = (await real.rows()).find((row) => row.label === "probe-run")?.pane ?? "";
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(first));
		real.tmux.sendKeys(orchestrator, ["close it", "Enter"]);
		await real.waitForRequests("main", 5);
		await waitFor(() => expect(real.tmux.capture(first, 50).join("\n")).toContain("Closed by its orchestrator"));

		real.tmux.sendKeys(orchestrator, ["resume it", "Enter"]);
		await real.waitForRequests("probe-run", 2);
		await waitFor(() => expect(panes(real)).toHaveLength(2));
		const next = panes(real).find((pane) => pane !== orchestrator) ?? "";
		expect(next).not.toBe(first);
		expect(real.shown()).toBe(next);
		await real.waitForRequests("main", 8);
		await waitFor(async () =>
			expect((await real.rows()).filter((row) => row.label === "probe-run").map((row) => row.pane)).toEqual([next]),
		);
	});

	it("leaves a run the terminal shows open when its orchestrator quits, and ← there opens agent view", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
		]);
		real.script("probe-run", [{ text: "Looked." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		real.attach(orchestrator);
		await real.waitForRequests("main", 3);
		const run = (await real.rows()).find((row) => row.label === "probe-run")?.pane ?? "";
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(run));

		real.tmux.sendKeys(orchestrator, ["/quit", "Enter"]);
		const screen = () => real.tmux.capture(run, 50).join("\n");
		await waitFor(() => expect(screen()).toContain("Closed by its orchestrator"));
		await waitFor(() => expect(panes(real)).toEqual([run]));
		// Past the run's next heartbeats, at which the daemon ends a run whose orchestrator is gone.
		await new Promise((resolve) => setTimeout(resolve, 2 * HEARTBEAT_MS));
		expect(panes(real)).toEqual([run]);
		expect(real.shown()).toBe(run);

		real.tmux.sendKeys(run, ["Left", "Left"]);
		await waitFor(() => expect(screen()).toContain("enter to open"));
		expect(screen()).not.toContain("Could not go back");
	});

	it("is what ending the orchestrator's session does to its runs", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
		]);
		real.script("probe-run", [{ text: "Looked." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 3);
		expect(panes(real)).toHaveLength(2);

		real.tmux.sendKeys(orchestrator, ["/new", "Enter"]);
		await waitFor(() => expect(panes(real)).toEqual([orchestrator]));
	});
});

describe.skipIf(!hasTmux)("stopping a run", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("ends its turn in progress, as Esc does, and leaves its pi open to take messages", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ tool: "subagent_stop", args: { agent: "probe-run" } },
			{ tool: "subagent_status", args: { agent: "probe-run" } },
			{ text: "stopped its turn" },
		]);
		real.script("probe-run", [{ text: "Still looking.", stallMs: 120_000 }, { text: "Went on." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 2);
		await real.waitForRequests("probe-run", 1);

		real.tmux.sendKeys(orchestrator, ["stop the probe's turn", "Enter"]);
		const requests = await real.waitForRequests("main", 5);
		const stop = lastToolResult(requests[3]);
		expect(stop).toMatchObject({ role: "toolResult", toolName: "subagent_stop" });
		expect(stop?.text).toMatch(/^Stopped probe-run's turn \(sub_[0-9a-f-]+\)\. It stays open and takes messages\.$/);
		expect(lastToolResult(requests[4])?.text).toMatch(/^probe-run \(explorer, sub_[0-9a-f-]+\): (working|idle)$/m);

		// Its pane is the one beside the orchestrator's.
		const [run] = panes(real).filter((pane) => pane !== orchestrator);
		expect(run).toBeDefined();
		real.tmux.sendKeys(run, ["Go on.", "Enter"]);
		const [, next] = await real.waitForRequests("probe-run", 2);
		expect(conversation(next).filter((message) => message.role === "user")).toEqual([
			{ role: "user", text: expect.stringMatching(/\n\nLook around\.$/) },
			{ role: "user", text: "Go on." },
		]);
	});
});

describe.skipIf(!hasTmux)("resuming a closed run", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("reopens its session as a pi with its earlier context when the orchestrator messages it", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around." } },
			{ tool: "subagent_close", args: { agent: "probe-run" } },
			{ tool: "subagent_message", args: { to: "probe-run", content: "Look again." } },
			{ text: "waiting for probe-run" },
			{ text: "read the second report" },
		]);
		real.script("probe-run", [{ text: "First look." }, { text: "Second look." }]);
		real.start(["--", "delegate the look"]);
		const requests = await real.waitForRequests("main", 4);
		expect(lastToolResult(requests[3])?.text).toMatch(
			/^Message \d+ accepted: resuming "probe-run" \(sub_[0-9a-f-]+\) in the background with its earlier context\./,
		);

		const [, resumed] = await real.waitForRequests("probe-run", 2);
		expect(systemPrompt(resumed)).toContain("You are `explorer`");
		const said = conversation(resumed);
		expect(said.slice(0, 2)).toEqual([
			{ role: "user", text: expect.stringMatching(/^\[Task from your orchestrator.*\n\nLook around\.$/s) },
			{ role: "assistant", text: "First look." },
		]);
		expect(said.at(-1)).toMatchObject({
			role: "user",
			text: expect.stringMatching(
				/^\[Message from your orchestrator, from another session, not from the user\..*\]\n\nLook again\.$/s,
			),
		});
		// It is kept in the run's session as a message from another session, not as the user's input.
		const runId = lastToolResult(requests[3])?.text.match(/sub_[0-9a-f-]+/)?.[0] ?? "";
		const [file] = sessionFiles(real.agentDir, runId);
		const entries = SessionManager.open(join(sessionDir(real.agentDir, runId), file)).getEntries();
		expect(entries.filter((entry) => entry.type === "custom_message").map((entry) => JSON.stringify(entry))).toEqual([
			expect.stringContaining("Look again."),
		]);
		const woken = (await real.waitForRequests("main", 5))[4];
		expect(conversation(woken).some((message) => message.text.includes("Second look."))).toBe(true);
	});

	it("of an old in-process run, its session file reopens as a full pi when the orchestrator messages it", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ text: "hello" },
			{ tool: "subagent_message", args: { to: "old-run", content: "Pick up where you left off." } },
			{ text: "waiting for old-run" },
			{ text: "read its report" },
		]);
		real.script("old-run", [{ text: "Picked it up." }]);
		const orchestrator = real.start(["--", "hello"]);
		await real.waitForRequests("main", 1);
		const sessionId = await waitFor(async () => {
			const id = (await real.rows()).find((row) => row.pane === orchestrator)?.sessionId;
			expect(id).toBeDefined();
			return id ?? "";
		});

		// An old run: an SDK session in its run directory, and its record, completed.
		const runId = `sub_${randomUUID()}`;
		const runDir = join(real.agentDir, "bluclawd", "subagents", sessionId, runId);
		const session = SessionManager.create(real.cwd, runDir);
		session.appendMessage({ role: "user", content: "Old task.", timestamp: Date.now() });
		session.appendMessage(fauxAssistantMessage("Old answer."));
		writePersistedRunRecord(real.agentDir, {
			runId,
			parentSessionId: sessionId,
			sessionEpoch: 1,
			parentTurnId: "turn_1",
			originToolCallId: "call_old",
			name: "old-run",
			generation: 0,
			transcriptPath: session.getSessionFile(),
			agentName: "explorer",
			definitionSource: "bundled",
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "off",
			cwd: real.cwd,
			taskSummary: "Old task.",
			startSnapshot: { headCommit: null, dirty: false, statusDigest: "" },
			admittedAt: Date.now(),
			endedAt: Date.now(),
			deliveryMode: "background",
			status: "closed",
			usage: createEmptySubagentUsage(),
			backgroundDeliveryAttempted: true,
		});

		real.tmux.sendKeys(orchestrator, ["go on with the old run", "Enter"]);
		const requests = await real.waitForRequests("main", 3);
		expect(lastToolResult(requests[2])?.text).toMatch(/^Message \d+ accepted: resuming "old-run"/);
		const [resumed] = await real.waitForRequests("old-run", 1);
		const said = conversation(resumed);
		expect(said.slice(0, 2)).toEqual([
			{ role: "user", text: "Old task." },
			{ role: "assistant", text: "Old answer." },
		]);
		expect(said.at(-1)).toMatchObject({ role: "user", text: expect.stringContaining("Pick up where you left off.") });
		const woken = (await real.waitForRequests("main", 4))[3];
		expect(conversation(woken).some((message) => message.text.includes("Picked it up."))).toBe(true);
	});

	it("is listed in /tasks, where Enter reopens its session for the user to type in", async () => {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "background-bash"] });
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around." } },
			{ tool: "subagent_close", args: { agent: "probe-run" } },
			{ text: "closed it" },
		]);
		real.script("probe-run", [{ text: "First look." }, { text: "Second look." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 3);
		await waitFor(() => expect(panes(real)).toEqual([orchestrator]));

		real.tmux.sendKeys(orchestrator, ["/tasks", "Enter"]);
		const screen = () => real.tmux.capture(orchestrator, 50).join("\n");
		await waitFor(() => expect(screen()).toMatch(/Done \(1\)\n.*explorer: Look around\..*closed/));
		real.tmux.sendKeys(orchestrator, ["Enter"]);
		await waitFor(() => expect(panes(real)).toHaveLength(2));
		const [run] = panes(real).filter((pane) => pane !== orchestrator);
		expect(real.requests("probe-run")).toHaveLength(1);

		// Its pi shows its session once it has loaded it, and only then takes keys.
		await waitFor(() => expect(real.tmux.capture(run, 50).join("\n")).toContain("First look."));
		real.tmux.sendKeys(run, ["Anything else?", "Enter"]);
		const [, resumed] = await real.waitForRequests("probe-run", 2);
		expect(conversation(resumed)).toEqual([
			{ role: "user", text: expect.stringMatching(/\n\nLook around\.$/) },
			{ role: "assistant", text: "First look." },
			{ role: "user", text: "Anything else?" },
		]);
	});
});
