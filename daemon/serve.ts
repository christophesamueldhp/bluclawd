import { existsSync, unlinkSync } from "node:fs";
import { getServerDir, getSocketPath } from "./config.ts";
import { handleIpcRequest, listSummaries, setRemoteControl, setShutdownHook, setWakeupKeeper } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { resumePane } from "./pane-start.ts";
import { ensureServerDir } from "./paths.ts";
import { RemoteControl, TMUX_TIMEOUT_MS } from "./remote/control.ts";
import { pistatusline } from "./remote/pistatusline.ts";
import { launchUsable, startSession } from "./remote/spawn.ts";
import { statusLine } from "./remote/statusline.ts";
import { ServerSupervisor } from "./supervisor.ts";
import { Tmux } from "./tmux.ts";
import { type HeldWakeups, processAlive, readPendingWakeups, WakeupKeeper } from "./wakeups.ts";

export async function serve(): Promise<void> {
	const socketPath = getSocketPath();
	ensureServerDir();
	const tmux = new Tmux(undefined, undefined, { timeoutMs: TMUX_TIMEOUT_MS });
	let remote: RemoteControl | undefined;
	// A session whose pi is gone is opened again in agent view's tmux, as the phone resumes one: its pi then fires the
	// wake-up from its log, late.
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
		dir: getServerDir(),
		now: Date.now,
		alive: processAlive,
		pending: readPendingWakeups,
		reopen,
	});
	const supervisor = new ServerSupervisor({ now: Date.now, tmux, dir: getServerDir(), wakeups });
	setWakeupKeeper(wakeups);
	const server = await startIpcServer((request) => handleIpcRequest(supervisor, request));

	try {
		supervisor.recoverAfterRestart();
	} catch (error) {
		server.close();
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
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
	setRemoteControl(remote);
	await remote.apply();
	// Those due while the daemon was down fire now, late.
	wakeups.check();

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = async (exitCode: number) => {
		if (shutdownPromise) {
			await shutdownPromise;
			process.exit(exitCode);
		}

		shutdownPromise = (async () => {
			supervisor.settleWaits();
			server.close();
			// Before the slow stop, so a replacement daemon's new socket is never the one deleted.
			if (existsSync(socketPath)) {
				unlinkSync(socketPath);
			}
			await remote.stop();
		})();

		await shutdownPromise;
		process.exit(exitCode);
	};

	setShutdownHook(() => {
		void shutdown(0);
	});
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

	await new Promise<void>(() => {
		// Keep the process alive until a signal or fatal error triggers shutdown.
	});
}
