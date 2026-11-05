import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { remoteSessions } from "../daemon/remote/sessions.ts";
import { collectRows } from "../daemon/rows.ts";
import {
	conversation,
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
		expect(conversation(asked)).toEqual([{ role: "user", text: "Look around the checkout." }]);

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
		expect(status?.text).toMatch(/^probe-run \(explorer, sub_[0-9a-f-]+\): running/);
		const runId = status?.text.match(/sub_[0-9a-f-]+/)?.[0];
		// Found by its name; delivering into the run's session is #185's.
		const message = lastToolResult(requests[3]);
		expect(message).toMatchObject({ role: "toolResult", toolName: "subagent_message" });
		expect(message?.text).toContain(runId);
		const stop = lastToolResult(requests[4]);
		expect(stop).toMatchObject({ role: "toolResult", toolName: "subagent_stop" });
		expect(stop?.text).toBe(`Stopping probe-run (${runId}).`);
	});

	it("cannot launch runs of its own, and stays open after its Report", async () => {
		const role = { name: "helper", description: "Helps.", instructions: "Help out." };
		const { real } = await launch(role, "Helped.");

		expect(toolNames(real.requests("main")[0])).toContain("subagent");
		expect(toolNames(real.requests("probe-run")[0])).not.toContain("subagent");
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
			{ text: "read the first report" },
			{ text: "read the second report" },
		]);
		real.script("probe-run", [{ text: "First look." }, { text: "Second look." }]);
		const orchestrator = real.start(["--", "delegate the look"]);

		const [, launched] = await real.waitForRequests("main", 2);
		const result = lastToolResult(launched)?.text;
		expect(result).toMatch(/^Background subagent launched: probe-run \(sub_[0-9a-f-]+\)/);
		expect(result).toContain("It stays open, and its report arrives here each time it finishes a turn.");
		await waitFor(() => expect(real.tmux.capture(orchestrator, 50).join("\n")).toContain("waiting for 1 subagent"));

		const first = (await real.waitForRequests("main", 3))[2];
		const firstReport = said(first).find((text) => text.includes("First look."));
		expect(firstReport).toContain('[Report from subagent "probe-run", from another session, not from the user.');
		expect(said(first).at(-1)).toMatch(/^Subagents still active.*\n- probe-run: background, /s);

		const run = (await real.rows()).find((row) => row.label === "probe-run");
		real.tmux.sendKeys(run?.pane ?? "", ["Look again.", "Enter"]);
		const second = (await real.waitForRequests("main", 4))[3];
		expect(said(second).filter((text) => text.includes("Second look."))).toHaveLength(1);
		expect(real.requests("probe-run")).toHaveLength(2);
	});

	it("leaves the reminder and the Waiting title once the orchestrator's session is replaced", async () => {
		const real = await startRealPi();
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the report" },
			{ text: "a new session" },
		]);
		real.script("probe-run", [{ text: "First look." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 3);
		const screen = () => real.tmux.capture(orchestrator, 50).join("\n");
		await waitFor(() => expect(screen()).toContain("waiting for 1 subagent"));

		real.tmux.sendKeys(orchestrator, ["/new", "Enter"]);
		await waitFor(() => expect(screen()).not.toContain("waiting for"));
		real.tmux.sendKeys(orchestrator, ["hello", "Enter"]);
		const fresh = (await real.waitForRequests("main", 4))[3];
		expect(said(fresh)).toEqual(["hello"]);
	});
});
