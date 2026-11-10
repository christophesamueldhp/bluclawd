import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversation, FAUX, hasTmux, type RealPi, startRealPi, systemPrompt } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** A run's directory, as its orchestrator stored it, by the run's name. */
function runDir(agentDir: string, name: string): string {
	const root = join(agentDir, "bluclawd", "subagents");
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const record = join(root, session, run, "record.json");
			if (existsSync(record) && JSON.parse(readFileSync(record, "utf8")).name === name)
				return join(root, session, run);
		}
	}
	throw new Error(`no run named ${name}`);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Merges `added` into the settings every pi of the test reads, as they are read next. */
function addSettings(real: RealPi, added: Record<string, unknown>): void {
	const path = join(real.agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ ...readJson(path), ...added }));
}

/** The commands of the processes still running on the test's files that contain `marker`. */
function processes(real: RealPi, marker: string): string[] {
	const base = basename(dirname(real.agentDir));
	return spawnSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" })
		.stdout.split("\n")
		.filter((line) => line.includes(base) && line.includes(marker));
}

/** An orchestrator pane whose runs are RPC children, which load the faux provider as the pane does. */
async function startOrchestrator(): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi();
}

/** A background launch of an explorer named `name`. */
const launch = (name: string) => ({
	tool: "subagent",
	args: { agent: "explorer", name, task: `Look, ${name}.`, background: true },
});

describe.skipIf(!hasTmux)("the daemon's queue of RPC runs", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("runs four children at once, and holds the rest back with no process and no model call until a slot frees", async () => {
		const real = await startOrchestrator();
		pi = real;
		const names = Array.from({ length: 9 }, (_, i) => `q${i + 1}`);
		const gate = (name: string) => join(real.cwd, `${name}.go`);
		real.script("main", [{ calls: names.map(launch) }, ...Array(12).fill({ text: "waiting" })]);
		for (const name of names) real.script(name, [{ text: `${name} done.`, until: gate(name) }]);
		real.start(["--", "delegate"]);
		const main = await real.waitForRequests("main", 2);
		const launched = conversation(main[1]).filter(({ toolName }) => toolName === "subagent");
		expect(launched.map(({ text }) => text.split("\n")[0])).toEqual(
			names.map((name) => expect.stringMatching(new RegExp(`^Background subagent launched: ${name} \\(sub_`))),
		);

		const started = () => names.filter((name) => real.requests(name).length > 0);
		await waitFor(() => expect(started()).toHaveLength(4));
		// Proves only that no fifth starts within this while.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(started()).toHaveLength(4);
		expect(processes(real, "rpc-host.ts")).toHaveLength(4);
		// pi names its process, so its pi is known by the pid its host stored.
		const children = started().map((name) => readJson(join(runDir(real.agentDir, name), "rpc-host.json")).childPid);
		expect(children.filter(alive)).toHaveLength(4);
		const queued = names.filter((name) => !started().includes(name));
		for (const name of queued) expect(existsSync(join(runDir(real.agentDir, name), "rpc-host.json"))).toBe(false);

		for (const name of names) writeFileSync(gate(name), "");
		await waitFor(() => {
			for (const name of names) {
				expect(readJson(join(runDir(real.agentDir, name), "record.json"))).toMatchObject({ status: "closed" });
			}
		});
		expect(names.map((name) => real.requests(name).length)).toEqual(names.map(() => 1));
		await waitFor(() => expect(processes(real, "rpc-host.ts")).toEqual([]));
		expect(children.filter(alive)).toEqual([]);
	});

	it("gives a freed slot to the orchestrator served least recently, a Resume taking its turn as a launch does", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { maxActive: 2 } });
		const gate = (name: string) => join(real.cwd, `${name}.go`);
		const alpha = ["a1", "a2", "a3", "a4"];
		real.script("beta", [
			{ tool: "subagent", args: { agent: "explorer", name: "kept", task: "Remember PELICAN." } },
			{ tool: "subagent_resume", args: { agent: "kept", task: "Which codeword?" }, until: gate("resume") },
			...Array(4).fill({ text: "waiting" }),
		]);
		real.script("kept", [{ text: "Remembered." }, { text: "PELICAN.", until: gate("kept") }]);
		real.script("alpha", [{ calls: alpha.map(launch) }, ...Array(6).fill({ text: "waiting" })]);
		for (const name of alpha) real.script(name, [{ text: `${name} done.`, until: gate(name) }]);
		const started = () => [...alpha, "kept"].filter((name) => real.requests(name).length > (name === "kept" ? 1 : 0));

		real.start(["--name", "beta", "--", "delegate"]);
		await real.waitForRequests("beta", 2);
		real.start(["--name", "alpha", "--", "delegate"]);
		await waitFor(() => expect(started()).toEqual(["a1", "a2"]));
		writeFileSync(gate("resume"), "");
		const beta = await real.waitForRequests("beta", 3);
		expect(
			conversation(beta[2])
				.filter(({ role }) => role === "toolResult")
				.at(-1)?.text,
		).toMatch(/Resuming "kept" \(sub_[^)]+\) in the background/);
		// Proves only that the Resume did not start within this while.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(started()).toEqual(["a1", "a2"]);

		// a3 was queued first, but alpha was served last.
		writeFileSync(gate("a1"), "");
		await waitFor(() => expect(started()).toEqual(["a1", "a2", "kept"]));
		writeFileSync(gate("a2"), "");
		await waitFor(() => expect(started()).toEqual(["a1", "a2", "a3", "kept"]));
		for (const name of [...alpha, "kept"]) writeFileSync(gate(name), "");
		await waitFor(() => {
			for (const name of [...alpha, "kept"]) {
				expect(readJson(join(runDir(real.agentDir, name), "record.json"))).toMatchObject({ status: "closed" });
			}
		});
		expect(readJson(join(runDir(real.agentDir, "kept"), "record.json")).generation).toBe(1);
	});

	it("starts a queued run as it was admitted, unless its delegation is denied by the time its turn comes", async () => {
		const real = await startOrchestrator();
		pi = real;
		addSettings(real, { subagents: { maxActive: 1 } });
		const auditor = (instructions: string, model: string, thinking: string) =>
			writeFileSync(
				join(real.agentDir, "agents", "auditor.md"),
				[
					"---",
					"name: auditor",
					"description: Audits.",
					`model: ${model}`,
					`thinkingLevel: ${thinking}`,
					"---",
					instructions,
				].join("\n"),
			);
		mkdirSync(join(real.agentDir, "agents"));
		auditor("You are AUDITOR-ONE.", "faux/faux-2", "high");
		const gate = join(real.cwd, "hold.go");
		real.script("main", [
			{
				calls: [
					launch("hold"),
					{ tool: "subagent", args: { agent: "auditor", name: "later", task: "Audit.", background: true } },
					launch("denied"),
				],
			},
			...Array(6).fill({ text: "waiting" }),
		]);
		real.script("hold", [{ text: "Held.", until: gate }]);
		real.script("later", [{ text: "Audited." }]);
		real.script("denied", [{ text: "Ran." }]);
		real.start(["--", "delegate"]);
		await real.waitForRequests("main", 2);
		await real.waitForRequests("hold", 1);

		auditor("You are AUDITOR-TWO.", "faux/faux-3", "low");
		addSettings(real, { permissions: { deny: ["Subagent(explorer)"] } });
		writeFileSync(gate, "");
		const [asked] = await real.waitForRequests("later", 1);
		expect(asked).toMatchObject({ model: "faux-2", reasoning: "high" });
		expect(systemPrompt(asked)).toContain("AUDITOR-ONE");
		expect(systemPrompt(asked)).not.toContain("AUDITOR-TWO");

		const denied = runDir(real.agentDir, "denied");
		await waitFor(() =>
			expect(readJson(join(denied, "record.json"))).toMatchObject({
				status: "failed",
				errorMessage: expect.stringMatching(/^It did not start: .*Subagent\(explorer\)/),
			}),
		);
		await waitFor(() =>
			expect(JSON.stringify(real.requests("main").map(conversation))).toMatch(
				/Subagent \\"denied\\" \(sub_[^)]+\) did not start/,
			),
		);
		expect(real.requests("denied")).toEqual([]);
		expect(existsSync(join(denied, "rpc-host.json"))).toBe(false);
	});
});
