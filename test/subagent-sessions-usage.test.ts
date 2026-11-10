import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { writePersistedRunRecord } from "../ext/subagents/storage.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";
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

	it("counts the earlier turns of a run from before runs were pis of their own once, when it resumes", async () => {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "help"] });
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

		// An old run: an SDK session in its run directory, its completed record, and its usage in the ledger.
		const runId = `sub_${randomUUID()}`;
		const sessionDir = join(real.agentDir, "bluclawd", "subagents", sessionId);
		const session = SessionManager.create(real.cwd, join(sessionDir, runId));
		const oldUsage = { ...createEmptySubagentUsage(), input: 5000, totalTokens: 5000 };
		session.appendMessage({ role: "user", content: "Old task.", timestamp: Date.now() });
		session.appendMessage({ ...fauxAssistantMessage("Old answer."), usage: oldUsage });
		writeFileSync(
			join(sessionDir, "background-usage-ledger.json"),
			JSON.stringify({ parentSessionId: sessionId, runCount: 1, recordedRunIds: [runId], usage: oldUsage }),
		);
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
			complete: false,
			usage: oldUsage,
			backgroundDeliveryAttempted: true,
		});

		real.tmux.sendKeys(orchestrator, ["go on with the old run", "Enter"]);
		await real.waitForRequests("main", 4);
		// The old turns' 5000 tokens are in the run's session file once, and counted once.
		const tokens = runTokens(real);
		expect(tokens).toBeGreaterThan(5000);
		await statusShows(real, orchestrator, new RegExp(`Subagents\\s+1 runs, ${tokens} tokens`));
	});

	it("keeps the tokens of a run's earlier session when the user starts a new one in it", async () => {
		const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "help"] });
		pi = real;
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "probe-run", task: "Look around.", background: true } },
			{ text: "waiting for probe-run" },
			{ text: "read the first report" },
			// The run's new session has no name of its own, so the faux model answers it from this script.
			{ text: "A fresh look at the checkout, from a new session." },
			{ text: "read the second report" },
		]);
		real.script("probe-run", [{ text: "First look at the checkout." }]);
		const orchestrator = real.start(["--", "delegate the look"]);
		await real.waitForRequests("main", 3);

		const run = (await real.rows()).find((row) => row.label === "probe-run");
		real.tmux.sendKeys(run?.pane ?? "", ["/new", "Enter"]);
		await waitFor(() => expect(real.tmux.capture(run?.pane ?? "", 50).join("\n")).toMatch(/new session/i));
		real.tmux.sendKeys(run?.pane ?? "", ["Look again.", "Enter"]);
		await real.waitForRequests("main", 5);
		const both = runTokens(real);
		await statusShows(real, orchestrator, new RegExp(`Subagents\\s+1 runs, ${both} tokens`));
	});
});
