import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remoteSessions } from "../daemon/remote/sessions.ts";
import { collectRows } from "../daemon/rows.ts";
import { conversation, type FauxRequest, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The last tool result the model was given: the active-run reminder may follow it. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

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

		const panes = () => real.screens().match(/^--- (\S+) ---$/gm) ?? [];
		await waitFor(() => expect(panes()).toEqual([`--- ${orchestrator} ---`]));
		expect(sessionFiles(real.agentDir, runId)).toHaveLength(1);
		// Its pi saves its row once it is gone: a run's row keeps its parent.
		await waitFor(async () =>
			expect((await real.rows()).find((row) => row.label === "probe-run")).toMatchObject({
				status: "stopped",
				parent: orchestrator,
			}),
		);
		// The hand-off may restart the daemon, which lists the orchestrator again on its next beat.
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
		const panes = () => real.screens().match(/^--- (\S+) ---$/gm) ?? [];
		expect(panes()).toHaveLength(2);

		real.tmux.sendKeys(orchestrator, ["Down"]);
		await waitFor(() => expect(screen()).toContain("x to close"));
		real.tmux.sendKeys(orchestrator, ["x"]);
		await waitFor(() => expect(panes()).toEqual([`--- ${orchestrator} ---`]));
		await waitFor(() => expect(screen()).not.toMatch(panelRow));
	});
});
