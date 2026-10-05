import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { BUILD_ID, getSocketPath, VERSION } from "../config.ts";
import type { ServerSupervisor } from "../supervisor.ts";
import { VIEW_PROTOCOL_VERSION } from "../view-types.ts";
import {
	type ErrorResponse,
	encodeMessage,
	type ListRequest,
	type ListResponse,
	type ProtocolMessage,
	parseRequestLine,
	type RpcBridgeResponse,
	type RpcReadyResponse,
	type RpcRequest,
	type RpcStreamRequest,
	type ServerRequest,
	type ServerResponse,
	type SpawnRequest,
	type SpawnResponse,
	type StatusRequest,
	type StatusResponse,
	type StopRequest,
	type StopResponse,
	type ViewAnswerRequest,
} from "./protocol.ts";
export interface IpcRequestHandler {
	(request: SpawnRequest): Promise<SpawnResponse | ErrorResponse> | SpawnResponse | ErrorResponse;
	(request: ListRequest): Promise<ListResponse | ErrorResponse> | ListResponse | ErrorResponse;
	(request: StopRequest): Promise<StopResponse | ErrorResponse> | StopResponse | ErrorResponse;
	(request: StatusRequest): Promise<StatusResponse | ErrorResponse> | StatusResponse | ErrorResponse;
	(request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse> | RpcBridgeResponse | ErrorResponse;
	(request: RpcStreamRequest): Promise<RpcReadyResponse | ErrorResponse> | RpcReadyResponse | ErrorResponse;
	(request: ServerRequest): Promise<ServerResponse> | ServerResponse;
	openViewStream?: ServerSupervisor["openViewStream"];
	openRpcStream(
		instanceId: string,
		onResponse: (response: RpcResponse) => void,
		onSessionEvent: (event: JsonAgentSessionEvent) => void,
		onUiRequest: (request: RpcExtensionUIRequest) => void,
	): { handleRequest(request: RpcCommand | RpcExtensionUIResponse): Promise<void>; close(): void } | undefined;
}
function withDaemonMeta<T extends ServerResponse>(response: T): T {
	return { ...response, version: VERSION, buildId: BUILD_ID, viewProtocol: VIEW_PROTOCOL_VERSION };
}
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export async function startIpcServer(handler: IpcRequestHandler): Promise<Server> {
	const socketPath = getSocketPath();
	await removeStaleSocketIfNeeded(socketPath);
	const server = createServer((socket) => {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let mode: "initial" | "pending" | "stream" | "done" = "initial";
		let detach: (() => void) | undefined;
		let dispatch: (message: RpcCommand | RpcExtensionUIResponse | ViewAnswerRequest) => void = () => {};
		const closeStream = () => {
			const close = detach;
			detach = undefined;
			close?.();
		};
		const abort = (error: Error) => {
			mode = "done";
			buffer = "";
			closeStream();
			socket.destroy(error);
		};
		const safeWrite = (message: ProtocolMessage): boolean => {
			if (socket.destroyed) return false;
			try {
				const bytes = encodeMessage(message);
				if (
					Buffer.byteLength(bytes) > MAX_FRAME_BYTES ||
					socket.writableLength + Buffer.byteLength(bytes) > MAX_FRAME_BYTES
				) {
					abort(new Error("Session viewer exceeds 16 MiB buffer limit"));
					return false;
				}
				socket.write(bytes);
				return true;
			} catch (error) {
				abort(error instanceof Error ? error : new Error(String(error)));
				return false;
			}
		};
		const fail = (error: unknown) => {
			if (mode === "done") return;
			const response: ErrorResponse = {
				type: "error",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
			safeWrite(withDaemonMeta(response));
			mode = "done";
			closeStream();
			socket.end();
		};
		const pump = () => {
			try {
				while (mode !== "pending" && mode !== "done") {
					const nl = buffer.indexOf("\n");
					if (nl === -1) break;
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Session viewer frame exceeds 16 MiB");
					if (!line.trim()) continue;
					if (mode === "initial") {
						mode = "pending";
						void initialize(parseRequestLine(line));
					} else {
						const message = JSON.parse(line);
						if (!message || typeof message.type !== "string") throw new Error("Malformed stream command");
						dispatch(message);
					}
				}
				if (mode !== "done" && Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
					throw new Error("Session viewer frame exceeds 16 MiB");
			} catch (error) {
				fail(error);
			}
		};
		async function initialize(request: ServerRequest) {
			try {
				if (request.type === "view_stream") {
					if (request.viewProtocol !== VIEW_PROTOCOL_VERSION) throw new Error("Unsupported session view protocol");
					let opened = false;
					let queuedBytes = 0;
					const queued: ProtocolMessage[] = [];
					const receive = (message: ProtocolMessage) => {
						if (opened) {
							safeWrite(message);
							return;
						}
						queuedBytes += Buffer.byteLength(encodeMessage(message));
						if (queuedBytes > MAX_FRAME_BYTES) {
							abort(new Error("Session view attach buffer exceeds 16 MiB"));
							return;
						}
						queued.push(message);
					};
					const handle = handler.openViewStream?.(request.instanceId, receive);
					if (!handle) throw new Error(`Instance is unavailable for attachment: ${request.instanceId}`);
					if (socket.destroyed) {
						handle.close();
						return;
					}
					detach = () => handle.close();
					if (!safeWrite(withDaemonMeta(handle.ready))) return;
					opened = true;
					for (const record of queued) if (!safeWrite(record)) return;
					dispatch = (message) => {
						if (message.type === "view_answer") {
							if (typeof message.id !== "string" || message.response?.type !== "extension_ui_response")
								throw new Error("Malformed dialog answer");
							const ok = handle.handleUiResponse(message.response);
							safeWrite({ type: "view_answer_result", id: message.id, ok });
							return;
						}
						if (message.type === "extension_ui_response") {
							handle.handleUiResponse(message);
							return;
						}
						void handle.handleRpc(message).then(
							(response) => safeWrite(response),
							(error) =>
								safeWrite({
									type: "response",
									id: message.id,
									command: message.type,
									success: false,
									error: error instanceof Error ? error.message : String(error),
								} as RpcResponse),
						);
					};
					mode = "stream";
					pump();
					return;
				}
				const response = await handler(request);
				if (socket.destroyed) return;
				if (request.type !== "rpc_stream" || !response.ok || response.type !== "rpc_ready" || !response.instance) {
					safeWrite(withDaemonMeta(response));
					mode = "done";
					socket.end();
					return;
				}
				let opened = false;
				let queuedBytes = 0;
				const queued: ProtocolMessage[] = [];
				const receive = (message: ProtocolMessage) => {
					if (opened) {
						safeWrite(message);
						return;
					}
					queuedBytes += Buffer.byteLength(encodeMessage(message));
					if (queuedBytes > MAX_FRAME_BYTES) {
						abort(new Error("RPC attach buffer exceeds 16 MiB"));
						return;
					}
					queued.push(message);
				};
				const handle = handler.openRpcStream(request.instanceId, receive, receive, receive);
				if (!handle) throw new Error(`Unknown instance: ${request.instanceId}`);
				if (socket.destroyed) {
					handle.close();
					return;
				}
				detach = () => handle.close();
				if (!safeWrite(withDaemonMeta(response))) return;
				opened = true;
				for (const record of queued) if (!safeWrite(record)) return;
				dispatch = (message) => {
					if (message.type === "view_answer") throw new Error("view_answer requires view_stream");
					void handle.handleRequest(message).catch((error) =>
						safeWrite({
							type: "error",
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				};
				mode = "stream";
				pump();
			} catch (error) {
				fail(error);
			}
		}
		socket.on("data", (chunk) => {
			if (mode === "done") return;
			buffer += decoder.write(chunk);
			pump();
		});
		socket.once("error", () => {
			mode = "done";
			closeStream();
		});
		socket.once("close", () => {
			mode = "done";
			closeStream();
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
	if (!existsSync(socketPath)) return;
	if (await isSocketLive(socketPath)) throw new Error(`server is already running: ${socketPath}`);
	unlinkSync(socketPath);
}
async function isSocketLive(socketPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (result: boolean) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};
		socket.on("connect", () => finish(true));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (["ECONNREFUSED", "ENOENT", "EPIPE", "ECONNRESET"].includes(error.code ?? "")) {
				finish(false);
				return;
			}
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			reject(error);
		});
	});
}
