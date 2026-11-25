import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentActivity } from "./activity.ts";
import type { Collaboration, CollaborationMember } from "./collaborations.ts";
import {
	type CollaborationRequest,
	type EndReason,
	HELD_REQUEST_TIMEOUT_MS,
	type InstanceSummary,
	type LiveSnapshot,
	type PaneLaunch,
	type PaneMessage,
	type PaneReport,
	RESPONSE_TYPE,
	type RegisterRequest,
	type RemoteResponse,
	type ResponseTo,
	type SaveRequest,
	type ServerRequest,
	type StartSpec,
} from "./ipc/protocol.ts";
import { daemonBuildId, getSocketPath } from "./paths.ts";
import type { RunHostLaunch, SlotClaim } from "./run-queue.ts";
import type { HeldWakeups } from "./wakeups.ts";

const OUT_OF_DATE = "The agent daemon is out of date — restart pi to update it";

export type { AgentActivity, EndReason };
export type { InstanceSummary };

export type RemoteResult = Omit<RemoteResponse, "type" | "ok" | "version" | "buildId">;

export type RemoteAction =
	| { action: "status"; launch?: PaneLaunch }
	| { action: "off" | "pair" | "devices" }
	| { action: "on"; port?: number }
	| { action: "revoke"; deviceId: string };

function daemonCliPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
}

export function piPackageRoot(entry: string | undefined = process.argv[1]): string | undefined {
	if (!entry) return undefined;
	let dir: string;
	try {
		dir = dirname(realpathSync(entry));
	} catch {
		return undefined;
	}
	for (let i = 0; i < 8; i++) {
		if (readPackageName(dir) === "@earendil-works/pi-coding-agent") return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function readPackageName(dir: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name;
	} catch {
		return undefined;
	}
}

const REGISTER_TIMEOUT_MS = 3000;

interface AskOptions {
	signal?: AbortSignal;
	background?: boolean;
}

function isPreClaimNowDaemon(error: unknown): boolean {
	return error instanceof Error && /was not granted a slot/.test(error.message);
}

export function currentDaemonBuildId(): string {
	let cliPath: string;
	try {
		cliPath = daemonCliPath();
	} catch {
		return "unknown";
	}
	return daemonBuildId(dirname(cliPath), piPackageRoot() ?? process.env.PI_PACKAGE_ROOT);
}

export function daemonCommand(): { command: string[]; env: Record<string, string> } {
	const cli = daemonCliPath();
	const hook = join(dirname(cli), "pi-resolve-hook.mjs");
	const root = piPackageRoot();
	return { command: [process.execPath, "--import", hook, cli, "serve"], env: root ? { PI_PACKAGE_ROOT: root } : {} };
}

export class OrchestratorClient {
	private readonly socketPath: string;

	constructor(socketPath: string = getSocketPath()) {
		this.socketPath = socketPath;
	}

	private askIfKnown<R extends ServerRequest>(
		req: R,
		timeoutMs = 2000,
		{ signal, background = false }: AskOptions = {},
	): Promise<ResponseTo<R> | undefined> {
		return new Promise<ResponseTo<R> | undefined>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("orchestrator request aborted"));
				return;
			}
			const socket = createConnection(this.socketPath);
			const chunks: Buffer[] = [];
			let settled = false;
			const abort = () => done(() => reject(new Error("orchestrator request aborted")));
			const done = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				socket.removeAllListeners();
				// A reset after we are done is harmless; with no listener it would throw.
				socket.on("error", () => {});
				socket.end();
				fn();
			};
			const timer = setTimeout(() => done(() => reject(new Error("orchestrator request timed out"))), timeoutMs);
			if (background) {
				socket.unref();
				timer.unref();
			}
			signal?.addEventListener("abort", abort, { once: true });
			socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
			socket.on("data", (chunk: Buffer) => {
				// Decoded whole, because a reply with a phone's images comes in many reads, which can split a character.
				chunks.push(chunk);
				if (!chunk.includes(0x0a)) return;
				const buffer = Buffer.concat(chunks).toString();
				const nl = buffer.indexOf("\n");
				const line = buffer.slice(0, nl).trim();
				if (!line) return;
				try {
					const parsed = JSON.parse(line) as { type?: string; ok?: boolean; error?: string };
					if (parsed.ok === false) {
						done(() => reject(new Error(parsed.error ?? `orchestrator request failed: ${req.type}`)));
						return;
					}
					done(() => resolve(parsed.type === RESPONSE_TYPE[req.type] ? (parsed as ResponseTo<R>) : undefined));
				} catch (error) {
					done(() => reject(error instanceof Error ? error : new Error(String(error))));
				}
			});
			socket.on("error", (error) => done(() => reject(error)));
			socket.on("end", () => done(() => reject(new Error("orchestrator socket closed before a response"))));
		});
	}

	async request<R extends ServerRequest>(req: R, timeoutMs?: number, options?: AskOptions): Promise<ResponseTo<R>> {
		const res = await this.askIfKnown(req, timeoutMs, options);
		if (!res) throw new Error(OUT_OF_DATE);
		return res;
	}

	async isRunning(): Promise<boolean> {
		return (await this.getDaemonInfo()).running;
	}

	async getDaemonInfo(): Promise<{ running: boolean; version?: string; buildId?: string; pid?: number }> {
		try {
			const res = await this.askIfKnown({ type: "list" }, 500);
			return { running: true, version: res?.version, buildId: res?.buildId, pid: res?.pid };
		} catch {
			return { running: false };
		}
	}

	async list(): Promise<InstanceSummary[]> {
		const res = await this.askIfKnown({ type: "list" });
		return res?.instances ?? [];
	}

	async save(session: Omit<SaveRequest, "type">): Promise<void> {
		const { cwd, label, sessionFile, sessionId, parent } = session;
		await this.askIfKnown({ type: "save", cwd, label, sessionFile, sessionId, parent });
	}

	async start(start: StartSpec): Promise<string> {
		const res = await this.request({ type: "start", ...start });
		if (!res.id) throw new Error(OUT_OF_DATE);
		return res.id;
	}

	async startFailed(instanceId: string): Promise<void> {
		await this.askIfKnown({ type: "start_failed", instanceId });
	}

	async delete(instanceId: string): Promise<void> {
		await this.askIfKnown({ type: "delete", instanceId }, 10_000);
	}

	async rename(instanceId: string, name: string): Promise<void> {
		await this.askIfKnown({ type: "rename", instanceId, name });
	}

	async setMeta(instanceId: string, meta: { pinned?: boolean; sortOrder?: number }): Promise<void> {
		await this.askIfKnown({ type: "meta", instanceId, ...meta });
	}

	async register(
		instance: RegisterRequest["instance"],
	): Promise<{ messages: PaneMessage[]; watched: boolean; wantReport: boolean }> {
		const res = await this.askIfKnown({ type: "register", instance }, REGISTER_TIMEOUT_MS);
		return { messages: res?.messages ?? [], watched: res?.watched === true, wantReport: res?.wantReport === true };
	}

	async wait(instanceId: string, signal: AbortSignal): Promise<boolean | undefined> {
		const res = await this.askIfKnown({ type: "wait", instanceId }, HELD_REQUEST_TIMEOUT_MS, {
			signal,
			background: true,
		});
		return res && !res.superseded ? res.queued === true : undefined;
	}

	async send(instanceId: string, message: PaneMessage): Promise<void> {
		await this.request({ type: "send", instanceId, message });
	}

	async remote(action: RemoteAction): Promise<RemoteResult> {
		return this.request({ type: "remote", ...action }, 5000);
	}

	async remoteLive(instanceId: string, live: LiveSnapshot | null, entryId?: string): Promise<void> {
		await this.askIfKnown({ type: "remote_live", instanceId, live, ...(entryId ? { entryId } : {}) }, 1000);
	}

	async remoteReport(instanceId: string, report: PaneReport): Promise<void> {
		await this.askIfKnown({ type: "remote_report", instanceId, report }, 1000);
	}

	async holdWakeups(held: HeldWakeups): Promise<void> {
		await this.askIfKnown({ type: "wakeups", held });
	}

	async claimRun(run: string, parent: string, signal: AbortSignal): Promise<boolean> {
		const res = await this.request({ type: "run_queue", action: "claim", run, parent }, HELD_REQUEST_TIMEOUT_MS, {
			signal,
			background: true,
		});
		return res.granted === true;
	}

	async claimRunNow(run: string, parent: string): Promise<SlotClaim> {
		const res = await this.request({ type: "run_queue", action: "claim_now", run, parent }).catch(
			(error: unknown) => {
				if (isPreClaimNowDaemon(error)) throw new Error(OUT_OF_DATE);
				throw error;
			},
		);
		if (res.active === undefined || res.capacity === undefined) throw new Error(OUT_OF_DATE);
		return {
			granted: res.granted === true,
			...(res.claimed ? { claimed: true as const } : {}),
			active: res.active,
			capacity: res.capacity,
		};
	}

	async launchRun(run: string, host: RunHostLaunch): Promise<number> {
		const res = await this.request({ type: "run_queue", action: "launch", run, host });
		if (res.hostPid === undefined) throw new Error(OUT_OF_DATE);
		return res.hostPid;
	}

	async takeRunEnv(pane: string): Promise<Record<string, string>> {
		const res = await this.request({ type: "run_queue", action: "take_env", pane });
		if (!res.env) throw new Error(OUT_OF_DATE);
		return res.env;
	}

	async releaseRun(run: string): Promise<void> {
		await this.askIfKnown({ type: "run_queue", action: "release", run });
	}

	async collaboration(
		request: CollaborationRequest extends infer R ? (R extends unknown ? Omit<R, "type"> : never) : never,
	): Promise<{ collaboration?: Collaboration; to?: CollaborationMember; current?: boolean }> {
		const res = await this.request({ type: "collaboration", ...request } as CollaborationRequest, 5000);
		return { collaboration: res.collaboration, to: res.to, current: res.current };
	}

	async unregister(instanceId: string, reason?: EndReason): Promise<void> {
		await this.askIfKnown({ type: "unregister", instanceId, ...(reason ? { reason } : {}) }, 1000);
	}

	async shutdownDaemon(): Promise<{ ok: true } | { ok: false; reason: string }> {
		let pid: number | undefined;
		try {
			const res = await this.askIfKnown({ type: "shutdown" }, 3000);
			if (!res) {
				return {
					ok: false,
					reason:
						"this daemon predates the shutdown request — kill the `daemon/cli.ts serve` process once, then reopen",
				};
			}
			pid = res.pid;
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		for (let i = 0; i < 25; i++) {
			const info = await this.getDaemonInfo();
			if (!info.running || info.pid !== pid) return { ok: true };
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return { ok: false, reason: "the old daemon did not exit" };
	}

	async restartDaemon(): Promise<{ restarted: boolean; reason?: string }> {
		const down = await this.shutdownDaemon();
		if (!down.ok) return { restarted: false, reason: down.reason };
		if (await this.ensureDaemon()) return { restarted: true };
		return { restarted: false, reason: "the new daemon did not start" };
	}

	async ensureDaemon(): Promise<boolean> {
		if (await this.isRunning()) return true;
		try {
			const { command, env } = daemonCommand();
			spawn(command[0], command.slice(1), {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, ...env },
			}).unref();
		} catch {
			return false;
		}
		for (let i = 0; i < 15; i++) {
			if (await this.isRunning()) return true;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return false;
	}
}
