/** A viewer of an existing daemon worker. Closing the socket never stops that worker. */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { AssistantStream } from "../../daemon/assistant-stream.ts";

export interface Attachment {
	request(command: RpcCommand): Promise<RpcResponse>;
	answer(response: RpcExtensionUIResponse): void;
	close(): void;
}

export function attachRpc(
	socketPath: string,
	instanceId: string,
	onEvent: (event: AgentSessionEvent) => void,
	onUiRequest: (request: RpcExtensionUIRequest) => void,
	onDisconnect: (error: Error) => void,
): Promise<Attachment> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.setEncoding("utf8");
		let buffer = "";
		let ready = false;
		let closed = false;
		const assistantStream = new AssistantStream();
		const pending = new Map<
			string,
			{
				resolve: (response: RpcResponse) => void;
				reject: (error: Error) => void;
				timer: ReturnType<typeof setTimeout>;
			}
		>();
		const fail = (error: Error, intentional = false): void => {
			if (closed) return;
			closed = true;
			clearTimeout(handshakeTimer);
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(error);
			}
			pending.clear();
			socket.destroy();
			if (!ready) reject(error);
			else if (!intentional) onDisconnect(error);
		};
		const handshakeTimer = setTimeout(() => fail(new Error("Agent attachment timed out")), 5000);
		const write = (value: unknown): void => {
			if (closed) throw new Error("Agent attachment is closed");
			socket.write(`${JSON.stringify(value)}\n`);
		};
		const attachment: Attachment = {
			request(command) {
				return new Promise((resolveRequest, rejectRequest) => {
					if (closed) return rejectRequest(new Error("Agent attachment is closed"));
					const id = randomUUID();
					const timer = setTimeout(() => {
						pending.delete(id);
						rejectRequest(new Error(`Agent request timed out: ${command.type}`));
					}, 30_000);
					pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
					write({ ...command, id });
				});
			},
			answer: write,
			close: () => fail(new Error("Agent detached"), true),
		};
		socket.on("connect", () => write({ type: "rpc_stream", instanceId }));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				try {
					const message = JSON.parse(line);
					if (message.type === "rpc_ready") {
						if (message.ok === false) throw new Error(message.error ?? "Cannot attach to agent");
						ready = true;
						clearTimeout(handshakeTimer);
						resolve(attachment);
					} else if (message.type === "error") {
						throw new Error(message.error ?? "Agent attachment failed");
					} else if (message.type === "response") {
						const request = pending.get(message.id);
						if (!request) continue;
						clearTimeout(request.timer);
						pending.delete(message.id);
						if (message.success === false) request.reject(new Error(message.error));
						else request.resolve(message);
					} else if (message.type === "extension_ui_request") onUiRequest(message);
					else {
						const event = assistantStream.apply(message);
						if (event) onEvent(event);
					}
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
		socket.on("error", (error) => fail(error));
		socket.on("close", () => fail(new Error("Agent connection closed")));
	});
}
