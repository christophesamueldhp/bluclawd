import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generationDefinition } from "../ext/subagents/generation-state.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import {
	conversation,
	FAUX,
	type FauxRequest,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
	toolNames,
} from "./helpers/real-pi.ts";
import { definitionOf, reportOf, reportSeqs, reportText, runDirOf, runNamed, storedHost } from "./helpers/run-files.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The last tool result the model was given. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Merges `added` into the settings every pi of the test reads, as they are read next. */
function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...readJson(path), ...added }));
}

/** A project role `name` of `dir`, with `instructions` and its front matter `extra`. */
function role(dir: string, name: string, instructions: string, extra: string[]): void {
	mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
	writeFileSync(
		join(dir, ".pi", "agents", `${name}.md`),
		["---", `name: ${name}`, "description: Audits.", ...extra, "---", instructions].join("\n"),
	);
}

const alive = (pid: number | undefined) => {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** An orchestrator pane whose runs are RPC children, which load the faux provider as the pane does. */
async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi();
}

describe.skipIf(!hasTmux)("resuming an RPC run", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	// Two pis one after another (look, then its Resume): a readiness bound for each to start, and one for the rest.
	it(
		"continues the run's saved session in a new pi, as its next generation, keeping each generation's Report",
		{ timeout: 3 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			real.script("main", [
				{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Remember the codeword PELICAN." } },
				{ tool: "subagent_resume", args: { agent: "look", task: "Which codeword did I give you?" } },
				{ text: "waiting for look" },
				{ text: "noted" },
			]);
			real.script("look", [{ text: "Remembered." }, { text: "You gave me PELICAN." }]);
			real.start(["--", "delegate"]);
			const main = await real.waitForRequests("main", 4);
			const dir = runDirOf(real.agentDir, "look");
			const first = reportOf(dir, 1);

			const receipt = lastToolResult(main[2])?.text;
			expect(receipt).toMatch(/Resuming "look" \(sub_[^)]+\) in the background/);
			// What to do after a call is said in its result.
			expect(receipt).toContain(
				"While it runs, do not redo or touch its work, including the files in its scope, and do not poll `subagent_status` by reflex.",
			);
			expect(receipt).toContain(
				"With no independent work left, end your turn and say you are waiting: its report will wake you.",
			);
			expect(receipt).toContain("Never predict or invent its result; if the user asks, say it is still running.");
			expect(receipt).toContain(
				"Its progress does not wake you; its findings, questions and blockers reach you as messages.",
			);
			expect(receipt).toContain(
				[
					"Its report will be delivered when it finishes.",
					"While it runs, do not redo or touch its work, including the files in its scope, and do not poll `subagent_status` by reflex. With no independent work left, end your turn and say you are waiting: its report will wake you. Never predict or invent its result; if the user asks, say it is still running.",
					"Its progress does not wake you; its findings, questions and blockers reach you as messages.",
				].join("\n"),
			);
			// Its earlier conversation, then the instruction, as from its orchestrator.
			const look = real.requests("look");
			expect(look).toHaveLength(2);
			expect(conversation(look[1]).map(({ role, text }) => `${role}: ${text.split("\n").at(-1)}`)).toEqual([
				"user: Remember the codeword PELICAN.",
				"assistant: Remembered.",
				"user: Which codeword did I give you?",
			]);
			expect(conversation(look[1])[2].text).toMatch(/^\[Message from your orchestrator, from another session/);
			// Its Report wakes the orchestrator.
			expect(conversation(main[3]).at(-1)?.text).toContain("You gave me PELICAN.");

			// One session across both generations; each generation's Report kept apart.
			const host = storedHost(dir);
			expect(reportOf(dir, 2)).toMatchObject({
				generation: 1,
				outcome: { status: "completed" },
				sessionId: first?.sessionId,
			});
			expect(first).toMatchObject({ generation: 0, text: "Remembered." });
			expect(reportText(dir, 1)).toContain("Remembered.");
			expect(reportText(dir, 2)).toContain("You gave me PELICAN.");
			expect(readdirSync(dir).filter((file) => file.endsWith(".jsonl"))).toEqual([
				host.sessionFile?.split("/").at(-1),
			]);
			await waitFor(() =>
				expect(runNamed(real.agentDir, "look").record).toMatchObject({
					generation: 1,
					status: "closed",
					transcriptPath: host.sessionFile,
				}),
			);
			await waitFor(() => expect([alive(host.childPid), alive(host.hostPid)]).toEqual([false, false]));
			expect(JSON.stringify([...real.requests("main"), ...look])).not.toContain("ran dry");
		},
	);

	// Two runs in a row, each a new pi: a readiness bound for each to start, and one for the rest.
	it(
		"is never started by a message, and a new run of the same role starts fresh",
		{ timeout: 3 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			real.script("main", [
				{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Remember the codeword PELICAN." } },
				{ tool: "subagent_message", args: { to: "look", content: "Also remember HERON." } },
				{ tool: "subagent", args: { agent: "explorer", name: "again", task: "Which codeword do you know?" } },
				{ text: "done" },
			]);
			real.script("look", [{ text: "Remembered." }]);
			real.script("again", [{ text: "None." }]);
			real.start(["--", "delegate"]);
			const main = await real.waitForRequests("main", 4);

			expect(lastToolResult(main[2])).toMatchObject({
				toolName: "subagent_message",
				text: expect.stringMatching(
					/unavailable: "look" \(sub_[^)]+\) has finished\. Only subagent_resume continues it/,
				),
			});
			expect(
				conversation(real.requests("again")[0]).map(({ role, text }) => `${role}: ${text.split("\n").at(-1)}`),
			).toEqual(["user: Which codeword do you know?"]);
			// Proves only that nothing woke the finished run within this while.
			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(real.requests("look")).toHaveLength(1);
			const dir = runDirOf(real.agentDir, "look");
			expect(reportSeqs(dir)).toEqual([1]);
			expect(runNamed(real.agentDir, "look").record).toMatchObject({ generation: 0, status: "closed" });
			expect(JSON.stringify(real.requests("again"))).not.toContain("PELICAN");
		},
	);

	// Four generations in a row, each a new pi: a readiness bound for each to start, and one for the rest.
	it(
		"keeps its model and thinking unless the Resume changes them, and refuses a change its model cannot run",
		{ timeout: 5 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const resume = (task: string, changes: Record<string, string> = {}) => ({
				tool: "subagent_resume",
				args: { agent: "tuned", task, ...changes },
			});
			real.script("main", [
				{
					tool: "subagent",
					args: { agent: "explorer", name: "tuned", task: "One.", model: "faux/faux-3", thinkingLevel: "low" },
				},
				resume("Two."),
				{ text: "waiting" },
				// Its level stays low, which faux-1 cannot think at: refused, not lowered.
				resume("Three.", { model: "faux/faux-1" }),
				resume("Four.", { model: "faux/faux-2", thinkingLevel: "high" }),
				{ text: "waiting" },
				resume("Five."),
				{ text: "waiting" },
				{ text: "done" },
			]);
			real.script(
				"tuned",
				["One", "Two", "Four", "Five"].map((text) => ({ text: `${text} done.` })),
			);
			real.start(["--model", "faux/faux-2", "--thinking", "medium", "--", "delegate"]);
			const main = await real.waitForRequests("main", 9);

			const asked = real.requests("tuned").map((request) => `${request.model}:${request.reasoning ?? "off"}`);
			expect(asked).toEqual(["faux-3:low", "faux-3:low", "faux-2:high", "faux-2:high"]);
			const results = conversation(main[8])
				.filter(({ toolName }) => toolName === "subagent_resume")
				.map(({ text }) => text);
			expect(results).toHaveLength(4);
			expect(results[1]).toContain(
				'Thinking level "low" is not supported by subagent model "faux/faux-1" (supported: off).',
			);
			expect(results[2]).toContain("as its generation 2 on faux/faux-2 at thinking high");
			const dir = runDirOf(real.agentDir, "tuned");
			await waitFor(() =>
				expect(runNamed(real.agentDir, "tuned").record).toMatchObject({
					generation: 3,
					status: "closed",
					modelId: "faux-2",
					thinkingLevel: "high",
				}),
			);
			// The launch's admitted pair stays as it was admitted.
			expect(definitionOf(dir).admitted).toEqual({
				provider: "faux",
				modelId: "faux-3",
				thinkingLevel: "low",
			});
			expect(JSON.stringify(real.requests("main"))).not.toContain("ran dry");
		},
	);

	// Two pis one after another (audit, then its Resume): a readiness bound for each to start, and one for the rest.
	it(
		"holds to the role it was admitted with, narrowed by its orchestrator's rules as they are now",
		{ timeout: 3 * readinessMs },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			const release = join(real.cwd, "..", "release");
			writeFileSync(join(real.cwd, "secret.txt"), "SECRET-S\n");
			addSettings(real, { defaultTools: ["+grep"] });
			role(real.cwd, "auditor", "Audit v1.", ["tools: [read, grep]", "thinkingLevel: off"]);
			real.script("main", [
				{ tool: "subagent", args: { agent: "auditor", name: "audit", task: "Read secret.txt." } },
				{ tool: "subagent_resume", args: { agent: "audit", task: "Read it again." }, until: release },
				{ text: "waiting" },
				{ text: "done" },
			]);
			const read = { tool: "read", args: { path: "secret.txt" } };
			real.script("audit", [read, { text: "Read it." }, read, { text: "Could not." }]);
			real.start(["--", "delegate"]);
			await real.waitForRequests("main", 2);
			// Between its generations: its role's file now asks for more, and its orchestrator now denies the file.
			role(real.cwd, "auditor", "Audit v2.", ["tools: [read, grep, ls]", "thinkingLevel: off"]);
			addSettings(real, { permissions: { deny: ["Read(secret.txt)"] } });
			writeFileSync(release, "");
			await real.waitForRequests("main", 4);

			const audit = real.requests("audit");
			expect(audit).toHaveLength(4);
			expect(lastToolResult(audit[1])?.text).toBe("SECRET-S\n");
			expect(systemPrompt(audit[2])).toContain("Audit v1.");
			expect(systemPrompt(audit[2])).not.toContain("Audit v2.");
			expect(toolNames(audit[2])).toEqual(["grep", "read", "subagent_message"]);
			expect(lastToolResult(audit[3])?.text).toMatch(/Blocked by permission rule/);
			const dir = runDirOf(real.agentDir, "audit");
			expect(definitionOf(dir)).toMatchObject({
				instructions: "Audit v1.",
				tools: ["read", "grep"],
			});
			expect(JSON.stringify(definitionOf(dir, 1).deny)).toContain("Read(secret.txt)");
		},
	);

	it("refuses when its workspace is gone, rather than continuing anywhere else", async () => {
		const real = await startOrchestrator();
		pi = real;
		const release = join(real.cwd, "..", "release");
		const pkg = join(real.cwd, "pkg");
		mkdirSync(pkg);
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", cwd: "pkg", task: "Look." } },
			{ tool: "subagent_resume", args: { agent: "look", task: "Look again." }, until: release },
			{ text: "refused" },
		]);
		real.script("look", [{ text: "Looked." }, { text: "Looked again." }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);
		rmSync(pkg, { recursive: true });
		writeFileSync(release, "");
		const main = await real.waitForRequests("main", 3);

		expect(lastToolResult(main[2])?.text).toMatch(
			new RegExp(
				`Cannot resume "look" \\(sub_[^)]+\\): its workspace ${realpathSync(real.cwd)}/pkg is no longer available`,
			),
		);
		expect(real.requests("look")).toHaveLength(1);
		const dir = runDirOf(real.agentDir, "look");
		expect(generationDefinition(dir, 1)).toBeUndefined();
		expect(runNamed(real.agentDir, "look").record).toMatchObject({ generation: 0, status: "closed" });
	});

	// Two pis one after another (look, then one pi for both Resumes): a readiness bound for each to start, and one for
	// the rest.
	it("starts one pi on its session when two Resumes come at once", { timeout: 3 * readinessMs }, async () => {
		const real = await startOrchestrator();
		pi = real;
		const resume = (task: string) => ({ tool: "subagent_resume", args: { agent: "look", task } });
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look." } },
			{ calls: [resume("First."), resume("Second.")] },
			{ text: "waiting" },
			{ text: "done" },
		]);
		real.script("look", [{ text: "Looked." }, { text: "Resumed once." }, { text: "Resumed twice." }]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 4);

		const results = conversation(main[2])
			.filter(({ toolName }) => toolName === "subagent_resume")
			.map(({ text }) => text);
		expect(results).toHaveLength(2);
		expect(results.filter((text) => text.startsWith("Resuming"))).toHaveLength(1);
		expect(
			results.filter((text) => !text.startsWith("Resuming") && /Cannot resume|still (starting|running)/.test(text)),
		).toHaveLength(1);
		// Proves only that no second pi asked within this while.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const look = real.requests("look");
		expect(look).toHaveLength(2);
		expect(conversation(look[1]).filter(({ role }) => role === "user")).toHaveLength(2);
		const dir = runDirOf(real.agentDir, "look");
		expect(definitionOf(dir, 1)).toBeDefined();
		expect(generationDefinition(dir, 2)).toBeUndefined();
		expect(reportSeqs(dir)).toEqual([1, 2]);
	});
});
