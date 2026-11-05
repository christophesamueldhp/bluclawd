import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { remoteSessions } from "../daemon/remote/sessions.ts";
import { collectRows } from "../daemon/rows.ts";
import { conversation, hasTmux, type RealPi, startRealPi, systemPrompt, toolNames } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

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

		const result = conversation(real.requests("main")[1]).at(-1);
		expect(result).toMatchObject({ role: "toolResult", toolName: "subagent" });
		expect(result?.text).toContain("Found three files.");
		expect(result?.text).toContain("from another session, not from the user");

		const rows = await real.rows();
		const run = rows.find((row) => row.label === "probe-run");
		expect(run).toMatchObject({ parent: orchestrator });
		expect(collectRows(rows, undefined).map((row) => row.pane)).toEqual([orchestrator]);
		expect(remoteSessions(rows).map((session) => session.id)).toEqual([orchestrator]);
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
