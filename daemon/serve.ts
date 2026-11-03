import { existsSync, unlinkSync } from "node:fs";
import { getServerDir, getSocketPath } from "./config.ts";
import { handleIpcRequest, listSummaries, setRemoteControl, setShutdownHook } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { ensureServerDir } from "./paths.ts";
import { RemoteControl, TMUX_TIMEOUT_MS } from "./remote/control.ts";
import { pistatusline } from "./remote/pistatusline.ts";
import { statusLine } from "./remote/statusline.ts";
import { ServerSupervisor } from "./supervisor.ts";
import { Tmux } from "./tmux.ts";

export async function serve(): Promise<void> {
	const socketPath = getSocketPath();
	ensureServerDir();
	const tmux = new Tmux(undefined, undefined, { timeoutMs: TMUX_TIMEOUT_MS });
	const supervisor = new ServerSupervisor({ now: Date.now, tmux, dir: getServerDir() });
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

	const remote = new RemoteControl({
		listInstances: () => listSummaries(supervisor),
		send: (id, message) => supervisor.sendExternal(id, message),
		deleteInstance: (id) => supervisor.deleteInstance(id),
		renameInstance: (id, name) => supervisor.renameInstance(id, name) !== undefined,
		setPinned: (id, pinned) => supervisor.setInstanceMeta(id, { pinned }) !== undefined,
		statusLine: statusLine(),
		renderStatusline: pistatusline(),
		tmux,
	});
	setRemoteControl(remote);
	await remote.apply();

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
