import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { processStarted } from "../daemon/processes.ts";
import {
	admitGeneration,
	claimGeneration,
	generationDefinition,
	generationState,
	movePane,
	narrowGeneration,
	runProcessesLeft,
	runWorkspace,
	storeLaunch,
} from "../ext/subagents/generation-state.ts";
import type { RpcHostSpec } from "../ext/subagents/rpc-host.ts";
import type { RunDefinition } from "../ext/subagents/rpc-runs.ts";
import { leaderlessGroup } from "./helpers/leaderless-group.ts";

const definition = (tools: string[] = ["read"]): RunDefinition => ({
	name: "explorer",
	description: "Reads.",
	instructions: "Look around.",
	source: "bundled",
	model: "inherit",
	tools,
	deny: [],
	cwd: "/work",
	projectTrusted: false,
	admitted: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
});

const spec = (generation: number, pane?: RpcHostSpec["pane"]): RpcHostSpec => ({
	args: ["--mode", "rpc"],
	cwd: "/work",
	agentDir: "/agent",
	prompt: "Look.",
	model: { provider: "faux", id: "faux-1", thinkingLevel: "off" },
	generation,
	...(pane ? { pane } : {}),
});

const read = (path: string) => readFileSync(path, "utf8");
const exitedCleanly = { code: 0, signal: null };

describe("a Generation's state on disk", () => {
	let runDir: string;
	beforeEach(() => {
		runDir = mkdtempSync(join(tmpdir(), "bc-generation-state-"));
	});
	afterEach(() => {
		rmSync(runDir, { recursive: true, force: true });
	});

	const host = (): ChildProcess & { pid: number } => {
		const waiter = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", runDir], {
			detached: true,
			stdio: "ignore",
		});
		const { pid } = waiter;
		if (pid === undefined) throw new Error("the host did not start");
		onTestFinished(() => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
		});
		return Object.assign(waiter, { pid });
	};
	const end = async (waiter: ChildProcess & { pid: number }) => {
		const exited = new Promise((resolve) => waiter.once("exit", resolve));
		process.kill(-waiter.pid, "SIGKILL");
		await exited;
	};

	it("is unadmitted with nothing stored, and admitted once its definition is, with its spec once stored", () => {
		expect(generationState(runDir, 0)).toEqual({ at: "unadmitted" });
		expect(admitGeneration(runDir, 0, definition())).toBe(true);
		expect(generationState(runDir, 0)).toEqual({ at: "admitted" });
		storeLaunch(runDir, spec(0));
		expect(generationState(runDir, 0)).toEqual({ at: "admitted", launch: spec(0) });
	});

	it("stamps each Generation's definition with when it was admitted, a Resume's with its own", () => {
		const before = Date.now();
		admitGeneration(runDir, 0, definition());
		const launched = generationDefinition(runDir, 0)?.admittedAt ?? 0;
		expect(launched).toBeGreaterThanOrEqual(before);
		admitGeneration(runDir, 1, { ...definition(), admittedAt: 1 });
		expect(generationDefinition(runDir, 1)?.admittedAt).toBeGreaterThanOrEqual(launched);
	});

	it("is hosted while the host that took it runs, ended once it stored how its pi exited", async () => {
		admitGeneration(runDir, 0, definition());
		storeLaunch(runDir, spec(0));
		const waiter = host();
		const seat = claimGeneration(runDir, waiter.pid);
		expect(seat?.spec).toEqual(spec(0));
		seat?.save({ childPid: 42, sessionFile: "/s.jsonl", sessionId: "s" });
		expect(generationState(runDir, 0)).toMatchObject({
			at: "hosted",
			hostPid: waiter.pid,
			awaiting: false,
			childPid: 42,
			sessionFile: "/s.jsonl",
			launch: spec(0),
		});

		seat?.save({ outcome: { status: "completed" }, reportSeq: 1, exit: exitedCleanly });
		const ended = generationState(runDir, 0);
		expect(ended).toMatchObject({ at: "ended", hostPid: waiter.pid, exit: exitedCleanly, reportSeq: 1 });
		expect(ended).not.toHaveProperty("gone");
		await end(waiter);
		expect(generationState(runDir, 0)).toMatchObject({ at: "ended", gone: true });
		expect(generationState(runDir, 0, waiter.pid)).not.toHaveProperty("gone");
	});

	it("is lost once the host that took it is gone with no exit stored", async () => {
		storeLaunch(runDir, spec(0));
		const waiter = host();
		claimGeneration(runDir, waiter.pid)?.save({ reportSeq: 3, notStarted: "the daemon restarted" });
		await end(waiter);
		expect(generationState(runDir, 0)).toMatchObject({
			at: "lost",
			hostPid: waiter.pid,
			gone: true,
			reportSeq: 3,
			notStarted: "the daemon restarted",
		});
		expect(generationState(runDir, 0, waiter.pid)).toMatchObject({ at: "lost", hostPid: waiter.pid });
		expect(generationState(runDir, 0, waiter.pid)).not.toHaveProperty("gone");
	});

	it("is hosted while anything of its host's group runs, its host gone", async () => {
		storeLaunch(runDir, spec(0));
		const group = await leaderlessGroup();
		claimGeneration(runDir, group);
		expect(generationState(runDir, 0)).toMatchObject({ at: "hosted", hostPid: group });
		expect(generationState(runDir, 0, group)).toMatchObject({ at: "lost", hostPid: group });
	});

	it("takes a host's pid read from disk for gone once another process has it, unless the caller launched it", () => {
		storeLaunch(runDir, spec(0));
		claimGeneration(runDir, process.pid);
		expect(generationState(runDir, 0)).toMatchObject({ at: "lost", hostPid: process.pid, gone: true });
		expect(generationState(runDir, 0, process.pid)).toMatchObject({ at: "hosted", hostPid: process.pid });
	});

	it("follows the host launched until one takes the generation", async () => {
		storeLaunch(runDir, spec(0));
		const waiter = host();
		expect(generationState(runDir, 0, waiter.pid)).toMatchObject({ at: "hosted", hostPid: waiter.pid });
		const first = host();
		claimGeneration(runDir, first.pid);
		expect(generationState(runDir, 0, waiter.pid)).toMatchObject({ at: "hosted", hostPid: first.pid });
		await end(waiter);
		expect(generationState(runDir, 0, waiter.pid)).toMatchObject({ at: "hosted", hostPid: first.pid });
	});

	it("does not take the state an earlier generation's host stored for the next one's", () => {
		storeLaunch(runDir, spec(0));
		const earlier = host();
		claimGeneration(runDir, earlier.pid)?.save({ sessionFile: "/s.jsonl", reportSeq: 1, exit: exitedCleanly });
		admitGeneration(runDir, 1, definition());
		storeLaunch(runDir, { ...spec(1), sessionFile: "/s.jsonl" });
		expect(generationState(runDir, 1)).toEqual({ at: "admitted", launch: { ...spec(1), sessionFile: "/s.jsonl" } });

		const launched = host();
		const state = generationState(runDir, 1, launched.pid);
		expect(state).toMatchObject({ at: "hosted", hostPid: launched.pid });
		expect(state).toMatchObject({ sessionFile: undefined, reportSeq: undefined });
		expect(generationState(runDir, 0, earlier.pid)).toMatchObject({ at: "ended", reportSeq: 1 });
		expect(generationState(runDir, 0, earlier.pid)).not.toHaveProperty("launch");
	});

	it("keeps the spec of the latest generation only, its pane moved only while it is that one's", () => {
		const pane = { session: "sub_run-1", parent: "pi-before" };
		storeLaunch(runDir, spec(0, { session: "sub_run-0", parent: "pi-before" }));
		storeLaunch(runDir, spec(1, pane));
		expect(generationState(runDir, 0)).not.toHaveProperty("launch");
		expect(movePane(runDir, 0, "pi-now")).toBe(false);
		expect(movePane(runDir, 1, "pi-now")).toBe(true);
		admitGeneration(runDir, 1, definition());
		expect(generationState(runDir, 1)).toEqual({
			at: "admitted",
			launch: spec(1, { session: "sub_run-1", parent: "pi-now" }),
		});

		const waiter = host();
		const seat = claimGeneration(runDir, waiter.pid);
		expect(seat?.paneParent()).toBe("pi-now");
		movePane(runDir, 1, "pi-later");
		expect(seat?.paneParent()).toBe("pi-later");
		storeLaunch(runDir, spec(2));
		expect(seat?.paneParent()).toBe("pi-now");
		expect(movePane(runDir, 2, "pi-later")).toBe(false);
	});

	it("says what its pi in a pane waits on only for a generation in a pane", async () => {
		storeLaunch(runDir, spec(0, { session: "sub_run-0", parent: "pi" }));
		const waiter = host();
		const seat = claimGeneration(runDir, waiter.pid);
		const child = claimGeneration(runDir, waiter.pid);
		child?.saveChild({ awaiting: true });
		expect(generationState(runDir, 0)).toMatchObject({ at: "hosted", awaiting: true });
		seat?.save({ exit: exitedCleanly });
		await end(waiter);

		storeLaunch(runDir, spec(1));
		const next = host();
		claimGeneration(runDir, next.pid);
		expect(JSON.parse(read(join(runDir, "pane-child.json")))).toEqual({ awaiting: true });
		expect(generationState(runDir, 1)).toMatchObject({ at: "hosted", awaiting: false });
	});

	it("gives a generation to one host only, which gets it back as it stored it", () => {
		storeLaunch(runDir, spec(0, { session: "sub_run-0", parent: "pi" }));
		const first = host();
		const second = host();
		const seat = claimGeneration(runDir, first.pid);
		expect(seat).toBeDefined();
		expect(claimGeneration(runDir, second.pid)).toBeUndefined();
		seat?.save({ childPid: 7 });

		const child = claimGeneration(runDir, first.pid);
		child?.saveChild({ sessionId: "s", awaiting: false });
		const again = claimGeneration(runDir, first.pid);
		expect(read(join(runDir, "hosts", "0"))).toBe(String(first.pid));
		expect(JSON.parse(read(join(runDir, "rpc-host.json")))).toEqual({
			hostPid: first.pid,
			generation: 0,
			hostStarted: processStarted(first.pid),
			childPid: 7,
		});
		expect(JSON.parse(read(join(runDir, "pane-child.json")))).toEqual({ sessionId: "s", awaiting: false });
		again?.save({ exit: exitedCleanly });
		expect(JSON.parse(read(join(runDir, "rpc-host.json")))).toEqual({
			hostPid: first.pid,
			generation: 0,
			hostStarted: processStarted(first.pid),
			childPid: 7,
			exit: exitedCleanly,
		});
	});

	it("takes what its pi in a pane stored into its host's state with the host's next save", () => {
		writeFileSync(join(runDir, "pane-child.json"), JSON.stringify({ reportSeq: 9 }));
		storeLaunch(runDir, spec(0, { session: "sub_run-0", parent: "pi" }));
		const seat = claimGeneration(runDir, process.pid);
		expect(existsSync(join(runDir, "pane-child.json"))).toBe(false);
		claimGeneration(runDir, process.pid)?.saveChild({ sessionFile: "/s.jsonl", sessionId: "s", reportSeq: 2 });
		expect(seat?.takeChild()).toEqual({ sessionFile: "/s.jsonl", sessionId: "s", reportSeq: 2 });
		expect(JSON.parse(read(join(runDir, "rpc-host.json")))).toEqual({
			hostPid: process.pid,
			generation: 0,
			hostStarted: processStarted(process.pid),
		});
		seat?.save({ exit: exitedCleanly });
		expect(JSON.parse(read(join(runDir, "rpc-host.json")))).toEqual({
			hostPid: process.pid,
			generation: 0,
			hostStarted: processStarted(process.pid),
			sessionFile: "/s.jsonl",
			sessionId: "s",
			reportSeq: 2,
			exit: exitedCleanly,
		});
	});

	it("gives a Resume's generation to one Resume only, and writes the launch's over", () => {
		expect(admitGeneration(runDir, 0, definition())).toBe(true);
		expect(admitGeneration(runDir, 0, definition(["read", "grep"]))).toBe(true);
		expect(generationDefinition(runDir, 0)?.tools).toEqual(["read", "grep"]);
		expect(admitGeneration(runDir, 1, definition(["read"]))).toBe(true);
		expect(admitGeneration(runDir, 1, definition(["read", "bash"]))).toBe(false);
		expect(generationDefinition(runDir, 1)?.tools).toEqual(["read"]);
		expect(readdirSync(join(runDir, "generations"))).toEqual(["1.json"]);
		narrowGeneration(runDir, 1, definition([]));
		expect(generationDefinition(runDir, 1)?.tools).toEqual([]);
	});

	it("reads a definition only whole, and a run's workspace from its launch's", () => {
		const workspace = { root: "/worktrees/run", baseline: { source: "/repo", commit: "abc" } };
		admitGeneration(runDir, 0, { ...definition(), workspace } as RunDefinition);
		admitGeneration(runDir, 1, { ...definition(), workspace: { ...workspace, root: "/elsewhere" } } as RunDefinition);
		expect(runWorkspace(runDir)).toEqual(workspace);
		writeFileSync(join(runDir, "definition.json"), JSON.stringify({ ...definition(), admitted: {} }));
		expect(generationDefinition(runDir, 0)).toBeUndefined();
		expect(runWorkspace(runDir)).toBeUndefined();
		expect(generationDefinition(runDir, 2)).toBeUndefined();
	});

	it("refuses a host a spec that is missing or not a run's", () => {
		expect(() => claimGeneration(runDir, process.pid)).toThrow(/rpc-spec\.json/);
		writeFileSync(join(runDir, "rpc-spec.json"), JSON.stringify({ ...spec(0), generation: -1 }));
		expect(() => claimGeneration(runDir, process.pid)).toThrow(/not a run's spec/);
		expect(existsSync(join(runDir, "hosts"))).toBe(false);
	});

	it("says which process group of the run's latest host may still run, its host among them", async () => {
		expect(runProcessesLeft(runDir)).toBeUndefined();
		storeLaunch(runDir, spec(0));
		const waiter = host();
		const seat = claimGeneration(runDir, waiter.pid);
		expect(runProcessesLeft(runDir)).toEqual({ group: waiter.pid, host: true });
		seat?.save({ exit: exitedCleanly });
		expect(runProcessesLeft(runDir)).toEqual({ group: waiter.pid, host: true });
		await end(waiter);
		expect(runProcessesLeft(runDir)).toBeUndefined();
	});

	it("says only the host's group still runs once the host ended and a process it started did not", async () => {
		storeLaunch(runDir, spec(0));
		const group = await leaderlessGroup();
		claimGeneration(runDir, group)?.save({ exit: exitedCleanly });
		expect(runProcessesLeft(runDir)).toEqual({ group, host: false });
	});

	it("takes a process given the host's pid since for none of the run's, though it leads a group of its own", () => {
		const other = host();
		const stored = { hostPid: other.pid, generation: 0, hostStarted: "an earlier start" };
		writeFileSync(join(runDir, "rpc-host.json"), JSON.stringify({ ...stored, exit: exitedCleanly }));
		expect(runProcessesLeft(runDir)).toBeUndefined();
		writeFileSync(join(runDir, "rpc-host.json"), JSON.stringify(stored));
		expect(runProcessesLeft(runDir)).toBeUndefined();
	});

	it("takes a live pid for the host when no start compares, as in a state stored before hosts stored theirs", () => {
		writeFileSync(join(runDir, "rpc-host.json"), JSON.stringify({ hostPid: process.pid }));
		expect(runProcessesLeft(runDir)).toEqual({ group: process.pid, host: true });
	});

	it("keeps the files as ADR-0010 names them, in their format", () => {
		const held = definition();
		admitGeneration(runDir, 0, held);
		admitGeneration(runDir, 1, held);
		const launched = { ...spec(1, { session: "sub_run-1", parent: "pi" }), sessionFile: "/s.jsonl" };
		storeLaunch(runDir, launched);
		const seat = claimGeneration(runDir, process.pid);
		seat?.save({ childPid: 7 });
		seat?.saveChild({ awaiting: true });

		const stamped = (path: string) => {
			const { admittedAt } = JSON.parse(read(path));
			expect(admittedAt).toEqual(expect.any(Number));
			return JSON.stringify({ ...held, admittedAt }, null, 2);
		};
		for (const path of [join(runDir, "definition.json"), join(runDir, "generations", "1.json")]) {
			expect(read(path)).toBe(stamped(path));
		}
		expect(read(join(runDir, "rpc-spec.json"))).toBe(JSON.stringify(launched));
		expect(read(join(runDir, "hosts", "1"))).toBe(String(process.pid));
		expect(read(join(runDir, "rpc-host.json"))).toBe(
			JSON.stringify({ hostPid: process.pid, generation: 1, hostStarted: processStarted(process.pid), childPid: 7 }),
		);
		expect(read(join(runDir, "pane-child.json"))).toBe('{"awaiting":true}');
	});
});
