import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import {
	admitGeneration,
	generationDefinition,
	generationState,
	hostGeneration,
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

	/** A host as the daemon starts one: in a group of its own, its command naming the run's directory. */
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
			} catch {
				// Gone already.
			}
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

	it("is hosted while the host that took it runs, ended once it stored how its pi exited", async () => {
		admitGeneration(runDir, 0, definition());
		storeLaunch(runDir, spec(0));
		const waiter = host();
		const seat = hostGeneration(runDir, waiter.pid);
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
		// Its host still runs: it is waited for, not taken for gone.
		expect(ended).not.toHaveProperty("gone");
		await end(waiter);
		expect(generationState(runDir, 0)).toMatchObject({ at: "ended", gone: true });
		// A host followed is not asked whether it is gone.
		expect(generationState(runDir, 0, waiter.pid)).not.toHaveProperty("gone");
	});

	it("is lost once the host that took it is gone with no exit stored", async () => {
		storeLaunch(runDir, spec(0));
		const waiter = host();
		hostGeneration(runDir, waiter.pid)?.save({ reportSeq: 3, notStarted: "the daemon restarted" });
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
		hostGeneration(runDir, group);
		expect(generationState(runDir, 0)).toMatchObject({ at: "hosted", hostPid: group });
		// A host this caller follows is the host's process alone.
		expect(generationState(runDir, 0, group)).toMatchObject({ at: "lost", hostPid: group });
	});

	it("takes a host's pid read from disk for gone once another process has it, unless the caller launched it", () => {
		storeLaunch(runDir, spec(0));
		// This process runs, and its command does not name the run's directory: the pid was given out again.
		hostGeneration(runDir, process.pid);
		expect(generationState(runDir, 0)).toMatchObject({ at: "lost", hostPid: process.pid, gone: true });
		expect(generationState(runDir, 0, process.pid)).toMatchObject({ at: "hosted", hostPid: process.pid });
	});

	it("follows the host launched until one takes the generation", async () => {
		storeLaunch(runDir, spec(0));
		const waiter = host();
		expect(generationState(runDir, 0, waiter.pid)).toMatchObject({ at: "hosted", hostPid: waiter.pid });
		// The one that took it, when another host launched before it did.
		const first = host();
		hostGeneration(runDir, first.pid);
		expect(generationState(runDir, 0, waiter.pid)).toMatchObject({ at: "hosted", hostPid: first.pid });
		await end(waiter);
		expect(generationState(runDir, 0, waiter.pid)).toMatchObject({ at: "hosted", hostPid: first.pid });
	});

	it("does not take the state an earlier generation's host stored for the next one's", () => {
		storeLaunch(runDir, spec(0));
		const earlier = host();
		hostGeneration(runDir, earlier.pid)?.save({ sessionFile: "/s.jsonl", reportSeq: 1, exit: exitedCleanly });
		admitGeneration(runDir, 1, definition());
		storeLaunch(runDir, { ...spec(1), sessionFile: "/s.jsonl" });
		expect(generationState(runDir, 1)).toEqual({ at: "admitted", launch: { ...spec(1), sessionFile: "/s.jsonl" } });

		const launched = host();
		const state = generationState(runDir, 1, launched.pid);
		expect(state).toMatchObject({ at: "hosted", hostPid: launched.pid });
		expect(state).toMatchObject({ sessionFile: undefined, reportSeq: undefined });
		// The earlier one is still as its host left it, but its spec is not the latest any more.
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
		const seat = hostGeneration(runDir, waiter.pid);
		expect(seat?.paneParent()).toBe("pi-now");
		movePane(runDir, 1, "pi-later");
		expect(seat?.paneParent()).toBe("pi-later");
		// Another generation's spec since: the pane it was taken with.
		storeLaunch(runDir, spec(2));
		expect(seat?.paneParent()).toBe("pi-now");
		expect(movePane(runDir, 2, "pi-later")).toBe(false);
	});

	it("says what its pi in a pane waits on only for a generation in a pane", async () => {
		storeLaunch(runDir, spec(0, { session: "sub_run-0", parent: "pi" }));
		const waiter = host();
		const seat = hostGeneration(runDir, waiter.pid);
		const child = hostGeneration(runDir, waiter.pid);
		child?.saveChild({ awaiting: true });
		expect(generationState(runDir, 0)).toMatchObject({ at: "hosted", awaiting: true });
		seat?.save({ exit: exitedCleanly });
		await end(waiter);

		// A Resume on RPC leaves what the pane's pi stored as it was, and is not taken to wait on it.
		storeLaunch(runDir, spec(1));
		const next = host();
		hostGeneration(runDir, next.pid);
		expect(JSON.parse(read(join(runDir, "pane-child.json")))).toEqual({ awaiting: true });
		expect(generationState(runDir, 1)).toMatchObject({ at: "hosted", awaiting: false });
	});

	it("gives a generation to one host only, which gets it back as it stored it", () => {
		storeLaunch(runDir, spec(0, { session: "sub_run-0", parent: "pi" }));
		const first = host();
		const second = host();
		const seat = hostGeneration(runDir, first.pid);
		expect(seat).toBeDefined();
		expect(hostGeneration(runDir, second.pid)).toBeUndefined();
		seat?.save({ childPid: 7 });

		// Its pi in a pane, given it by its host's pid: nothing taken again, nothing it stored cleared.
		const child = hostGeneration(runDir, first.pid);
		child?.saveChild({ sessionId: "s", awaiting: false });
		const again = hostGeneration(runDir, first.pid);
		expect(read(join(runDir, "hosts", "0"))).toBe(String(first.pid));
		expect(JSON.parse(read(join(runDir, "rpc-host.json")))).toEqual({
			hostPid: first.pid,
			generation: 0,
			childPid: 7,
		});
		expect(JSON.parse(read(join(runDir, "pane-child.json")))).toEqual({ sessionId: "s", awaiting: false });
		again?.save({ exit: exitedCleanly });
		expect(JSON.parse(read(join(runDir, "rpc-host.json")))).toEqual({
			hostPid: first.pid,
			generation: 0,
			childPid: 7,
			exit: exitedCleanly,
		});
	});

	it("takes what its pi in a pane stored into its host's state with the host's next save", () => {
		writeFileSync(join(runDir, "pane-child.json"), JSON.stringify({ reportSeq: 9 }));
		storeLaunch(runDir, spec(0, { session: "sub_run-0", parent: "pi" }));
		const seat = hostGeneration(runDir, process.pid);
		// What an earlier generation's pi stored is not this one's.
		expect(existsSync(join(runDir, "pane-child.json"))).toBe(false);
		hostGeneration(runDir, process.pid)?.saveChild({ sessionFile: "/s.jsonl", sessionId: "s", reportSeq: 2 });
		expect(seat?.takeChild()).toEqual({ sessionFile: "/s.jsonl", sessionId: "s", reportSeq: 2 });
		expect(JSON.parse(read(join(runDir, "rpc-host.json")))).toEqual({ hostPid: process.pid, generation: 0 });
		seat?.save({ exit: exitedCleanly });
		expect(JSON.parse(read(join(runDir, "rpc-host.json")))).toEqual({
			hostPid: process.pid,
			generation: 0,
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
		// Neither leaves a draft behind.
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
		expect(() => hostGeneration(runDir, process.pid)).toThrow(/rpc-spec\.json/);
		writeFileSync(join(runDir, "rpc-spec.json"), JSON.stringify({ ...spec(0), generation: -1 }));
		expect(() => hostGeneration(runDir, process.pid)).toThrow(/not a run's spec/);
		expect(existsSync(join(runDir, "hosts"))).toBe(false);
	});

	it("says which process group of the run's latest host may still run", async () => {
		expect(runProcessesLeft(runDir)).toBeUndefined();
		storeLaunch(runDir, spec(0));
		const waiter = host();
		const seat = hostGeneration(runDir, waiter.pid);
		expect(runProcessesLeft(runDir)).toEqual({ group: waiter.pid });
		seat?.save({ exit: exitedCleanly });
		// Its group still runs.
		expect(runProcessesLeft(runDir)).toEqual({ group: waiter.pid });
		await end(waiter);
		expect(runProcessesLeft(runDir)).toBeUndefined();
		// A live host is not asked whether it is the run's.
		writeFileSync(join(runDir, "rpc-host.json"), JSON.stringify({ hostPid: process.pid }));
		expect(runProcessesLeft(runDir)).toEqual({ group: process.pid });
	});

	it("keeps the files as ADR-0010 names them, in their format", () => {
		const held = definition();
		admitGeneration(runDir, 0, held);
		admitGeneration(runDir, 1, held);
		const launched = { ...spec(1, { session: "sub_run-1", parent: "pi" }), sessionFile: "/s.jsonl" };
		storeLaunch(runDir, launched);
		const seat = hostGeneration(runDir, process.pid);
		seat?.save({ childPid: 7 });
		seat?.saveChild({ awaiting: true });

		expect(read(join(runDir, "definition.json"))).toBe(JSON.stringify(held, null, 2));
		expect(read(join(runDir, "generations", "1.json"))).toBe(JSON.stringify(held, null, 2));
		expect(read(join(runDir, "rpc-spec.json"))).toBe(JSON.stringify(launched));
		expect(read(join(runDir, "hosts", "1"))).toBe(String(process.pid));
		expect(read(join(runDir, "rpc-host.json"))).toBe(`{"hostPid":${process.pid},"generation":1,"childPid":7}`);
		expect(read(join(runDir, "pane-child.json"))).toBe('{"awaiting":true}');
	});
});
