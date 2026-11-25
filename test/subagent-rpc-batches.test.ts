import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import { storedRunReportTextPath } from "../ext/subagents/storage.ts";
import {
	conversation,
	FAUX,
	type FauxRequest,
	type FauxStep,
	hasTmux,
	type RealPi,
	startRealPi,
	systemPrompt,
} from "./helpers/real-pi.ts";
import { hostState, runDirOf, storedRuns } from "./helpers/run-files.ts";
import { nothingWithin, piStartsTimeout, whicheverStarted } from "./helpers/run-timing.ts";
import { waitFor } from "./helpers/wait-for.ts";

function records(agentDir: string): SubagentRunRecord[] {
	return storedRuns(agentDir).map(({ record }) => record);
}

function batchManifests(real: RealPi): string | false {
	const root = join(real.agentDir, "bluclawd", "subagents");
	const manifests = readdirSync(root).flatMap((session) => {
		const dir = join(root, session, "batches");
		return existsSync(dir) ? readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8")) : [];
	});
	return manifests.length > 0 && manifests.join("\n");
}

function recordOf(real: RealPi, name: string): SubagentRunRecord {
	const record = records(real.agentDir).find((stored) => stored.name === name);
	if (!record) throw new Error(`no run named ${name}`);
	return record;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...readJson(path), ...added }));
}

const toolResults = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.map(({ text }) => text);

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

const writer = {
	name: "writer",
	description: "Edits files.",
	instructions: "Make the change asked.",
	tools: ["read", "edit", "write"],
};

async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi();
}

describe.skipIf(!hasTmux)("a tasks batch of RPC runs", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("refuses a contradictory, empty or invalid batch, naming each entry at fault, before any of it starts", async () => {
		const real = await startOrchestrator();
		pi = real;
		const subagent = (args: JsonObject) => ({ tool: "subagent", args });
		real.script("main", [
			{
				calls: [
					subagent({ agent: "explorer", task: "Look.", tasks: [{ agent: "explorer", task: "Look too." }] }),
					subagent({ tasks: [{ agent: "explorer", task: "Look." }], model: "faux/faux-2" }),
					subagent({ tasks: [] }),
					subagent({
						tasks: [
							{ agent: "explorer", task: "Look.", name: "fine" },
							{ agent: "nosuch", task: "Look.", name: "unknown" },
							{ agent: "explorer", task: "  ", name: "blank" },
							{
								agent: { name: "writer", description: "Writes.", instructions: "Write.", tools: ["bash"] },
								task: "Write.",
								name: "writer",
							},
							{ agent: writer, task: "Edit.", name: "editor" },
						],
					}),
					subagent({
						tasks: [
							{ agent: "explorer", task: "Look.", name: "twin" },
							{ agent: "explorer", task: "Look again.", name: "twin" },
						],
					}),
					subagent({ tasks: [{ agent: "explorer", task: "Look.", name: "batch_mine" }] }),
					subagent({}),
					subagent({ tasks: [{ agent: "explorer" }] }),
				],
			},
			{ text: "all refused" },
		]);
		real.start(["--", "delegate"]);
		const [, answered] = await real.waitForRequests("main", 2);
		const [both, model, empty, invalid, twins, reserved, none, taskless] = toolResults(answered);
		expect(both).toMatch(/`tasks` and `agent`, `task` are alternative shapes/);
		expect(model).toMatch(/`tasks` and `model` are alternative shapes/);
		expect(empty).toMatch(/tasks: expected at least 1 items/);
		expect(invalid).toMatch(/^No task of the batch was started:/);
		expect(invalid).toMatch(/tasks\[1\] \("unknown"\): .*nosuch/);
		expect(invalid).toMatch(/tasks\[2\] \("blank"\): Missing required parameter: task/);
		expect(invalid).toMatch(/tasks\[3\] \("writer"\): .*(none can be made|gets no shell here)/);
		expect(invalid).toMatch(
			/tasks\[4\] \("editor"\): .*isolated Git worktree, and none can be made: .* is not in a Git repository/,
		);
		expect(invalid).not.toMatch(/tasks\[0\]/);
		expect(twins).toMatch(/tasks\[1\] \("twin"\): .*also the name of tasks\[0\]/);
		expect(reserved).toMatch(/tasks\[0\] \("batch_mine"\): Invalid subagent name/);
		expect(none).toMatch(/Missing required parameter: agent/);
		expect(taskless).toMatch(/tasks\.0\.task: missing/);
		expect(records(real.agentDir)).toEqual([]);
		expect(readdirSync(join(real.agentDir, "faux")).filter((file) => file.endsWith(".requests.jsonl"))).toEqual([
			"main.requests.jsonl",
		]);
	});

	it(
		"runs a foreground batch side by side within the shared capacity, each task as it chose, and returns one aggregate once all settle",
		{ timeout: piStartsTimeout(2) },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			addSettings(real, { subagents: { panes: false, maxActive: 2 } });
			for (const dir of ["a", "b"]) {
				mkdirSync(join(real.cwd, dir));
				writeFileSync(join(real.cwd, dir, "here.txt"), `IN-${dir.toUpperCase()}\n`);
			}
			const gate = (name: string) => join(real.cwd, `${name}.go`);
			real.script("main", [
				{
					tool: "subagent",
					args: {
						tasks: [
							{
								agent: "explorer",
								name: "ta",
								task: "Look in a.",
								cwd: "a",
								model: "faux/faux-2",
								thinkingLevel: "high",
							},
							{
								agent: "explorer",
								name: "tb",
								task: "Look in b.",
								cwd: "b",
								model: "faux/faux-3",
								thinkingLevel: "low",
							},
							{
								agent: { name: "scout", description: "Scouts.", instructions: "You are SCOUT-ROLE." },
								name: "tc",
								task: "Look, tc.",
							},
						],
					},
				},
				{ text: "read the batch" },
			]);
			for (const name of ["ta", "tb"]) {
				real.script(name, [
					{ tool: "read", args: { path: "here.txt" } },
					{ text: `${name} saw it.`, until: gate(name) },
				]);
			}
			real.script("tc", [{ text: "tc done.", until: gate("tc") }]);
			real.start(["--", "delegate"]);
			await real.waitForRequests("main", 1);

			const names = ["ta", "tb", "tc"];
			const atGate = (name: string) => real.requests(name).length === (name === "tc" ? 1 : 2);
			await waitFor(() => expect(names.filter(atGate)).toHaveLength(2));
			const [first, second] = names.filter(atGate);
			const [queued, ...more] = names.filter((name) => real.requests(name).length === 0);
			expect(more).toEqual([]);
			expect(recordOf(real, queued).status).toBe("starting");

			writeFileSync(gate(first), "");
			await waitFor(() => expect(atGate(queued)).toBe(true));
			writeFileSync(gate(second), "");
			await waitFor(() =>
				expect([first, second].map((name) => recordOf(real, name).status)).toEqual(["closed", "closed"]),
			);
			await nothingWithin(500);
			expect(real.requests("main")).toHaveLength(1);

			writeFileSync(gate(queued), "");
			const main = await real.waitForRequests("main", 2);
			const [ta, tb, [tc]] = names.map((name) => real.requests(name));
			expect(ta[0]).toMatchObject({ model: "faux-2", reasoning: "high" });
			expect(tb[0]).toMatchObject({ model: "faux-3", reasoning: "low" });
			expect(toolResults(ta[1])).toEqual(["IN-A\n"]);
			expect(toolResults(tb[1])).toEqual(["IN-B\n"]);
			expect(systemPrompt(tc)).toContain("SCOUT-ROLE");
			const results = toolResults(main[1]);
			expect(results).toHaveLength(1);
			const [aggregate] = results;
			expect(aggregate).toMatch(
				/^\[Reports from the subagents of batch batch_\w+, from other sessions, not from the user\./,
			);
			expect(aggregate).toMatch(/Batch batch_\w+: 3 tasks, 3 completed, 0 failed, 0 cancelled\./);
			for (const name of ["ta", "tb"])
				expect(aggregate).toMatch(
					new RegExp(`### "${name}" \\(sub_[\\w-]+\\): completed\\nChecks: [^\\n]+\\n${name} saw it\\.`),
				);
			expect(aggregate).toMatch(/### "tc" \(sub_[\w-]+\): completed\nChecks: [^\n]+\ntc done\./);
			const manifest = /Every member's status, full Report and transcript: (\S+)/.exec(aggregate)?.[1] ?? "";
			const listed = readFileSync(manifest, "utf8");
			for (const [i, name] of ["ta", "tb", "tc"].entries()) {
				expect(listed).toMatch(new RegExp(`- tasks\\[${i}\\] "${name}" \\(sub_[\\w-]+\\): completed`));
				expect(listed).toContain(`Report: ${storedRunReportTextPath(runDirOf(real.agentDir, name), 1)}`);
			}
			expect(recordOf(real, "ta")).toMatchObject({
				cwd: realpathSync(join(real.cwd, "a")),
				batch: expect.stringMatching(/^batch_/),
			});
		},
	);

	it("cancels every member, working or queued, when the foreground call is cancelled; a queued one never starts", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { panes: false, maxActive: 1 } });
		const names = ["m0", "m1", "m2"];
		real.script("main", [
			{
				tool: "subagent",
				args: { tasks: names.map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` })) },
			},
		]);
		for (const name of names) real.script(name, [{ text: "Never.", until: join(real.cwd, "never") }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);
		const [working] = await waitFor(() => {
			const started = whicheverStarted(real, names);
			expect(started).toHaveLength(1);
			return started;
		});
		const queued = names.filter((name) => name !== working);
		expect(queued.map((name) => recordOf(real, name).status)).toEqual(["starting", "starting"]);

		real.tmux.sendKeys(pane, ["Escape"]);
		await waitFor(() => {
			for (const name of names) {
				expect(recordOf(real, name)).toMatchObject({ status: "cancelled", stopSource: "caller" });
			}
		});
		const manifest = await waitFor(() => batchManifests(real));
		expect(manifest).toMatch(
			new RegExp(`- tasks\\[${names.indexOf(working)}\\] "${working}" \\(sub_[\\w-]+\\): cancelled`),
		);
		await nothingWithin(1000);
		for (const name of queued) {
			expect(real.requests(name)).toEqual([]);
			expect(hostState(runDirOf(real.agentDir, name))).toBeUndefined();
		}
	});

	it(
		"stops a background batch whole by its ID, a member alone by its name, and reports once with what finished",
		{ timeout: piStartsTimeout(2) },
		async () => {
			const real = await startOrchestrator();
			pi = real;
			addSettings(real, { subagents: { panes: false, maxActive: 1 } });
			const names = ["m0", "m1", "m2", "m3"];
			const gate = (name: string) => join(real.cwd, `${name}.go`);
			const steps = (batch: string, stopped: string): FauxStep[] => [
				{
					tool: "subagent",
					args: {
						tasks: names.map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` })),
						background: true,
					},
				},
				{ text: "waiting" },
				{ tool: "subagent_stop", args: { agent: stopped } },
				{ text: "stopped it" },
				{ tool: "subagent_stop", args: { agent: batch } },
				{ text: "stopped the batch" },
				{ text: "read the batch" },
			];
			real.script("main", steps("unknown", "unknown"));
			for (const name of names) real.script(name, [{ text: `${name} found it.`, until: gate(name) }]);
			const pane = real.start(["--", "delegate"]);
			const [, launched] = await real.waitForRequests("main", 2);
			const [result] = toolResults(launched);
			expect(result).toMatch(/^Background batch launched: batch_\w+, 4 subagents:/);
			expect(result).toContain("do not redo or touch their work, including the files in their scope");
			expect(result).toContain("Never predict or invent its results; if the user asks, say it is still running.");
			expect(result).toContain(
				"Progress does not wake you; findings, questions and blockers reach you as messages.",
			);
			expect(result).toContain("Their processes end by themselves once they report: there is nothing to close.");
			expect(result).toContain(
				[
					"While they run, do not redo or touch their work, including the files in their scope, and do not poll `subagent_status` by reflex. With no independent work left, end your turn and say you are waiting for the batch: its report will wake you. Never predict or invent its results; if the user asks, say it is still running.",
					"Progress does not wake you; findings, questions and blockers reach you as messages. Their processes end by themselves once they report: there is nothing to close.",
				].join("\n"),
			);
			const batch = /batch_\w+/.exec(result)?.[0] ?? "";

			const started = () => whicheverStarted(real, names);
			const [done] = await waitFor(() => {
				expect(started()).toHaveLength(1);
				return started();
			});
			writeFileSync(gate(done), "");
			await waitFor(() => expect(recordOf(real, done).status).toBe("closed"));
			const [working] = await waitFor(() => {
				expect(started()).toHaveLength(2);
				return started().filter((name) => name !== done);
			});
			const [stopped, waiting] = names.filter((name) => name !== done && name !== working);
			real.script("main", steps(batch, stopped));
			await nothingWithin(500);
			expect(real.requests("main")).toHaveLength(2);

			real.tmux.sendKeys(pane, [`stop ${stopped}`, "Enter"]);
			await real.waitForRequests("main", 4);
			expect(recordOf(real, stopped)).toMatchObject({
				status: "cancelled",
				stopReason: "Stopped by its orchestrator",
			});
			expect([recordOf(real, working).status, recordOf(real, waiting).status]).toEqual(["running", "starting"]);

			real.tmux.sendKeys(pane, ["stop the batch", "Enter"]);
			const main = await real.waitForRequests("main", 7);
			expect(toolResults(main[5]).at(-1)).toMatch(
				new RegExp(`Stopped "${working}" \\(sub_[\\w-]+\\): its work was cancelled`),
			);
			const aggregate = conversation(main[6]).at(-1)?.text ?? "";
			expect(aggregate).toMatch(new RegExp(`Batch ${batch}: 4 tasks, 1 completed, 0 failed, 3 cancelled\\.`));
			expect(aggregate).toMatch(
				new RegExp(`- "${stopped}" \\(sub_[\\w-]+\\): cancelled: Stopped by its orchestrator`),
			);
			for (const name of [working, waiting]) {
				expect(aggregate).toMatch(
					new RegExp(`- "${name}" \\(sub_[\\w-]+\\): cancelled: Its batch ${batch} was stopped`),
				);
			}
			expect(aggregate).toMatch(
				new RegExp(`### "${done}" \\(sub_[\\w-]+\\): completed\\nChecks: [^\\n]+\\n${done} found it\\.`),
			);
			for (const name of [stopped, waiting]) {
				expect(real.requests(name)).toEqual([]);
				expect(hostState(runDirOf(real.agentDir, name))).toBeUndefined();
			}
			await nothingWithin(500);
			expect(real.requests("main")).toHaveLength(7);
		},
	);

	it("lets a member that edits work in a worktree of its own beside one that reads the checkout, and says where its edits are", async () => {
		const real = await startOrchestrator();
		pi = real;
		const repo = real.cwd;
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(repo, "init", "-q");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start");
		real.script("main", [
			{
				tool: "subagent",
				args: {
					tasks: [
						{ agent: writer, name: "w", task: "Write new.txt." },
						{ agent: "explorer", name: "r", task: "Read a.txt." },
					],
				},
			},
			{ text: "read the batch" },
		]);
		real.script("w", [{ tool: "write", args: { path: "new.txt", content: "NEW\n" } }, { text: "Wrote new.txt." }]);
		real.script("r", [{ tool: "read", args: { path: "a.txt" } }, { text: "Read a.txt." }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);
		await Promise.all([real.waitForRequests("w", 2), real.waitForRequests("r", 2)]);
		const [aggregate] = toolResults((await real.waitForRequests("main", 2))[1]);

		const worktree = recordOf(real, "w").cwd as string;
		expect(worktree).not.toBe(realpathSync(repo));
		expect(readFileSync(join(worktree, "new.txt"), "utf8")).toBe("NEW\n");
		expect(existsSync(join(repo, "new.txt"))).toBe(false);
		expect(recordOf(real, "r").cwd).toBe(realpathSync(repo));
		expect(toolResults(real.requests("r")[1])).toEqual(["one\n"]);
		expect(aggregate).toMatch(/2 tasks, 2 completed, 0 failed, 0 cancelled\./);
		expect(aggregate).toContain(`- "w" (${recordOf(real, "w").runId}): completed; its edits are in its worktree`);
		expect(aggregate).toMatch(
			/### "w" \(sub_[\w-]+\): completed\nWorkspace: .*\n.*\nChanges since its baseline: A new\.txt\nChecks: [^\n]+\nWrote new\.txt\./,
		);
		expect(aggregate).toMatch(/- "r" \(sub_[\w-]+\): completed\n/);
		const manifest = /Every member's status, full Report and transcript: (\S+)/.exec(aggregate)?.[1] ?? "";
		expect(readFileSync(manifest, "utf8")).toContain("  Changes since its baseline: A new.txt");
	});
});
