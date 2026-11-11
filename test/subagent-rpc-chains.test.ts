import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	conversation,
	FAUX,
	type FauxRequest,
	type FauxStep,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
	toolNames,
} from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** Every run the orchestrator stored, as its record. */
function records(agentDir: string): Array<Record<string, unknown>> {
	const root = join(agentDir, "bluclawd", "subagents");
	if (!existsSync(root)) return [];
	return readdirSync(root).flatMap((session) =>
		readdirSync(join(root, session)).flatMap((run) => {
			const record = join(root, session, run, "record.json");
			return existsSync(record) ? [JSON.parse(readFileSync(record, "utf8"))] : [];
		}),
	);
}

type StoredRecord = Record<string, unknown> & {
	runId: string;
	status: string;
	admittedAt: number;
	startedAt: number;
	endedAt?: number;
	generation: number;
	stopSource?: string;
	stopReason?: string;
};

/** A run's record, by the run's name; undefined while there is none. */
function recordOf(real: RealPi, name: string): StoredRecord | undefined {
	return records(real.agentDir).find((stored) => stored.name === name) as StoredRecord | undefined;
}

/** The texts of the tool results the model was given in `request`, in order. */
const toolResults = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.map(({ text }) => text);

/** Git in `cwd`, as a user of the fixture repository: its own identity, no hooks, no signing. */
function git(cwd: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

/** A committed repository in `dir`, with `files`, and an uncommitted change besides. */
function repository(dir: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries({ ".gitignore": ".env\n", ...files })) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	git(dir, "init", "-q");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "start");
	writeFileSync(join(dir, "pkg", "local.txt"), "uncommitted\n");
}

/** All of a checkout's state Git sees, ignored files and every ref included. */
function checkoutState(dir: string): string {
	return [
		git(dir, "status", "--porcelain=v1", "-uall", "--ignored"),
		git(dir, "diff"),
		git(dir, "for-each-ref", "refs/heads", "refs/tags"),
		git(dir, "rev-parse", "HEAD"),
	].join("\n");
}

/** An inline role that edits files: it works in a worktree, its chain's. */
const writer = {
	name: "writer",
	description: "Edits files.",
	instructions: "Make the change asked.",
	tools: ["read", "edit", "write"],
};

/**
 * Waits until the model of `session` got more than `before` requests: a pi started for it. Each pi start gets a wait of
 * its own.
 */
const started = (real: RealPi, session: string, before = 0) =>
	waitFor(() => expect(real.requests(session).length).toBeGreaterThan(before));

/** An orchestrator pane whose runs are RPC children, which load the faux provider as the pane does. */
async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi();
}

describe.skipIf(!hasTmux)("a chain of RPC runs", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("edits, reviews in a fresh context and repairs in the worker's own, one step after another in one worktree", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "pkg/a.txt": "one\n" });
		const before = checkoutState(repo);
		const gate = join(repo, "..", "w.go");
		real.script("main", [
			{
				tool: "subagent",
				args: {
					chain: [
						{ agent: writer, name: "w", cwd: "pkg", task: "WORKER-TASK: write new.txt." },
						{ agent: "reviewer", name: "rev", cwd: "pkg", task: "Review new.txt." },
						{ resume: "w", task: "Fix what the review found." },
					],
				},
			},
			{ text: "read the chain" },
		]);
		real.script("w", [
			{ tool: "write", args: { path: "new.txt", content: "v1\n" } },
			{ text: "Wrote v1.", until: gate },
			{ tool: "edit", args: { path: "new.txt", edits: [{ oldText: "v1", newText: "v2" }] } },
			{ text: "Fixed: v2." },
		]);
		real.script("rev", [
			{ tool: "read", args: { path: "new.txt" } },
			{ tool: "read", args: { path: "local.txt" } },
			{ text: "FINDING: new.txt says v1, it should say v2." },
		]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);

		// The worker holds: nothing of the review exists yet, though the queue has room for it.
		await started(real, "w");
		await real.waitForRequests("w", 2);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(recordOf(real, "rev")).toBeUndefined();
		expect(real.requests("rev")).toEqual([]);
		writeFileSync(gate, "");

		// Each pi start waited for on its own.
		await started(real, "rev");
		await started(real, "w", 2);
		const main = await real.waitForRequests("main", 2);
		const w = real.requests("w");
		const rev = real.requests("rev");
		expect(w).toHaveLength(4);
		expect(rev).toHaveLength(3);

		// Each step with its own role's tools: the reviewer cannot edit.
		expect(toolNames(w[0])).toEqual(expect.arrayContaining(["edit", "write"]));
		expect(toolNames(rev[0])).not.toContain("edit");
		expect(toolNames(rev[0])).not.toContain("write");
		expect(systemPrompt(rev[0])).toMatch(/You read an isolated Git worktree, .*You cannot change files/s);

		// The reviewer starts fresh: the worker's Report and where it worked, never its conversation.
		const review = conversation(rev[0]);
		expect(review).toHaveLength(1);
		expect(review[0].text).toContain("Review new.txt.");
		expect(review[0].text).toMatch(/the step before you, chain\[0\] "w"/);
		expect(review[0].text).toContain("Wrote v1.");
		expect(review[0].text).toMatch(/Changes since its baseline: .*A pkg\/new\.txt/);
		expect(review[0].text).not.toContain("WORKER-TASK");
		// It sees the worker's change, and the checkout's uncommitted state the chain started from.
		expect(toolResults(rev[2])).toEqual(["v1\n", "uncommitted\n"]);

		// The repair goes on in the worker's own session, given the review.
		const repair = conversation(w[2]).map(({ text }) => text);
		expect(repair[0]).toContain("WORKER-TASK");
		expect(repair).toContain("Wrote v1.");
		expect(repair.at(-1)).toContain("Fix what the review found.");
		expect(repair.at(-1)).toContain("FINDING: new.txt says v1, it should say v2.");

		// One step at a time: each started once the one before it had ended.
		const [worker, reviewer] = [recordOf(real, "w"), recordOf(real, "rev")];
		expect(worker).toMatchObject({ status: "closed", generation: 1 });
		expect(reviewer).toMatchObject({ status: "closed" });
		expect(reviewer?.endedAt).toBeLessThanOrEqual(worker?.startedAt ?? 0);
		expect(reviewer?.chain).toBe(worker?.chain);
		expect(worker?.chain).toMatch(/^chain_/);

		// One worktree holds the work of both writers; the checkout is as it was.
		const [aggregate] = toolResults(main[1]);
		expect(aggregate).toMatch(
			/^\[Reports from the subagents of chain chain_\w+, from other sessions, not from the user\./,
		);
		expect(aggregate).toMatch(/Chain chain_\w+: 3 steps, all completed\./);
		expect(aggregate).toMatch(/- chain\[0\] "w" \(sub_[\w-]+\): completed/);
		expect(aggregate).toMatch(/- chain\[1\] "rev" \(sub_[\w-]+\): completed/);
		expect(aggregate).toMatch(/- chain\[2\] "w" \(sub_[\w-]+\), resumed: completed/);
		expect(aggregate).toMatch(/### chain\[2\] "w" \(sub_[\w-]+\), resumed: completed\nFixed: v2\./);
		expect(aggregate).toMatch(/ready for you to review and integrate/);
		const workspace = /^Workspace: (.+?), an isolated Git worktree/m.exec(aggregate)?.[1] ?? "";
		expect(aggregate).toMatch(/^Changes since its baseline: A pkg\/new\.txt$/m);
		expect(readFileSync(join(workspace, "pkg", "new.txt"), "utf8")).toBe("v2\n");
		expect(checkoutState(repo)).toBe(before);
		expect(existsSync(join(repo, "pkg", "new.txt"))).toBe(false);
		const manifest = /Every step's status, full Report and transcript: (\S+)/.exec(aggregate)?.[1] ?? "";
		expect(readFileSync(manifest, "utf8")).toMatch(/- chain\[1\] "rev" \(sub_[\w-]+\): completed/);
		expect(JSON.stringify([...main, ...w, ...rev])).not.toContain("ran dry");
	});

	it("refuses a contradictory, malformed or cross-repository chain, naming each step at fault, before any of it starts", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "pkg/a.txt": "one\n" });
		const other = join(repo, "..", "other");
		repository(other, { "pkg/b.txt": "two\n" });
		const subagent = (args: JsonObject) => ({ tool: "subagent", args });
		real.script("main", [
			{
				calls: [
					subagent({
						chain: [{ agent: "explorer", task: "Look." }],
						tasks: [{ agent: "explorer", task: "Look." }],
					}),
					subagent({ chain: [{ agent: "explorer", task: "Look." }], model: "faux/faux-2" }),
					subagent({ chain: [] }),
					subagent({ chain: [{ task: "Look." }] }),
					subagent({ chain: [{ resume: "w", task: "Fix." }] }),
					subagent({
						chain: [
							{ agent: writer, name: "w", task: "Edit." },
							{ resume: "w", agent: "explorer", task: "Fix." },
						],
					}),
					subagent({
						chain: [
							{ agent: writer, name: "w", task: "Edit." },
							{ agent: "reviewer", name: "rev", cwd: other, task: "Review." },
							{ agent: "nosuch", name: "unknown", task: "Look." },
							{ agent: "explorer", name: "w", task: "Look." },
							{ agent: "explorer", name: "chain_mine", task: "Look." },
							{ resume: "w", task: "Fix.", thinkingLevel: "bogus" },
						],
					}),
				],
			},
			{ text: "all refused" },
		]);
		real.start(["--", "delegate"]);
		const [, answered] = await real.waitForRequests("main", 2);
		const [both, model, empty, agentless, unknownResume, resumeWithAgent, invalid] = toolResults(answered);
		expect(both).toMatch(/`tasks` and `chain` are alternative shapes/);
		expect(model).toMatch(/`chain` and `model` are alternative shapes/);
		expect(empty).toMatch(/chain: expected at least 1 items/);
		expect(agentless).toMatch(/chain\[0\]: give a step either `agent` or `resume`/);
		expect(unknownResume).toMatch(
			/chain\[0\]: `resume` names an earlier step of this chain .* no earlier step is named "w"/,
		);
		expect(resumeWithAgent).toMatch(/chain\[1\]: a step that resumes an earlier one .* leave out `agent`/);
		expect(invalid).toMatch(/^No step of the chain was started:/);
		expect(invalid).not.toMatch(/^- chain\[0\]/m);
		// One worktree for every step: a step in another repository cannot share it.
		expect(invalid).toMatch(
			/chain\[1\] \("rev"\): its cwd .*other is not in .*, the repository of the worktree the chain's steps share since chain\[0\] \("w"\) edits/,
		);
		expect(invalid).toMatch(/chain\[2\] \("unknown"\): .*nosuch/);
		expect(invalid).toMatch(/chain\[3\] \("w"\): "w" is also the name of chain\[0\]/);
		expect(invalid).toMatch(/chain\[4\] \("chain_mine"\): Invalid subagent name/);
		expect(invalid).toMatch(/chain\[5\] \("w"\): Invalid subagent "thinkingLevel" value "bogus"/);
		expect(records(real.agentDir)).toEqual([]);
		expect(git(repo, "for-each-ref", "refs/bluclawd")).toBe("");
		expect(readdirSync(join(real.agentDir, "faux")).filter((file) => file.endsWith(".requests.jsonl"))).toEqual([
			"main.requests.jsonl",
		]);
	});

	it("halts at a failed step, never runs the steps after it, and keeps the partial work for inspection", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		repository(repo, { "pkg/a.txt": "one\n" });
		real.script("main", [
			{
				tool: "subagent",
				args: {
					chain: [
						{ agent: writer, name: "w", task: "Write new.txt." },
						{ agent: "reviewer", name: "rev", task: "Review new.txt." },
						{ resume: "w", task: "Fix what the review found." },
					],
				},
			},
			{ text: "read the chain" },
		]);
		real.script("w", [{ tool: "write", args: { path: "new.txt", content: "v1\n" } }, { text: "Wrote v1." }]);
		real.script("rev", [{ text: "Half a review.", error: "the faux provider broke" }]);
		real.start(["--", "delegate"]);
		await started(real, "w");
		await started(real, "rev");
		const main = await real.waitForRequests("main", 2);
		const [aggregate] = toolResults(main[1]);
		expect(aggregate).toMatch(
			/Chain chain_\w+: 3 steps, halted at chain\[1\] \("rev"\), failed; 1 step did not run\./,
		);
		expect(aggregate).toMatch(/- chain\[0\] "w" \(sub_[\w-]+\): completed/);
		expect(aggregate).toMatch(/- chain\[1\] "rev" \(sub_[\w-]+\): failed: the faux provider broke/);
		expect(aggregate).toMatch(/- chain\[2\] \("w"\): not run, since chain\[1\] \("rev"\) failed/);
		expect(aggregate).toMatch(/keeps the partial work for you to inspect\. It is not ready to integrate/);
		expect(aggregate).toMatch(/### chain\[0\] "w" \(sub_[\w-]+\): completed\nWrote v1\./);
		const workspace = /^Workspace: (.+?), an isolated Git worktree/m.exec(aggregate)?.[1] ?? "";
		expect(readFileSync(join(workspace, "new.txt"), "utf8")).toBe("v1\n");
		// The repair never ran: the worker's session holds its first generation only.
		expect(real.requests("w")).toHaveLength(2);
		expect(recordOf(real, "w")).toMatchObject({ status: "closed", generation: 0 });
	});

	it("cancels the working step when the foreground call is cancelled, and never starts the next", async () => {
		const real = await startOrchestrator();
		pi = real;
		real.script("main", [
			{
				tool: "subagent",
				args: {
					chain: [
						{ agent: "explorer", name: "a", task: "Look first." },
						{ agent: "explorer", name: "b", task: "Look next." },
					],
				},
			},
		]);
		real.script("a", [{ text: "Never.", until: join(real.cwd, "never") }]);
		real.script("b", [{ text: "Never started." }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);
		await real.waitForRequests("a", 1);

		real.tmux.sendKeys(pane, ["Escape"]);
		await waitFor(() => expect(recordOf(real, "a")).toMatchObject({ status: "cancelled", stopSource: "caller" }));
		const manifest = await waitFor(() => {
			const root = join(real.agentDir, "bluclawd", "subagents");
			const dirs = readdirSync(root).map((session) => join(root, session, "chains"));
			const files = dirs.filter(existsSync).flatMap((dir) => readdirSync(dir).map((file) => join(dir, file)));
			expect(files).toHaveLength(1);
			return readFileSync(files[0], "utf8");
		});
		expect(manifest).toMatch(/- chain\[0\] "a" \(sub_[\w-]+\): cancelled/);
		expect(manifest).toMatch(/- chain\[1\] \("b"\): not run/);
		// Proves only that it does not start within this while.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(recordOf(real, "b")).toBeUndefined();
		expect(real.requests("b")).toEqual([]);
	});

	it("runs a background chain, refuses a Resume into its worktree while a step works there, and stops whole by its ID", async () => {
		const real = await startOrchestrator();
		pi = real;
		repository(real.cwd, { "pkg/a.txt": "one\n" });
		const steps = (chain: string): FauxStep[] => [
			{
				tool: "subagent",
				args: {
					chain: [
						{ agent: writer, name: "w", task: "Write new.txt." },
						{ agent: "reviewer", name: "rev", task: "Review new.txt." },
						{ resume: "w", task: "Fix what the review found." },
					],
					background: true,
				},
			},
			{ text: "waiting" },
			{ tool: "subagent_resume", args: { agent: "w", task: "Sneak in an edit." } },
			{ text: "refused" },
			{ tool: "subagent_stop", args: { agent: chain } },
			{ text: "stopped the chain" },
			{ text: "read the chain" },
		];
		real.script("main", steps("unknown"));
		real.script("w", [{ tool: "write", args: { path: "new.txt", content: "v1\n" } }, { text: "Wrote v1." }]);
		real.script("rev", [{ text: "Never.", until: join(real.cwd, "..", "never") }]);
		const pane = real.start(["--", "delegate"]);
		const [, launched] = await real.waitForRequests("main", 2);
		const [result] = toolResults(launched);
		expect(result).toMatch(/^Background chain launched: chain_\w+, 3 steps, from chain\[0\] \("w"\) "w" \(sub_/);
		const chain = /chain_\w+/.exec(result)?.[0] ?? "";
		real.script("main", steps(chain));

		await started(real, "w");
		await real.waitForRequests("rev", 1);
		real.tmux.sendKeys(pane, ["try", "Enter"]);
		const tried = await real.waitForRequests("main", 4);
		expect(toolResults(tried[3]).at(-1)).toMatch(
			/Cannot resume "w" \(sub_[\w-]+\): its worktree .* is in use by "rev" \(sub_[\w-]+\): no two runs work in one worktree at once/,
		);
		expect(real.requests("w")).toHaveLength(2);

		real.tmux.sendKeys(pane, ["stop", "Enter"]);
		const main = await real.waitForRequests("main", 7);
		expect(toolResults(main[5]).at(-1)).toMatch(/Stopped "rev" \(sub_[\w-]+\): its work was cancelled/);
		const aggregate =
			conversation(main[6])
				.map(({ text }) => text)
				.find((text) => text.includes(`Reports from the subagents of chain ${chain}`)) ?? "";
		expect(aggregate).toMatch(new RegExp(`Chain ${chain}: 3 steps, halted at chain\\[1\\] \\("rev"\\), cancelled`));
		expect(aggregate).toMatch(
			new RegExp(`- chain\\[1\\] "rev" \\(sub_[\\w-]+\\): cancelled: Its chain ${chain} was stopped`),
		);
		expect(aggregate).toMatch(/- chain\[2\] \("w"\): not run/);
		expect(real.requests("w")).toHaveLength(2);
		// Proves only that nothing else woke the orchestrator within this while.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(real.requests("main")).toHaveLength(7);
	});
});
