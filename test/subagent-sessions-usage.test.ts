import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTENSIONS, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** A line of a session file, as far as these tests read it. */
interface SessionLine {
	type: string;
	message?: { role: string; toolName?: string; usage?: { totalTokens: number } };
}

/** Each entry of every session file under `dir`. */
const sessionEntries = (dir: string): SessionLine[] =>
	readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".jsonl"))
		.flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean))
		.map((line) => JSON.parse(line) as SessionLine);

/** The tokens of the assistant messages: what pi's own totals count of a faux session. */
const assistantTokens = (entries: SessionLine[]) =>
	entries
		.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
		.reduce((sum, entry) => sum + (entry.message?.usage?.totalTokens ?? 0), 0);

describe.skipIf(!hasTmux)("a run's usage, in its own session", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	/** The tokens counted in the runs' own sessions, which live under the orchestrator's subagents dir. */
	const runTokens = (real: RealPi) => assistantTokens(sessionEntries(join(real.agentDir, "bluclawd", "subagents")));
	/** The orchestrator's own session entries. */
	const ownEntries = (real: RealPi) => sessionEntries(join(real.agentDir, "sessions"));
	/** Waits for `/status` in the orchestrator to show what it says of its runs. */
	async function statusShows(real: RealPi, orchestrator: string, expected: RegExp) {
		real.tmux.sendKeys(orchestrator, ["/status", "Enter"]);
		await waitFor(() => expect(real.tmux.capture(orchestrator, 200).join("\n")).toMatch(expected));
	}

	it("counts a foreground run's tokens in the run's session, and shows them apart from the orchestrator's", async () => {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "help"] });
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around the checkout." } },
			{ text: "the probe is done" },
		]);
		real.script("probe-run", [{ text: "Found three files in the checkout, and nothing else of note." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 2);

		const tokens = runTokens(real);
		expect(tokens).toBeGreaterThan(0);
		const launch = ownEntries(real).find(
			(entry) => entry.message?.role === "toolResult" && entry.message.toolName === "subagent",
		);
		expect(launch?.message).toBeDefined();
		expect(launch?.message).not.toHaveProperty("usage");
		await statusShows(real, orchestrator, new RegExp(`Subagents\\s+1 runs, ${tokens} tokens`));
	});

	it("counts each turn of a run that stays open once, however many Reports carry its session's total", async () => {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "help"] });
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the first report" },
			{ text: "read the second report" },
		]);
		real.script("probe-run", [{ text: "First look at the checkout." }, { text: "Second, longer look at it all." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 3);
		const first = runTokens(real);

		const run = (await real.rows()).find((row) => row.label === "probe-run");
		real.tmux.sendKeys(run?.pane ?? "", ["Look again.", "Enter"]);
		await real.waitForRequests("main", 4);
		const both = runTokens(real);
		expect(both).toBeGreaterThan(first);
		await statusShows(real, orchestrator, new RegExp(`Subagents\\s+1 runs, ${both} tokens`));
	});
});
