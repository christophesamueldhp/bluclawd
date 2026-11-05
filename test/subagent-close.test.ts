import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remoteSessions } from "../daemon/remote/sessions.ts";
import { collectRows } from "../daemon/rows.ts";
import {
	conversation,
	DEFAULT_EXTENSIONS,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
} from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The last tool result the model was given: the active-run reminder may follow it. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

/** The tmux sessions running. */
const panes = (real: RealPi) => [...real.screens().matchAll(/^--- (\S+) ---$/gm)].map((match) => match[1]);

/** The session files kept in a run's directories, wherever the orchestrator's session keeps them. */
function sessionFiles(agentDir: string, runId: string): string[] {
	const root = join(agentDir, "bluclawd", "subagents");
	return readdirSync(root).flatMap((session) => {
		const dir = join(root, session, runId);
		return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".jsonl")) : [];
	});
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
		expect(close?.text).toMatch(/^Closed probe-run \(sub_[0-9a-f-]+\)\. Its session is kept: a message resumes it\.$/);
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
		expect(lastToolResult(requests[4])?.text).toMatch(/^probe-run \(explorer, sub_[0-9a-f-]+\): running/);

		// Not listed before its first answer: its pane is the one beside the orchestrator's.
		const [run] = panes(real).filter((pane) => pane !== orchestrator);
		expect(run).toBeDefined();
		real.tmux.sendKeys(run, ["Go on.", "Enter"]);
		const [, next] = await real.waitForRequests("probe-run", 2);
		expect(conversation(next).filter((message) => message.role === "user")).toEqual([
			{ role: "user", text: "Look around." },
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
		const said = conversation(resumed);
		expect(said.slice(0, 2)).toEqual([
			{ role: "user", text: "Look around." },
			{ role: "assistant", text: "First look." },
		]);
		expect(said.at(-1)).toMatchObject({ role: "user", text: expect.stringContaining("Look again.") });
		const woken = (await real.waitForRequests("main", 5))[4];
		expect(conversation(woken).some((message) => message.text.includes("Second look."))).toBe(true);
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
			{ role: "user", text: "Look around." },
			{ role: "assistant", text: "First look." },
			{ role: "user", text: "Anything else?" },
		]);
	});
});
