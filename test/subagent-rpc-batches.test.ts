import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

/** A run's directory, by the run's name. */
function runDir(real: RealPi, name: string): string {
	const root = join(real.agentDir, "bluclawd", "subagents");
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const record = join(root, session, run, "record.json");
			if (existsSync(record) && JSON.parse(readFileSync(record, "utf8")).name === name)
				return join(root, session, run);
		}
	}
	throw new Error(`no run named ${name}`);
}

/** The manifests of every batch the orchestrator settled, one after another; false while there is none. */
function batchManifests(real: RealPi): string | false {
	const root = join(real.agentDir, "bluclawd", "subagents");
	const manifests = readdirSync(root).flatMap((session) => {
		const dir = join(root, session, "batches");
		return existsSync(dir) ? readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8")) : [];
	});
	return manifests.length > 0 && manifests.join("\n");
}

/** A run's record, by the run's name. */
function recordOf(real: RealPi, name: string): Record<string, unknown> & { reportPath?: string; status?: string } {
	const record = records(real.agentDir).find((stored) => stored.name === name);
	if (!record) throw new Error(`no run named ${name}`);
	return record;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** Merges `added` into the settings every pi of the test reads, as they are read next. */
function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...readJson(path), ...added }));
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

/** An inline role that edits files: it works in a worktree of its own. */
const writer = {
	name: "writer",
	description: "Edits files.",
	instructions: "Make the change asked.",
	tools: ["read", "edit", "write"],
};

/** An orchestrator pane whose runs are RPC children, which load the faux provider as the pane does. */
async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
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
		// A member is held to what a single run is: commands and edits only in a worktree of its own.
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

	it("runs a foreground batch side by side within the shared capacity, each task as it chose, and returns one aggregate once all settle", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { maxActive: 2 } });
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
		real.script("tc", [{ text: "tc done." }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);

		// Both working at once, the third queued behind them, and the orchestrator waiting for all three.
		const [ta, tb] = await Promise.all([real.waitForRequests("ta", 2), real.waitForRequests("tb", 2)]);
		expect(ta[0]).toMatchObject({ model: "faux-2", reasoning: "high" });
		expect(tb[0]).toMatchObject({ model: "faux-3", reasoning: "low" });
		expect(toolResults(ta[1])).toEqual(["IN-A\n"]);
		expect(toolResults(tb[1])).toEqual(["IN-B\n"]);
		expect(real.requests("tc")).toEqual([]);

		writeFileSync(gate("ta"), "");
		const [tc] = await real.waitForRequests("tc", 1);
		expect(systemPrompt(tc)).toContain("SCOUT-ROLE");
		await waitFor(() => expect(recordOf(real, "tc").status).toBe("closed"));
		// Proves only that the batch did not answer within this while, tb still working.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(real.requests("main")).toHaveLength(1);

		writeFileSync(gate("tb"), "");
		const main = await real.waitForRequests("main", 2);
		const results = toolResults(main[1]);
		expect(results).toHaveLength(1);
		const [aggregate] = results;
		expect(aggregate).toMatch(
			/^\[Reports from the subagents of batch batch_\w+, from other sessions, not from the user\./,
		);
		expect(aggregate).toMatch(/Batch batch_\w+: 3 tasks, 3 completed, 0 failed, 0 cancelled\./);
		for (const name of ["ta", "tb"])
			expect(aggregate).toMatch(new RegExp(`### "${name}" \\(sub_[\\w-]+\\): completed\\n${name} saw it\\.`));
		expect(aggregate).toMatch(/### "tc" \(sub_[\w-]+\): completed\ntc done\./);
		const manifest = /Every member's status, full Report and transcript: (\S+)/.exec(aggregate)?.[1] ?? "";
		const listed = readFileSync(manifest, "utf8");
		for (const [i, name] of ["ta", "tb", "tc"].entries()) {
			expect(listed).toMatch(new RegExp(`- tasks\\[${i}\\] "${name}" \\(sub_[\\w-]+\\): completed`));
			expect(listed).toContain(`Report: ${join(runDir(real, name), "reports", "1.md")}`);
		}
		expect(recordOf(real, "ta")).toMatchObject({
			cwd: realpathSync(join(real.cwd, "a")),
			batch: expect.stringMatching(/^batch_/),
		});
	});

	it("leaves a failed member's siblings working, and keeps every outcome and each successful Report", async () => {
		const real = await startOrchestrator();
		pi = real;
		const gate = (name: string) => join(real.cwd, `${name}.go`);
		real.script("main", [
			{
				tool: "subagent",
				args: {
					tasks: ["ok1", "bad", "ok2"].map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` })),
				},
			},
			{ text: "read the batch" },
		]);
		real.script("bad", [{ text: "Half a thought.", error: "the faux provider broke" }]);
		for (const name of ["ok1", "ok2"]) real.script(name, [{ text: `${name} found it.`, until: gate(name) }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);

		await waitFor(() => expect(recordOf(real, "bad").status).toBe("closed"));
		expect([recordOf(real, "ok1").status, recordOf(real, "ok2").status]).toEqual(["running", "running"]);
		expect(real.requests("main")).toHaveLength(1);

		for (const name of ["ok1", "ok2"]) writeFileSync(gate(name), "");
		const [aggregate] = toolResults((await real.waitForRequests("main", 2))[1]);
		expect(aggregate).toMatch(/3 tasks, 2 completed, 1 failed, 0 cancelled\./);
		expect(aggregate).toMatch(/- "bad" \(sub_[\w-]+\): failed: the faux provider broke/);
		expect(aggregate).not.toMatch(/### "bad"/);
		for (const name of ["ok1", "ok2"]) {
			expect(aggregate).toMatch(new RegExp(`- "${name}" \\(sub_[\\w-]+\\): completed`));
			expect(aggregate).toMatch(new RegExp(`### "${name}" \\(sub_[\\w-]+\\): completed\\n${name} found it\\.`));
		}
		expect(real.requests("bad")).toHaveLength(1);
	});

	it("cancels every member, working or queued, when the foreground call is cancelled; a queued one never starts", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { maxActive: 1 } });
		real.script("main", [
			{
				tool: "subagent",
				args: { tasks: ["act", "q1", "q2"].map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` })) },
			},
		]);
		real.script("act", [{ text: "Never.", until: join(real.cwd, "never") }]);
		for (const name of ["q1", "q2"]) real.script(name, [{ text: "Never started." }]);
		const pane = real.start(["--", "delegate"]);
		await real.waitForRequests("main", 1);
		await real.waitForRequests("act", 1);
		expect([recordOf(real, "q1").status, recordOf(real, "q2").status]).toEqual(["starting", "starting"]);

		real.tmux.sendKeys(pane, ["Escape"]);
		await waitFor(() => {
			for (const name of ["act", "q1", "q2"]) {
				expect(recordOf(real, name)).toMatchObject({ status: "cancelled", stopSource: "caller" });
			}
		});
		const manifest = await waitFor(() => batchManifests(real));
		expect(manifest).toMatch(/- tasks\[0\] "act" \(sub_[\w-]+\): cancelled/);
		// Proves only that neither starts within this while, the slot free.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		for (const name of ["q1", "q2"]) {
			expect(real.requests(name)).toEqual([]);
			expect(existsSync(join(runDir(real, name), "rpc-host.json"))).toBe(false);
		}
	});

	it("stops a background batch whole by its ID, a member alone by its name, and reports once with what finished", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { maxActive: 1 } });
		const names = ["m0", "m1", "m2", "m3"];
		const steps = (batch: string): FauxStep[] => [
			{
				tool: "subagent",
				args: {
					tasks: names.map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` })),
					background: true,
				},
			},
			{ text: "waiting" },
			{ tool: "subagent_stop", args: { agent: "m2" } },
			{ text: "stopped m2" },
			{ tool: "subagent_stop", args: { agent: batch } },
			{ text: "stopped the batch" },
			{ text: "read the batch" },
		];
		real.script("main", steps("unknown"));
		real.script("m0", [{ text: "m0 found it." }]);
		for (const name of ["m1", "m2", "m3"]) real.script(name, [{ text: "Never.", until: join(real.cwd, "never") }]);
		const pane = real.start(["--", "delegate"]);
		const [, launched] = await real.waitForRequests("main", 2);
		const [result] = toolResults(launched);
		expect(result).toMatch(/^Background batch launched: batch_\w+, 4 subagents:/);
		const batch = /batch_\w+/.exec(result)?.[0] ?? "";
		real.script("main", steps(batch));

		// One slot: m1 starts once m0 is done, each start waited for on its own.
		await waitFor(() => expect(recordOf(real, "m0").status).toBe("closed"));
		await real.waitForRequests("m1", 1);
		// m0's Report waits for its batch's: it wakes nobody on its own.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(real.requests("main")).toHaveLength(2);

		real.tmux.sendKeys(pane, ["stop m2", "Enter"]);
		await real.waitForRequests("main", 4);
		expect(recordOf(real, "m2")).toMatchObject({ status: "cancelled", stopReason: "Stopped by its orchestrator" });
		expect([recordOf(real, "m1").status, recordOf(real, "m3").status]).toEqual(["running", "starting"]);

		real.tmux.sendKeys(pane, ["stop the batch", "Enter"]);
		const main = await real.waitForRequests("main", 7);
		expect(toolResults(main[5]).at(-1)).toMatch(/Stopped "m1" \(sub_[\w-]+\): its work was cancelled/);
		const aggregate = conversation(main[6]).at(-1)?.text ?? "";
		expect(aggregate).toMatch(new RegExp(`Batch ${batch}: 4 tasks, 1 completed, 0 failed, 3 cancelled\\.`));
		expect(aggregate).toMatch(/- "m2" \(sub_[\w-]+\): cancelled: Stopped by its orchestrator/);
		for (const name of ["m1", "m3"]) {
			expect(aggregate).toMatch(
				new RegExp(`- "${name}" \\(sub_[\\w-]+\\): cancelled: Its batch ${batch} was stopped`),
			);
		}
		expect(aggregate).toMatch(/### "m0" \(sub_[\w-]+\): completed\nm0 found it\./);
		for (const name of ["m2", "m3"]) {
			expect(real.requests(name)).toEqual([]);
			expect(existsSync(join(runDir(real, name), "rpc-host.json"))).toBe(false);
		}
		// Proves only that nothing else woke the orchestrator within this while.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(real.requests("main")).toHaveLength(7);
	});

	it("bounds the aggregate of a batch whose Reports exceed it, and keeps every full Report", async () => {
		const real = await startOrchestrator();
		pi = real;
		const names = ["l1", "l2", "l3"];
		const long = (name: string) => `${name} begins. ${"Lots of findings. ".repeat(600)}${name} ends.`;
		real.script("main", [
			{
				tool: "subagent",
				args: { tasks: names.map((name) => ({ agent: "explorer", name, task: `Look, ${name}.` })) },
			},
			{ text: "read the batch" },
		]);
		for (const name of names) real.script(name, [{ text: long(name) }]);
		real.start(["--", "delegate"]);
		// Each start waited for on its own: the orchestrator's, then its runs'.
		await real.waitForRequests("main", 1);
		for (const name of names) await real.waitForRequests(name, 1);
		const [aggregate] = toolResults((await real.waitForRequests("main", 2))[1]);
		expect(Buffer.byteLength(aggregate)).toBeLessThanOrEqual(16 * 1024);
		expect(aggregate).toMatch(/3 tasks, 3 completed, 0 failed, 0 cancelled\./);
		for (const name of names) {
			expect(aggregate).toMatch(new RegExp(`### "${name}" \\(sub_[\\w-]+\\): completed\\n${name} begins\\.`));
			expect(aggregate).not.toContain(`${name} ends.`);
			const full = join(runDir(real, name), "reports", "1.md");
			expect(aggregate).toContain(`[Cut short; its full Report: ${full}]`);
			expect(readFileSync(full, "utf8")).toContain(`${name} ends.`);
		}
	});

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
			/### "w" \(sub_[\w-]+\): completed\nWorkspace: .*\n.*\nChanges since its baseline: A new\.txt\nWrote new\.txt\./,
		);
		expect(aggregate).toMatch(/- "r" \(sub_[\w-]+\): completed\n/);
		const manifest = /Every member's status, full Report and transcript: (\S+)/.exec(aggregate)?.[1] ?? "";
		expect(readFileSync(manifest, "utf8")).toContain("  Changes since its baseline: A new.txt");
	});
});
