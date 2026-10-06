import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { BUILD_ID, getSocketPath, VERSION } from "../config.ts";
import {
	type ErrorResponse,
	encodeMessage,
	parseRequestLine,
	type ServerRequest,
	type ServerResponse,
} from "./protocol.ts";

export type IpcRequestHandler = (request: ServerRequest) => Promise<ServerResponse> | ServerResponse;

/** Stamp the daemon's version/buildId onto every reply. */
function withDaemonMeta<T extends ServerResponse>(response: T): T {
	return { ...response, version: VERSION, buildId: BUILD_ID };
}

export async function startIpcServer(handler: IpcRequestHandler): Promise<Server> {
	const socketPath = getSocketPath();
	await removeStaleSocketIfNeeded(socketPath);

	const server = createServer((socket) => {
		let buffer = "";

		socket.on("data", async (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				return;
			}

			try {
				const request = parseRequestLine(line);
				const response = await handler(request);
				socket.end(encodeMessage(withDaemonMeta(response)));
			} catch (error: unknown) {
				const response: ErrorResponse = {
					type: "error",
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
				socket.end(encodeMessage(withDaemonMeta(response)));
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return server;
}

async function removeStaleSocketIfNeeded(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	const isLive = await isSocketLive(socketPath);
	if (isLive) {
		throw new Error(`server is already running: ${socketPath}`);
	}

	unlinkSync(socketPath);
}

async function isSocketLive(socketPath: string): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;

		const finish = (result: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};

		socket.on("connect", () => finish(true));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
				finish(false);
				return;
			}
			if (error.code === "EPIPE" || error.code === "ECONNRESET") {
				finish(false);
				return;
			}
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			reject(error);
		});
	});
}
