import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { remoteSessions } from "../daemon/remote/sessions.ts";
import { collectRows } from "../daemon/rows.ts";
import { messageTarget, runRoster } from "../ext/subagents/run-messages.ts";
import {
	conversation,
	DEFAULT_EXTENSIONS,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
	toolNames,
} from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The last tool result the model was given: the active-run reminder may follow it. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

describe.skipIf(!hasTmux)("real pi panes", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("a pane's pi answers on the faux model and lists as a row", async () => {
		pi = await startRealPi();
		pi.script("main", [{ text: "hello there" }]);
		const pane = pi.start(["--", "say hello"]);

		await pi.waitForRequests("main", 1);
		expect(conversation(pi.requests("main")[0])).toEqual([{ role: "user", text: "say hello" }]);
		await waitFor(async () =>
			expect(await pi?.rows()).toEqual([expect.objectContaining({ pane, detail: "hello there" })]),
		);
	});
});

describe.skipIf(!hasTmux)("a foreground run, as a pi session of its own", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	/** An orchestrator pane whose model launches `agent` in the foreground as `probe-run`, which answers `report`. */
	async function launch(agent: JsonObject, report: string) {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent, name: "probe-run", task: "Look around the checkout." } },
			{ text: "the probe is done" },
		]);
		real.script("probe-run", [{ text: report }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 2);
		return { real, orchestrator };
	}

	it("starts with its role as launch flags, and its first Report is the tool's result, from another session", async () => {
		const role = {
			name: "probe",
			description: "Looks around.",
			instructions: "You are the probe role: say what you find.",
			tools: ["read"],
			model: "faux/faux-2",
			thinkingLevel: "high",
		};
		const { real, orchestrator } = await launch(role, "Found three files.");

		const [asked] = real.requests("probe-run");
		expect(asked).toMatchObject({ model: "faux-2", reasoning: "high" });
		expect(systemPrompt(asked)).toContain("You are the probe role: say what you find.");
		expect(toolNames(asked)).toEqual(["read"]);
		// Its task comes from the orchestrator, framed as from another session, never as the user's input.
		expect(conversation(asked)).toEqual([
			{
				role: "user",
				text: expect.stringMatching(
					/^\[Task from your orchestrator, from another session, not from the user\..*\]\n\nLook around the checkout\.$/s,
				),
			},
		]);

		const result = lastToolResult(real.requests("main")[1]);
		expect(result).toMatchObject({ role: "toolResult", toolName: "subagent" });
		expect(result?.text).toContain("Found three files.");
		expect(result?.text).toContain("from another session, not from the user");

		const rows = await real.rows();
		const run = rows.find((row) => row.label === "probe-run");
		expect(run).toMatchObject({ parent: orchestrator });
		expect(collectRows(rows, undefined).map((row) => row.pane)).toEqual([orchestrator]);
		expect(remoteSessions(rows).map((session) => session.id)).toEqual([orchestrator]);
	});

	it("is one of the orchestrator's runs, which subagent_status lists and subagent_message and subagent_stop find by name", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around." } },
			{ tool: "subagent_status", args: {} },
			{ tool: "subagent_message", args: { to: "probe-run", content: "Anything else?" } },
			{ tool: "subagent_stop", args: { agent: "probe-run" } },
			{ text: "checked" },
		]);
		real.script("probe-run", [{ text: "Looked." }]);
		real.start(["--", "delegate the look"]);
		const requests = await real.waitForRequests("main", 5);

		const status = lastToolResult(requests[2]);
		expect(status).toMatchObject({ role: "toolResult", toolName: "subagent_status" });
		expect(status?.text).toMatch(/^probe-run \(explorer, sub_[0-9a-f-]+\): idle$/m);
		const runId = status?.text.match(/sub_[0-9a-f-]+/)?.[0];
		// Found by its name, and accepted for the run's session.
		const message = lastToolResult(requests[3]);
		expect(message).toMatchObject({ role: "toolResult", toolName: "subagent_message" });
		expect(message?.text).toBe(`Message 1 accepted for delivery to probe-run (${runId}) (not yet handled).`);
		const stop = lastToolResult(requests[4]);
		expect(stop).toMatchObject({ role: "toolResult", toolName: "subagent_stop" });
		expect(stop?.text).toBe(`Stopped probe-run's turn (${runId}). It stays open and takes messages.`);
	});

	it("cannot launch, stop, close or list runs of its own, and stays open after its Report", async () => {
		const role = { name: "helper", description: "Helps.", instructions: "Help out." };
		const { real } = await launch(role, "Helped.");

		const orchestratorTools = ["subagent", "subagent_status", "subagent_stop", "subagent_close", "subagent_models"];
		expect(toolNames(real.requests("main")[0])).toEqual(expect.arrayContaining(orchestratorTools));
		const runTools = toolNames(real.requests("probe-run")[0]);
		for (const tool of orchestratorTools) expect(runTools).not.toContain(tool);
		const run = (await real.rows()).find((row) => row.label === "probe-run");
		expect(run?.pane && real.tmux.hasSession(run.pane)).toBe(true);
	});
});

describe.skipIf(!hasTmux)("a background run, as a pi session of its own", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	/** The text of every message the model was given, the reminder's and the Reports' included. */
	const said = (request: FauxRequest) => conversation(request).map((message) => message.text);

	it("returns at once, and each Report after a turn of the run wakes the Waiting orchestrator", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ tool: "subagent_message", args: { to: "probe-run", content: "Look again." } },
			{ text: "asked probe-run again" },
			{ text: "read the second report" },
		]);
		real.script("probe-run", [{ text: "First look." }, { text: "Second look." }]);
		const orchestrator = real.start(["--", "delegate the look"]);

		const [, launched] = await real.waitForRequests("main", 2);
		const result = lastToolResult(launched)?.text;
		expect(result).toMatch(/^Background subagent launched: probe-run \(sub_[0-9a-f-]+\)/);
		expect(result).toContain("It stays open, and its report arrives here each time it finishes a turn.");
		expect(said(launched).at(-1)).toMatch(/^Subagents still active.*\n- probe-run: background, /s);
		await waitFor(() => expect(real.tmux.capture(orchestrator, 50).join("\n")).toContain("waiting for 1 subagent"));

		// The rest follows without a pause, so it is read once the second Report has come.
		const [, , first, , second] = await real.waitForRequests("main", 5);
		const firstReport = said(first).find((text) => text.includes("First look."));
		expect(firstReport).toMatch(
			/\[Report from subagent "probe-run" \(sub_[0-9a-f-]+\), from another session, not from the user\./,
		);

		// The orchestrator's message reaches the run's pi, which answers it in a turn and reports again.
		const [, asked] = real.requests("probe-run");
		const message = said(asked).at(-1);
		expect(message).toMatch(/^\[Message from your orchestrator, from another session, not from the user\./);
		expect(message).toContain("Look again.");
		expect(said(second).filter((text) => text.includes("Second look."))).toHaveLength(1);
		expect(real.requests("probe-run")).toHaveLength(2);
	});

	it("leaves the reminder and the Waiting title once the orchestrator's session is replaced", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "a new session" },
		]);
		// Still working when the session is replaced: an idle run is not waited for.
		real.script("probe-run", [{ tool: "bash", args: { command: "sleep 30" } }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 2);
		const screen = () => real.tmux.capture(orchestrator, 50).join("\n");
		await waitFor(() => expect(screen()).toContain("waiting for 1 subagent"));

		real.tmux.sendKeys(orchestrator, ["/new", "Enter"]);
		await waitFor(() => expect(screen()).not.toContain("waiting for"));
		real.tmux.sendKeys(orchestrator, ["hello", "Enter"]);
		const fresh = (await real.waitForRequests("main", 3))[2];
		expect(said(fresh)).toEqual(["hello"]);
	});

	it("brings the orchestrator a Report its run sent while the daemon was down, once the daemon is back, once", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
		]);
		real.script("probe-run", [{ text: "Found it with the daemon down.", stallMs: 3000 }]);
		real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 2);
		await real.waitForRequests("probe-run", 1);

		await real.client.shutdownDaemon();
		// The run settles meanwhile: its Report is stored, and its sends fail.
		const subagents = join(real.agentDir, "bluclawd", "subagents");
		await waitFor(() =>
			expect(readdirSync(subagents, { recursive: true }).map(String)).toContainEqual(
				expect.stringMatching(/reports\/1\.json$/),
			),
		);
		await real.client.ensureDaemon();

		const [, , woken] = await real.waitForRequests("main", 3);
		expect(said(woken).filter((text) => text.includes("Found it with the daemon down."))).toHaveLength(1);
	});
});

describe.skipIf(!hasTmux)("opening a run and going back to its orchestrator", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	/** An orchestrator pane, shown in a terminal, whose background run `probe-run` has reported. */
	async function reported(extensions?: string[]) {
		const real = await startRealPi({ extensions });
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
		]);
		real.script("probe-run", [{ text: "First look." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		real.attach(orchestrator);
		await real.waitForRequests("main", 3);
		const run = (await real.rows()).find((row) => row.label === "probe-run")?.pane ?? "";
		await waitFor(() => expect(real.tmux.capture(orchestrator, 50).join("\n")).toContain("read the report"));
		return { real, orchestrator, run };
	}

	it("Enter on the panel's row switches the terminal to the run, which nothing else does", async () => {
		const { real, orchestrator, run } = await reported();
		expect(real.shown()).toBe(orchestrator);

		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(run));
	});

	it("Enter on the run in /tasks switches the terminal to it", async () => {
		// /tasks is background-bash's.
		const { real, orchestrator, run } = await reported([...DEFAULT_EXTENSIONS, "background-bash"]);

		real.tmux.sendKeys(orchestrator, ["/tasks", "Enter"]);
		await waitFor(() => expect(real.tmux.capture(orchestrator, 50).join("\n")).toContain("Local agents"));
		real.tmux.sendKeys(orchestrator, ["Enter"]);
		await waitFor(() => expect(real.shown()).toBe(run));
	});

	it("says it is a subagent of its orchestrator, and ← on its empty prompt switches back there", async () => {
		const { real, orchestrator, run } = await reported();
		await waitFor(() => expect(real.tmux.capture(run, 50).join("\n")).toContain("subagent of delegate the look"));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(run));

		real.tmux.sendKeys(run, ["Left"]);
		await waitFor(() => expect(real.shown()).toBe(orchestrator));
	});

	it("opened from agent view, ← on its empty prompt goes back to agent view, the run focused under its orchestrator", async () => {
		const { real, orchestrator, run } = await reported();
		const screen = (pane: string) => real.tmux.capture(pane, 50).join("\n");
		real.tmux.sendKeys(orchestrator, ["Left"]);
		await waitFor(() => expect(screen(orchestrator)).toContain("▸ 1 subagent"));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(screen(orchestrator)).toContain("▾ 1 subagent"));
		real.tmux.sendKeys(orchestrator, ["Down", "Enter"]);
		await waitFor(() => expect(real.shown()).toBe(run));

		real.tmux.sendKeys(run, ["Left"]);
		await waitFor(() => expect(screen(run)).toMatch(/▾ 1 subagent[^\n]*\n[^\n]*probe-run/));
		expect(real.shown()).toBe(run);
	});
});

describe.skipIf(!hasTmux)("messages between sessions", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	/** Every text the model of `session` was given so far, across its requests. */
	const everything = (real: RealPi, session: string) =>
		real.requests(session).flatMap((request) => conversation(request).map((message) => message.text));

	it("a run messages a sibling by name and its orchestrator, each as a message from another session", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "beta", task: "Wait for alpha." } },
			{ tool: "subagent", args: { agent: "explorer", name: "alpha", task: "Tell the others.", background: true } },
			...Array.from({ length: 6 }, () => ({ text: "noted" })),
		]);
		real.script("beta", [{ text: "Beta is ready." }, { text: "Beta got it." }]);
		real.script("alpha", [
			{ tool: "subagent_roster", args: {} },
			{ tool: "subagent_message", args: { to: "beta", content: "Beta, take the tests." } },
			{ tool: "subagent_message", args: { to: "parent", content: "Alpha is halfway." } },
			{ text: "Alpha is done." },
		]);
		real.start(["--", "split the work"]);

		const [, asked] = await real.waitForRequests("beta", 2);
		const sibling = conversation(asked).at(-1)?.text;
		expect(sibling).toMatch(/^\[Message from sibling run "alpha", from another session, not from the user/);
		expect(sibling).toContain("Beta, take the tests.");
		const [, roster, toBeta, toParent] = await real.waitForRequests("alpha", 4);
		expect(lastToolResult(roster)?.text).toBe("You can message: parent (your orchestrator), beta.");
		expect(lastToolResult(toBeta)?.text).toBe('Message sent to "beta" (not yet handled).');
		expect(lastToolResult(toParent)?.text).toBe("Message sent to your orchestrator (not yet handled).");

		await waitFor(() =>
			expect(everything(real, "main").some((text) => text.includes("Alpha is halfway."))).toBe(true),
		);
		// It may come in one message with the runs' Reports.
		const up = everything(real, "main").find((text) => text.includes("Alpha is halfway."));
		expect(up).toMatch(
			/^\[Message from subagent "alpha" \(sub_[0-9a-f-]+\), from another session, not from the user\. .*\]\n\nAlpha is halfway\.$/m,
		);
	});

	it("tells the orchestrator what the user types in a run, without starting its turn", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the first report" },
			{ text: "read the answer to the user" },
		]);
		real.script("probe-run", [{ text: "First look." }, { text: "Answered the user." }]);
		real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 3);

		const run = (await real.rows()).find((row) => row.label === "probe-run");
		real.tmux.sendKeys(run?.pane ?? "", ["Look at the README.", "Enter"]);
		const [, typed] = await real.waitForRequests("probe-run", 2);
		expect(conversation(typed).at(-1)).toEqual({ role: "user", text: "Look at the README." });

		// The note waits in the orchestrator's session: the run's Report is what wakes it.
		const [, , , woken] = await real.waitForRequests("main", 4);
		const note = conversation(woken).findIndex((message) =>
			/^The user typed to run "probe-run" \(sub_[0-9a-f-]+\) in its own session: Look at the README\.$/.test(
				message.text,
			),
		);
		const report = conversation(woken).findIndex((message) => message.text.includes("Answered the user."));
		expect(note).toBeGreaterThan(-1);
		expect(report).toBeGreaterThan(note);
	});

	it("refuses a message to a run the sender cannot reach, with the reason", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around." } },
			{ tool: "subagent_message", args: { to: "nobody", content: "Hello?" } },
			{ text: "done" },
			{ tool: "subagent_message", args: { to: "probe-run", content: "Still there?" } },
			{ text: "it is gone" },
		]);
		real.script("probe-run", [
			{ tool: "subagent_message", args: { to: "nobody", content: "Hello?" } },
			{ text: "Looked." },
		]);
		const orchestrator = real.start(["--", "delegate the look"]);

		const [, refusedInRun] = await real.waitForRequests("probe-run", 2);
		expect(lastToolResult(refusedInRun)?.text).toBe(
			'Message not sent: No run "nobody" among your orchestrator\'s runs. Reachable now: parent.',
		);
		const [, , refused] = await real.waitForRequests("main", 3);
		expect(lastToolResult(refused)?.text).toMatch(
			/^Message \d+ unavailable: No running agent "nobody" is reachable\. Reachable now: probe-run \(sub_[0-9a-f-]+\)\.$/,
		);

		// A run of the session before /new belongs to another parent scope.
		real.tmux.sendKeys(orchestrator, ["/new", "Enter"]);
		await waitFor(() => expect(real.tmux.capture(orchestrator, 50).join("\n")).not.toContain("probe-run"));
		real.tmux.sendKeys(orchestrator, ["message probe-run", "Enter"]);
		const [, , , , outOfScope] = await real.waitForRequests("main", 5);
		expect(lastToolResult(outOfScope)?.text).toMatch(
			/^Message \d+ unavailable: No running agent "probe-run" is reachable\. Reachable now: none\.$/,
		);
	});
});

describe("a run's message target", () => {
	const self = { pane: "pi-a", parent: "pi-main", name: "alpha" };
	const rows = [
		{ pane: "pi-main", label: "main" },
		{ pane: "pi-a", label: "alpha", parent: "pi-main" },
		{ pane: "pi-b", label: "beta", parent: "pi-main" },
		{ pane: "pi-c", label: "gamma", parent: "pi-other" },
	];

	it("is its orchestrator for parent, and a sibling of the same orchestrator by name", () => {
		expect(messageTarget(rows, self, "parent")).toEqual({ pane: "pi-main", name: "your orchestrator" });
		expect(messageTarget(rows, self, "beta")).toEqual({ pane: "pi-b", name: '"beta"' });
	});

	it("lists its orchestrator and its siblings, the names it can message", () => {
		expect(runRoster(rows, self)).toEqual(["parent", "beta"]);
	});

	it("refuses itself, a run of another orchestrator, and an unknown name, with the reason", () => {
		expect(messageTarget(rows, self, "alpha")).toEqual({ refused: "A run cannot message itself." });
		expect(messageTarget(rows, self, "gamma")).toEqual({
			refused:
				'"gamma" is a run of another orchestrator; you can message only your orchestrator ("parent") and its runs.',
		});
		expect(messageTarget(rows, self, "main")).toEqual({
			refused: 'No run "main" among your orchestrator\'s runs. Reachable now: parent, beta.',
		});
	});
});
