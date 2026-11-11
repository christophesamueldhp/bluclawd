import { afterEach, describe, expect, it } from "vitest";
import { messageTarget, runRoster } from "../ext/subagents/run-messages.ts";
import { conversation, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
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

// A run in tmux, from before runs ran on pi's RPC, messages through the daemon as a session of its own.
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
