import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Collaborations } from "./collaborations.ts";
import { getServerDir, getSocketPath } from "./config.ts";
import { type HandlerParts, handleIpcRequest, listSummaries } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { endLinuxRun } from "./linux-run-members.ts";
import { resumePane } from "./pane-start.ts";
import { daemonAgentDir, ensureOwnerOnlyServerDir } from "./paths.ts";
import { processGroupAlive } from "./processes.ts";
import { RemoteControl, TMUX_TIMEOUT_MS } from "./remote/control.ts";
import { pistatusline } from "./remote/pistatusline.ts";
import { launchUsable, startSession } from "./remote/spawn.ts";
import { statusLine } from "./remote/statusline.ts";
import { nativeHelperPath } from "./run-members.ts";
import { hostSafeEnv, RunQueue, userMaxActiveRuns } from "./run-queue.ts";
import { loadActiveRuns, saveActiveRuns } from "./storage.ts";
import { ServerSupervisor } from "./supervisor.ts";
import { Tmux } from "./tmux.ts";
import { isRun } from "./types.ts";
import { type HeldWakeups, processAlive, readPendingWakeups, WakeupKeeper } from "./wakeups.ts";

const RUN_HOST = fileURLToPath(new URL("../ext/subagents/rpc-host.ts", import.meta.url));
const RESOLVE_HOOK = fileURLToPath(new URL("./pi-resolve-hook.mjs", import.meta.url));

export async function serve(): Promise<void> {
	const serverDir = getServerDir();
	const socketPath = getSocketPath();
	ensureOwnerOnlyServerDir(serverDir);
	const wakeupLogPath = join(serverDir, "wakeups.log");
	const tmux = new Tmux(undefined, undefined, { timeoutMs: TMUX_TIMEOUT_MS });
	let remote: RemoteControl | undefined;
	const reopen = async (held: HeldWakeups) => {
		const launch = [held.launch, remote?.launch()].find(launchUsable);
		if (!launch) throw new Error("No usable launch to start pi with.");
		const spec = { cwd: held.cwd, sessionFile: held.sessionFile, label: held.label };
		await resumePane(
			{
				start: () => {
					const claimed = supervisor.claimStart(spec);
					if (!claimed.ok) throw new Error(`The session is ${claimed.refused}.`);
					return claimed.id;
				},
				startFailed: (id) => supervisor.startFailed(id),
			},
			spec,
			() => startSession({ ...spec, task: "", launch, tmux }),
		);
	};
	const wakeups = new WakeupKeeper({
		dir: serverDir,
		now: Date.now,
		alive: processAlive,
		pending: readPendingWakeups,
		reopen,
		log: (line) => {
			console.error(line);
			try {
				appendFileSync(wakeupLogPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
			} catch (error) {
				console.error(`Could not write the wake-up log at ${wakeupLogPath}:`, error);
			}
		},
	});
	const supervisor = new ServerSupervisor({ now: Date.now, tmux, dir: getServerDir(), wakeups });
	const parts: HandlerParts = { wakeups };
	const sweeps = new Map<number, "running" | "done">();
	parts.runQueue = new RunQueue({
		now: Date.now,
		store: { load: () => loadActiveRuns(getServerDir()), save: (runs) => saveActiveRuns(getServerDir(), runs) },
		capacity: () => userMaxActiveRuns(daemonAgentDir()),
		spawn: ({ runDir, env, pane }) => {
			if (pane)
				return tmux.startRunHost(pane, runDir, [process.execPath, "--import", RESOLVE_HOOK, RUN_HOST, runDir]);
			const root = process.env.PI_PACKAGE_ROOT;
			const host = spawn(process.execPath, ["--import", RESOLVE_HOOK, RUN_HOST, runDir], {
				cwd: runDir,
				env: { ...hostSafeEnv(env), ...(root ? { PI_PACKAGE_ROOT: root } : {}) },
				detached: true,
				stdio: "ignore",
			});
			host.on("error", () => {});
			host.unref();
			if (host.pid === undefined) throw new Error("the run's host did not start");
			return host.pid;
		},
		running: processGroupAlive,
		sweepStragglers: (pid, marker) => {
			const sweep = sweeps.get(pid);
			if (sweep === "done") {
				sweeps.delete(pid);
				return "swept";
			}
			if (!sweep) {
				sweeps.set(pid, "running");
				const swept = (ended: boolean) => (ended ? sweeps.set(pid, "done") : sweeps.delete(pid));
				if (process.platform === "linux") endLinuxRun(marker).then(swept);
				else
					execFile(
						nativeHelperPath("run-members", daemonAgentDir()).path,
						["end", marker],
						{ timeout: 10_000 },
						(error) => swept(!error),
					);
			}
			return "sweeping";
		},
	});
	parts.collaborations = new Collaborations({
		orchestratorSessions: () =>
			supervisor
				.listExternalInstances()
				.flatMap(({ record, silent }) =>
					record.sessionId && !isRun(record) && !silent
						? [{ instanceId: record.id, sessionId: record.sessionId, label: record.label, pane: record.pane }]
						: [],
				),
		deliver: (instanceId, message) => supervisor.sendExternal(instanceId, message),
	});
	const server = await startIpcServer((request) => handleIpcRequest(supervisor, request, parts));

	const releaseSocket = () => {
		server.close();
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
	};

	try {
		supervisor.recoverAfterRestart();
	} catch (error) {
		releaseSocket();
		throw error;
	}

	console.log(`server listening on ${socketPath}`);

	remote = new RemoteControl({
		listInstances: (probe) => listSummaries(supervisor, probe),
		probeForList: () => supervisor.probeForList(),
		send: (id, message) => supervisor.sendExternal(id, message),
		deleteInstance: (id) => supervisor.deleteInstance(id),
		renameInstance: (id, name) => supervisor.renameInstance(id, name) !== undefined,
		setPinned: (id, pinned) => supervisor.setInstanceMeta(id, { pinned }) !== undefined,
		claimStart: (spec) => supervisor.claimStart(spec),
		paneStarting: (spec) => supervisor.paneStarting(spec),
		startFailed: (id) => supervisor.startFailed(id),
		delivery: supervisor.delivery,
		statusLine: statusLine(),
		renderStatusline: pistatusline(),
		tmux,
	});
	parts.remote = remote;
	await remote.apply();
	wakeups.check();

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = async (exitCode: number) => {
		if (shutdownPromise) {
			await shutdownPromise;
			process.exit(exitCode);
		}

		shutdownPromise = (async () => {
			supervisor.settleWaits();
			releaseSocket();
			await remote.stop();
		})();

		await shutdownPromise;
		process.exit(exitCode);
	};

	parts.shutdown = () => {
		void shutdown(0);
	};
	process.on("SIGINT", () => {
		void shutdown(0);
	});
	process.on("SIGTERM", () => {
		void shutdown(0);
	});
	process.on("uncaughtException", (error) => {
		console.error(error);
		void shutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(reason);
		void shutdown(1);
	});

	await new Promise<never>(() => undefined);
}
