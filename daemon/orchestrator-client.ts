import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentActivity } from "./activity.ts";
import type {
	EndReason,
	InstanceSummary,
	LiveSnapshot,
	PaneDialog,
	PaneLaunch,
	PaneMessage,
	PaneReport,
	RemoteResponse,
} from "./ipc/protocol.ts";
import { daemonBuildId, getSocketPath } from "./paths.ts";

export type { AgentActivity, EndReason };
export type { InstanceSummary };

export interface RegisterInput {
	id: string;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	label?: string;
	activity?: AgentActivity;
	pane?: string;
	detail?: string;
	turns?: number;
	createdAt?: string;
	finishedAt?: string;
	leafId?: string;
	dialog?: PaneDialog;
	draft?: boolean;
	launch?: PaneLaunch;
}

/** A RemoteResponse without its envelope. */
export type RemoteResult = Omit<RemoteResponse, "type" | "ok" | "version" | "buildId">;

export type RemoteAction =
	| { action: "status"; launch?: PaneLaunch }
	| { action: "off" | "pair" | "devices" }
	| { action: "on"; port?: number }
	| { action: "revoke"; deviceId: string };

type Request =
	| { type: "list" }
	| { type: "register"; instance: RegisterInput }
	| { type: "unregister"; instanceId: string; reason?: EndReason }
	| { type: "wait"; instanceId: string }
	| { type: "send"; instanceId: string; message: PaneMessage }
	| { type: "shutdown" }
	| { type: "delete"; instanceId: string }
	| { type: "rename"; instanceId: string; name: string }
	| { type: "meta"; instanceId: string; pinned?: boolean; sortOrder?: number }
	| { type: "save"; cwd: string; label?: string; sessionFile: string; sessionId?: string }
	| ({ type: "remote" } & RemoteAction)
	| { type: "remote_live"; instanceId: string; live: LiveSnapshot | null }
	| { type: "remote_report"; instanceId: string; report: PaneReport };

interface AnyResponse {
	type: string;
	ok?: boolean;
	error?: string;
	instances?: InstanceSummary[];
	instance?: InstanceSummary;
	version?: string;
	buildId?: string;
	messages?: PaneMessage[];
	watched?: boolean;
	wantReport?: boolean;
	queued?: boolean;
	superseded?: boolean;
}

/** Path to the daemon's CLI entry, for the ensureDaemon() auto-start. */
function daemonCliPath(): string {
	// This package ships its own daemon (daemon/cli.ts, run by node's native type stripping);
	// `@earendil-works/pi-server` is not a dependency here.
	return join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
}

/**
 * The package directory of the pi that is running this extension, found by walking up from
 * the entry script (`.../pi-coding-agent/dist/bundle/cli.js` for a global install). Handed to
 * the daemon as PI_PACKAGE_ROOT so daemon/pi-resolve-hook.mjs can resolve `@earendil-works/*`
 * from there: pi aliases those imports for extensions, but the installed package has none of
 * them in its own node_modules, and the daemon is a separate node process. Undefined when the
 * entry script is not inside pi (e.g. bin.mjs in a dev checkout, which resolves them itself).
 */
export function piPackageRoot(entry: string | undefined = process.argv[1]): string | undefined {
	if (!entry) return undefined;
	// argv[1] is the bin symlink as invoked (`/opt/homebrew/bin/pi`), not the script it points to.
	let dir: string;
	try {
		dir = dirname(realpathSync(entry));
	} catch {
		return undefined;
	}
	for (let i = 0; i < 8; i++) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
			if (pkg.name === "@earendil-works/pi-coding-agent") return dir;
		} catch {
			// no package.json here — keep walking
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * The build id a freshly spawned daemon would report now, from this package's daemon/ directory.
 * Compared with a running daemon's self-reported `buildId` to catch a daemon older than the code
 * on disk — a local rebuild does not bump the version, so semver alone would miss it.
 */
export function currentDaemonBuildId(): string {
	let cliPath: string;
	try {
		cliPath = daemonCliPath();
	} catch {
		return "unknown"; // package not resolvable — same "can't tell" outcome as a stat failure
	}
	return daemonBuildId(dirname(cliPath), piPackageRoot() ?? process.env.PI_PACKAGE_ROOT);
}

/** How pi starts the daemon, on top of its own environment; the login item runs the same
 *  (ext/remote/autostart.ts). */
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

	private request(req: Request, timeoutMs = 2000, signal?: AbortSignal): Promise<AnyResponse> {
		return new Promise<AnyResponse>((resolve, reject) => {
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
			// Only a wait has a signal: held open for long, it must not keep pi alive, and stop() ends it.
			if (signal) {
				socket.unref();
				timer.unref();
				signal.addEventListener("abort", abort, { once: true });
			}
			socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
			socket.on("data", (chunk: Buffer) => {
				// Decoded whole: a reply with a phone's images comes in many reads, which can split a character.
				chunks.push(chunk);
				if (!chunk.includes(0x0a)) return;
				const buffer = Buffer.concat(chunks).toString();
				const nl = buffer.indexOf("\n");
				const line = buffer.slice(0, nl).trim();
				if (!line) return;
				try {
					const parsed = JSON.parse(line) as AnyResponse;
					// Every response carries ok/error; reject here so a daemon-side rejection
					// (e.g. an unknown instance id) does not resolve like success.
					if (parsed.ok === false) {
						done(() => reject(new Error(parsed.error ?? `orchestrator request failed: ${req.type}`)));
						return;
					}
					done(() => resolve(parsed));
				} catch (error) {
					done(() => reject(error instanceof Error ? error : new Error(String(error))));
				}
			});
			socket.on("error", (error) => done(() => reject(error)));
			socket.on("end", () => done(() => reject(new Error("orchestrator socket closed before a response"))));
		});
	}

	async isRunning(): Promise<boolean> {
		return (await this.getDaemonInfo()).running;
	}

	/** Probe the daemon and, if reachable, read back its self-reported version/buildId.
	 *  `buildId` is undefined for a daemon that predates the version-echo handshake — a distinct
	 *  case from "not running" for a caller that wants to warn about a stale daemon. */
	async getDaemonInfo(): Promise<{ running: boolean; version?: string; buildId?: string }> {
		try {
			const res = await this.request({ type: "list" }, 500);
			return { running: true, version: res.version, buildId: res.buildId };
		} catch {
			return { running: false };
		}
	}

	async list(): Promise<InstanceSummary[]> {
		const res = await this.request({ type: "list" });
		return res.instances ?? [];
	}

	/** List a session as a stopped row without starting it; it resumes when opened. */
	async save(session: { cwd: string; label?: string; sessionFile: string; sessionId?: string }): Promise<void> {
		const { cwd, label, sessionFile, sessionId } = session;
		await this.request({ type: "save", cwd, label, sessionFile, sessionId });
	}

	async delete(instanceId: string): Promise<void> {
		await this.request({ type: "delete", instanceId }, 10_000);
	}

	async rename(instanceId: string, name: string): Promise<void> {
		await this.request({ type: "rename", instanceId, name });
	}

	async setMeta(instanceId: string, meta: { pinned?: boolean; sortOrder?: number }): Promise<void> {
		await this.request({ type: "meta", instanceId, ...meta });
	}

	/** Register/heartbeat a pane's pi. Its timeout is long: the messages a response drains are lost
	 *  if the pane, busy for a moment, reads it too late. */
	async register(
		instance: RegisterInput,
	): Promise<{ messages: PaneMessage[]; watched: boolean; wantReport: boolean }> {
		const res = await this.request({ type: "register", instance }, 3000);
		return { messages: res.messages ?? [], watched: res.watched === true, wantReport: res.wantReport === true };
	}

	/**
	 * Held open until a message is queued for this pane (true) or the daemon's 25 s pass with none
	 * (false); undefined when a newer wait for the same id replaced it, or from a daemon that
	 * predates the request, which answers it with no type.
	 */
	async wait(instanceId: string, signal: AbortSignal): Promise<boolean | undefined> {
		const res = await this.request({ type: "wait", instanceId }, 30_000, signal);
		return res.type === "wait_result" && !res.superseded ? res.queued === true : undefined;
	}

	/** Queue a message for a pane's pi; it acts on it within a heartbeat. */
	async send(instanceId: string, message: PaneMessage): Promise<void> {
		const res = await this.request({ type: "send", instanceId, message });
		if (res.type !== "ack") throw new Error(res.error ?? "The agent daemon is out of date — restart pi to update it");
	}

	/** Remote control's switch, pairing codes and devices (daemon/remote/). */
	async remote(action: RemoteAction): Promise<RemoteResult> {
		const res = await this.request({ type: "remote", ...action }, 5000);
		if (res.type !== "remote_result") throw new Error("The agent daemon is out of date — restart pi to update it");
		return res as unknown as RemoteResult;
	}

	/** The reply this pane is streaming, for the phones watching it; null once it is finished. */
	async remoteLive(instanceId: string, live: LiveSnapshot | null): Promise<void> {
		await this.request({ type: "remote_live", instanceId, live }, 1000);
	}

	/** This pane's model, context and usage, for the phone's status sheet. */
	async remoteReport(instanceId: string, report: PaneReport): Promise<void> {
		await this.request({ type: "remote_report", instanceId, report }, 1000);
	}

	async unregister(instanceId: string, reason?: EndReason): Promise<void> {
		await this.request({ type: "unregister", instanceId, ...(reason ? { reason } : {}) }, 1000);
	}

	/**
	 * Ask the daemon to exit and wait until it is actually gone. `ok: false` carries the daemon's
	 * reason (an older daemon still running sessions of its own; or one that predates the verb).
	 */
	async shutdownDaemon(): Promise<{ ok: true } | { ok: false; reason: string }> {
		try {
			const res = await this.request({ type: "shutdown" }, 3000);
			// A daemon from before this verb answers an unknown request with no `type` at all —
			// waiting for it to exit would only time out.
			if (res.type !== "shutdown_result") {
				return {
					ok: false,
					reason:
						"this daemon predates the shutdown request — kill the `daemon/cli.ts serve` process once, then reopen",
				};
			}
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		for (let i = 0; i < 25; i++) {
			if (!(await this.isRunning())) return { ok: true };
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return { ok: false, reason: "the old daemon did not exit" };
	}

	/** Replace a running (stale) daemon with a fresh one from the code on disk. */
	async restartDaemon(): Promise<{ restarted: boolean; reason?: string }> {
		const down = await this.shutdownDaemon();
		if (!down.ok) return { restarted: false, reason: down.reason };
		if (await this.ensureDaemon()) return { restarted: true };
		return { restarted: false, reason: "the new daemon did not start" };
	}

	/** Best-effort: if the daemon is down, launch `daemon/cli.ts serve` detached. */
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
