/**
 * Runs on pi's RPC with fake hosts, for tests of what an orchestrator shows of its runs: the daemon grants every
 * claim at once, and each host it would start is a process that only waits, in a group of its own, named after the
 * run's directory as a host is. The test speaks for the host: it writes the host's state, Report and messages.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { readRpcHostSpec } from "../../ext/subagents/rpc-host.ts";
import { writeRunOutbox } from "../../ext/subagents/run-mailbox.ts";
import { storeRunReport } from "../../ext/subagents/storage.ts";

/** A run's fake host. */
export interface FakeRun {
	/** Its name, from its pi's launch flags. */
	readonly name: string;
	readonly runDir: string;
	/** Its pi's command, as its host would start it. */
	readonly args: readonly string[];
	readonly generation: number;
	readonly hostPid: number;
	/** Whether its host is gone: it reported and exited, or it was stopped. */
	ended: boolean;
}

export function fakeRunHosts() {
	// The faux provider is the orchestrator's own; no run's pi starts to need it.
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", "faux");
	const runs: FakeRun[] = [];
	const writeState = (run: FakeRun, state: Record<string, unknown>) =>
		writeFileSync(
			join(run.runDir, "rpc-host.json"),
			JSON.stringify({ hostPid: run.hostPid, generation: run.generation, ...state }),
		);
	const spies = [
		vi.spyOn(OrchestratorClient.prototype, "ensureDaemon").mockResolvedValue(true),
		vi.spyOn(OrchestratorClient.prototype, "claimRun").mockResolvedValue(true),
		vi.spyOn(OrchestratorClient.prototype, "releaseRun").mockResolvedValue(undefined),
		vi.spyOn(OrchestratorClient.prototype, "launchRun").mockImplementation(async (_run, host) => {
			const spec = readRpcHostSpec(host.runDir);
			if (!spec) throw new Error(`No host spec in ${host.runDir}`);
			// Its run directory on its command line: a pid on disk counts as the run's host only then.
			const waiter = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", host.runDir], {
				detached: true,
				stdio: "ignore",
			});
			waiter.unref();
			const hostPid = waiter.pid ?? 0;
			const run: FakeRun = {
				name: spec.args[spec.args.indexOf("--name") + 1],
				runDir: host.runDir,
				args: spec.args,
				generation: spec.generation ?? 0,
				hostPid,
				ended: false,
			};
			waiter.on("exit", () => {
				run.ended = true;
			});
			// As a host does, it takes its generation, which a reloaded orchestrator then follows.
			mkdirSync(join(run.runDir, "hosts"), { recursive: true });
			writeFileSync(join(run.runDir, "hosts", String(run.generation)), String(hostPid));
			writeState(run, {});
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
		/** The runs started so far, oldest first. */
		runs,
		/** The run stores its Report `text` and its host exits, as an RPC run's does once its work settled. */
		report(name: string, text: string) {
			const run = runNamed(name);
			const reportSeq = storeRunReport(run.runDir, {
				text,
				outcome: { status: "completed" },
				generation: run.generation,
			});
			writeState(run, { reportSeq, outcome: { status: "completed" }, exit: { code: 0, signal: null } });
			process.kill(-run.hostPid, "SIGKILL");
		},
		/** The run tells its orchestrator its progress, with its own subagent_message, as a host relays it. */
		progress(name: string, content: string) {
			const run = runNamed(name);
			writeRunOutbox(run.runDir, run.generation, { seq: ++sent, to: "parent", kind: "progress", content });
		},
		/** Ends every host still running and restores the daemon client. */
		dispose() {
			for (const run of runs) {
				try {
					process.kill(-run.hostPid, "SIGKILL");
				} catch {
					// Gone already.
				}
			}
			for (const spy of spies) spy.mockRestore();
		},
	};
}
