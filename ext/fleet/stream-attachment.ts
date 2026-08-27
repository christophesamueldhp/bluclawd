import { createConnection, type Socket } from "node:net";
import { orchestratorSocketPath } from "./orchestrator-client.ts";

function encodeMessage(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

export interface StreamMessage {
	type: string;
	[key: string]: unknown;
}

export interface StreamAttachmentOptions {
	onReady?: (message: StreamMessage) => void;
	onEvent?: (event: StreamMessage) => void;
	onResponse?: (response: StreamMessage) => void;
	onUiRequest?: (request: StreamMessage) => void;
	onError?: (error: string) => void;
	/** `everReady` is false when the stream closed WITHOUT ever getting a working session — a
	 *  socket that was never reachable, or a connection that hung past the ready timeout — as
	 *  opposed to a session that was live and then genuinely ended (IMPROVEMENT-PLAN.md §5.1e). */
	onClosed?: (everReady: boolean) => void;
}

/**
 * Persistent bidirectional rpc_stream client: attaches to a running daemon child, receives its
 * AgentSessionEvents (+ responses / ui requests), and sends RpcCommands back. Read-only viewing
 * needs no daemon changes (events fan out to all subscribers).
 */
export class StreamAttachment {
	private readonly instanceId: string;
	private readonly opts: StreamAttachmentOptions;
	private readonly socketPath: string;
	private readonly readyTimeoutMs: number;
	private socket: Socket | undefined;
	private buffer = "";
	private closed = false;
	/** True once an `rpc_ready` message actually arrives — the signal that this attachment ever
	 *  had a working session, not just an open TCP/unix connection (IMPROVEMENT-PLAN.md §5.1e). */
	private everReady = false;
	private readyTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		instanceId: string,
		opts: StreamAttachmentOptions,
		socketPath: string = orchestratorSocketPath(),
		readyTimeoutMs = 5000,
	) {
		this.instanceId = instanceId;
		this.opts = opts;
		this.socketPath = socketPath;
		this.readyTimeoutMs = readyTimeoutMs;
	}

	connect(): void {
		const socket = createConnection(this.socketPath);
		this.socket = socket;
		socket.on("connect", () => socket.write(encodeMessage({ type: "rpc_stream", instanceId: this.instanceId })));
		socket.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
		socket.on("error", () => this.handleClosed());
		socket.on("end", () => this.handleClosed());
		socket.on("close", () => this.handleClosed());
		// connect() succeeding is not the same as the session responding — a daemon that never
		// sends rpc_ready (hung child, wrong instance id) used to leave the view on "(no messages
		// yet)" forever, indistinguishable from a genuinely idle session (§5.1f). Treat a timeout
		// the same way as a connection failure: close, with everReady staying false.
		this.readyTimer = setTimeout(() => this.handleClosed(), this.readyTimeoutMs);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const nl = this.buffer.indexOf("\n");
			if (nl === -1) break;
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			let message: StreamMessage;
			try {
				message = JSON.parse(line) as StreamMessage;
			} catch {
				continue;
			}
			this.dispatch(message);
		}
	}

	private dispatch(message: StreamMessage): void {
		switch (message.type) {
			case "rpc_ready":
				this.everReady = true;
				if (this.readyTimer) {
					clearTimeout(this.readyTimer);
					this.readyTimer = undefined;
				}
				this.opts.onReady?.(message);
				return;
			case "response":
				this.opts.onResponse?.(message);
				return;
			case "extension_ui_request":
				this.opts.onUiRequest?.(message);
				return;
			case "error":
				this.opts.onError?.(typeof message.error === "string" ? message.error : "stream error");
				return;
			default:
				this.opts.onEvent?.(message);
		}
	}

	send(command: unknown): void {
		if (this.closed || !this.socket) return;
		try {
			this.socket.write(encodeMessage(command));
		} catch {
			// socket died between attach and this write
			this.handleClosed();
		}
	}

	private handleClosed(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.readyTimer) {
			clearTimeout(this.readyTimer);
			this.readyTimer = undefined;
		}
		this.socket?.removeAllListeners();
		this.socket = undefined;
		this.opts.onClosed?.(this.everReady);
	}

	close(): void {
		this.closed = true;
		if (this.readyTimer) {
			clearTimeout(this.readyTimer);
			this.readyTimer = undefined;
		}
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.end();
			this.socket = undefined;
		}
	}
}
