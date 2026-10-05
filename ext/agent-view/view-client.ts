import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { getSocketPath } from "../../daemon/paths.ts";
import { VIEW_PROTOCOL_VERSION, type ViewEvent, type ViewReady, type ViewTerminal } from "../../daemon/view-types.ts";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
interface Pending {
	kind: "rpc" | "answer";
	resolve: (record: RpcResponse | boolean) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}
export interface SessionViewHandle {
	ready: ViewReady;
	send(command: RpcCommand): Promise<RpcResponse>;
	answer(response: RpcExtensionUIResponse): Promise<boolean>;
	close(): void;
}
export class SessionViewClient {
	private readonly socketPath: string;
	constructor(socketPath = getSocketPath()) {
		this.socketPath = socketPath;
	}
	open(
		instanceId: string,
		options: {
			signal?: AbortSignal;
			onRecord: (record: ViewEvent | ViewTerminal) => void;
			onDisconnect: (error?: Error) => void;
		},
	): Promise<SessionViewHandle> {
		if (options.signal?.aborted) return Promise.reject(new Error("Session view aborted"));
		return new Promise((resolve, reject) => {
			const socket = createConnection(this.socketPath);
			const decoder = new StringDecoder("utf8");
			const pending = new Map<string, Pending>();
			const prefix = randomUUID();
			let counter = 0;
			let buffer = "";
			let closed = false;
			let ready: ViewReady | undefined;
			const finish = (error: Error, intentional = false) => {
				if (closed) return;
				closed = true;
				clearTimeout(handshake);
				options.signal?.removeEventListener("abort", abort);
				buffer = "";
				for (const item of pending.values()) {
					clearTimeout(item.timer);
					item.reject(error);
				}
				pending.clear();
				socket.destroy();
				if (!ready) reject(error);
				else if (!intentional) {
					try {
						options.onDisconnect(error);
					} catch (e) {
						console.error(e);
					}
				}
			};
			const abort = () => finish(new Error("Session view aborted"));
			const handshake = setTimeout(() => finish(new Error("Session view handshake timed out")), 10_000);
			function request<T extends RpcResponse | boolean>(
				kind: "rpc" | "answer",
				payload: Record<string, unknown>,
			): Promise<T> {
				if (closed) return Promise.reject(new Error("Session view closed"));
				const id = prefix + ":" + ++counter;
				return new Promise<T>((resolveRequest, rejectRequest) => {
					const timer = setTimeout(
						() =>
							finish(
								new Error("Session view command acknowledgement timed out; submission may have been accepted"),
							),
						30_000,
					);
					pending.set(id, { kind, resolve: (value) => resolveRequest(value as T), reject: rejectRequest, timer });
					try {
						const bytes = JSON.stringify({ ...payload, id }) + "\n";
						if (Buffer.byteLength(bytes) > MAX_FRAME_BYTES) throw new Error("Session view frame exceeds 16 MiB");
						if (socket.writableLength + Buffer.byteLength(bytes) > MAX_FRAME_BYTES)
							throw new Error("Session view outgoing queue exceeds 16 MiB");
						socket.write(bytes);
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				});
			}
			options.signal?.addEventListener("abort", abort, { once: true });
			socket.once("connect", () =>
				socket.write(
					JSON.stringify({ type: "view_stream", instanceId, viewProtocol: VIEW_PROTOCOL_VERSION }) + "\n",
				),
			);
			socket.on("data", (chunk) => {
				buffer += decoder.write(chunk);
				try {
					let newline: number;
					while (!closed && (newline = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, newline);
						buffer = buffer.slice(newline + 1);
						if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("Session view frame exceeds 16 MiB");
						if (!line.trim()) continue;
						const record = JSON.parse(line);
						if (!record || typeof record.type !== "string") throw new Error("Malformed session view record");
						if (record.type === "error") throw new Error(record.error ?? "Session view failed");
						if (!ready) {
							if (
								record.type !== "view_ready" ||
								record.ok !== true ||
								record.viewProtocol !== VIEW_PROTOCOL_VERSION ||
								record.instance?.id !== instanceId ||
								typeof record.generation !== "string" ||
								!Number.isSafeInteger(record.sequence) ||
								!Array.isArray(record.projection?.messages) ||
								!record.state
							)
								throw new Error("Unsupported or malformed session view handshake");
							ready = record as ViewReady;
							clearTimeout(handshake);
							resolve({
								ready,
								send: (command) => request<RpcResponse>("rpc", { ...command }),
								answer: (response) => request<boolean>("answer", { type: "view_answer", response }),
								close: () => finish(new Error("Session view closed"), true),
							});
							continue;
						}
						if (record.type === "response" || record.type === "view_answer_result") {
							const item = pending.get(record.id);
							if (!item) continue;
							if (
								(item.kind === "rpc" && record.type !== "response") ||
								(item.kind === "answer" && record.type !== "view_answer_result")
							)
								throw new Error("Malformed session view acknowledgement");
							pending.delete(record.id);
							clearTimeout(item.timer);
							item.resolve(item.kind === "rpc" ? record : record.ok === true);
							continue;
						}
						if (
							(record.type !== "view_event" && record.type !== "view_terminal") ||
							typeof record.generation !== "string" ||
							!Number.isSafeInteger(record.sequence)
						)
							throw new Error("Malformed session view event");
						if (record.type === "view_event" && (!record.event || typeof record.event.type !== "string"))
							throw new Error("Malformed session view event payload");
						if (
							record.type === "view_terminal" &&
							(!["stopped", "deleted", "failed"].includes(record.reason) || record.instanceId !== instanceId)
						)
							throw new Error("Malformed session view terminal state");
						options.onRecord(record);
					}
					if (!closed && Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
						throw new Error("Session view frame exceeds 16 MiB");
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			});
			socket.on("error", (error) => finish(error));
			socket.once("end", () => finish(new Error("Session view socket closed")));
			socket.once("close", () => {
				finish(new Error("Session view socket closed"));
				socket.removeAllListeners();
			});
		});
	}
}
