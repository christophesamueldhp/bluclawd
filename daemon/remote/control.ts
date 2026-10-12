/**
 * Remote control's switch, owned by the daemon. The on/off state and the port live in
 * remote.json, so the listener comes back when the daemon restarts (e.g. for a changed build).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorResponse, InstanceSummary, PaneMessage, RemoteRequest, RemoteResponse } from "../ipc/protocol.ts";
import { type RemoteServer, startRemoteServer } from "./http.ts";
import { RemoteStore } from "./pairing.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

export interface RemoteControlDeps {
	listInstances(): InstanceSummary[];
	send(sessionId: string, message: PaneMessage): boolean;
	store?: RemoteStore;
	webDir?: string;
}

export class RemoteControl {
	readonly store: RemoteStore;
	private readonly deps: RemoteControlDeps;
	private server: RemoteServer | undefined;
	/** The configured port the running server was started for. */
	private serverPort: number | undefined;
	private listenError: string | undefined;
	/** Serialises apply and stop, so overlapping switches cannot start two servers. */
	private queue: Promise<void> = Promise.resolve();

	constructor(deps: RemoteControlDeps) {
		this.deps = deps;
		this.store = deps.store ?? new RemoteStore();
	}

	private run(step: () => Promise<void>): Promise<void> {
		const result = this.queue.then(step);
		this.queue = result.catch(() => undefined);
		return result;
	}

	/** Start or stop the listener to match remote.json. */
	apply(): Promise<void> {
		return this.run(() => this.applyNow());
	}

	private async applyNow(): Promise<void> {
		const state = this.store.load();
		if (this.server && (!state.enabled || this.serverPort !== state.port)) await this.stopNow();
		if (!state.enabled) {
			this.listenError = undefined;
			return;
		}
		if (this.server) return;
		try {
			this.server = await startRemoteServer(
				{
					store: this.store,
					listInstances: this.deps.listInstances,
					send: this.deps.send,
					webDir: this.deps.webDir ?? WEB_DIR,
				},
				state.port,
			);
			this.serverPort = state.port;
			this.listenError = undefined;
		} catch (error) {
			this.listenError = error instanceof Error ? error.message : String(error);
		}
	}

	stop(): Promise<void> {
		return this.run(() => this.stopNow());
	}

	private async stopNow(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.serverPort = undefined;
		await server?.close();
	}

	async handle(request: RemoteRequest): Promise<RemoteResponse | ErrorResponse> {
		switch (request.action) {
			case "on":
				this.store.setEnabled(true, request.port);
				await this.apply();
				return this.result(this.server ? this.store.createCode() : undefined);
			case "off":
				this.store.setEnabled(false);
				await this.apply();
				return this.result();
			case "pair":
				if (!this.server) {
					const why = this.listenError ? `: ${this.listenError}` : "";
					return { type: "error", ok: false, error: `remote control is not listening${why}` };
				}
				return this.result(this.store.createCode());
			case "revoke":
				if (!request.deviceId || !this.store.revoke(request.deviceId)) {
					return { type: "error", ok: false, error: `Unknown device: ${request.deviceId}` };
				}
				return this.result();
			default:
				return this.result();
		}
	}

	private result(code?: { code: string; expiresAt: number }): RemoteResponse {
		const state = this.store.load();
		return {
			type: "remote_result",
			ok: true,
			enabled: state.enabled,
			port: this.server?.port ?? state.port,
			listening: this.server !== undefined,
			...(this.listenError ? { listenError: this.listenError } : {}),
			...(code ?? {}),
			devices: state.devices.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
		};
	}
}
