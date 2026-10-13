import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { getSocketPath } from "./config.ts";
import { handleIpcRequest, listSummaries, setRemoteControl, setShutdownHook } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { RemoteControl } from "./remote/control.ts";
import { supervisor } from "./supervisor.ts";

export async function serve(): Promise<void> {
	const socketPath = getSocketPath();
	// 0700: owner-only — the socket is an unauthenticated local control channel (it queues
	// prompts for running sessions).
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	const server = await startIpcServer(handleIpcRequest);

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
		listInstances: listSummaries,
		send: (id, message) => supervisor.sendExternal(id, message),
		deleteInstance: (id) => supervisor.deleteInstance(id),
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
