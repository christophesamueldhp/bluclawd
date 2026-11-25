import { spawn } from "node:child_process";
import { vi } from "vitest";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { claimGeneration, type HostSeat } from "../../ext/subagents/generation-state.ts";
import { writeRunOutbox } from "../../ext/subagents/run-mailbox.ts";
import { storeRunReport } from "../../ext/subagents/storage.ts";
import { sigkillIfAlive } from "./leaderless-group.ts";

export interface FakeRun {
	readonly name: string;
	readonly runDir: string;
	readonly args: readonly string[];
	readonly generation: number;
	readonly hostPid: number;
	readonly seat: HostSeat;
	ended: boolean;
}

export function fakeRunHosts() {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", "faux");
	const runs: FakeRun[] = [];
	const spies = [
		vi.spyOn(OrchestratorClient.prototype, "ensureDaemon").mockResolvedValue(true),
		vi.spyOn(OrchestratorClient.prototype, "claimRun").mockResolvedValue(true),
		vi.spyOn(OrchestratorClient.prototype, "releaseRun").mockResolvedValue(undefined),
		vi.spyOn(OrchestratorClient.prototype, "launchRun").mockImplementation(async (_run, host) => {
			const waiter = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", host.runDir], {
				detached: true,
				stdio: "ignore",
			});
			waiter.unref();
			const hostPid = waiter.pid ?? 0;
			const seat = claimGeneration(host.runDir, hostPid);
			if (!seat) {
				waiter.kill();
				throw new Error(`Another host holds the run in ${host.runDir}`);
			}
			const { spec } = seat;
			const run: FakeRun = {
				name: spec.args[spec.args.indexOf("--name") + 1],
				runDir: host.runDir,
				args: spec.args,
				generation: spec.generation ?? 0,
				hostPid,
				seat,
				ended: false,
			};
			waiter.on("exit", () => {
				run.ended = true;
			});
			runs.push(run);
			return hostPid;
		}),
	];
	const runNamed = (name: string) => {
		const run = [...runs].reverse().find((candidate) => candidate.name === name);
		if (!run) throw new Error(`No run named ${name} has started.`);
		return run;
	};
	let sent = 0;
	return {
		runs,
		report(name: string, text: string) {
			const run = runNamed(name);
			const reportSeq = storeRunReport(run.runDir, {
				text,
				outcome: { status: "completed" },
				generation: run.generation,
			});
			run.seat.save({ reportSeq, outcome: { status: "completed" }, exit: { code: 0, signal: null } });
			process.kill(-run.hostPid, "SIGKILL");
		},
		progress(name: string, content: string) {
			const run = runNamed(name);
			writeRunOutbox(run.runDir, run.generation, { seq: ++sent, to: "parent", kind: "progress", content });
		},
		dispose() {
			for (const run of runs) sigkillIfAlive(-run.hostPid);
			for (const spy of spies) spy.mockRestore();
		},
	};
}
