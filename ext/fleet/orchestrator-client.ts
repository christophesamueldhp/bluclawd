import { spawn } from "node:child_process";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentActivity, InstanceStatus } from "./fleet-status.ts";

export interface InstanceSummary {
	id: string;
	status: InstanceStatus;
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	createdAt?: string;
	lastSeenAt?: string;
	activity?: AgentActivity;
	external?: boolean;
}

export interface RegisterInput {
	id: string;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	label?: string;
	activity?: AgentActivity;
}

type Request =
	| { type: "list" }
	| { type: "spawn"; cwd: string; label?: string; sessionFile?: string; provider?: string; model?: string }
	| { type: "stop"; instanceId: string }
	| { type: "rpc"; instanceId: string; command: unknown }
	| { type: "register"; instance: RegisterInput }
	| { type: "unregister"; instanceId: string };

interface AnyResponse {
	type: string;
	ok?: boolean;
	error?: string;
	instances?: InstanceSummary[];
	instance?: InstanceSummary;
	version?: string;
	buildId?: string;
}

/**
 * Mirror of packages/server/src/config.ts getSocketPath() so the client and daemon agree.
 *
 * Upstream v0.82.0 renamed the daemon package orchestrator → server, and with it the
 * env var, the directory and the socket filename. This mirror has to move in lockstep
 * or FleetView silently fails to find a running daemon.
 */
export function orchestratorSocketPath(): string {
	const envDir = process.env.PI_SERVER_DIR;
	const dir = envDir ?? join(process.env.PI_CONFIG_DIR ?? join(homedir(), ".pi"), "server");
	return join(dir, "server.sock");
}

/**
 * Path to the daemon's CLI entry, for the ensureDaemon() auto-start.
 *
 * Exported (and asserted in tests) for the same reason as orchestratorSocketPath: the
 * v0.82.0 orchestrator → server rename left this resolving the old package name, which
 * threw ERR_MODULE_NOT_FOUND into ensureDaemon's catch and silently disabled auto-start.
 */
export function daemonCliPath(): string {
	const indexJs = fileURLToPath(import.meta.resolve("@earendil-works/pi-server"));
	return join(dirname(indexJs), "cli.js");
}

/**
 * Newest mtime (ms) of any file under `dir`, recursive. Mirrors
 * packages/server/src/config.ts's own `newestMtimeMs` — duplicated for the same reason
 * orchestratorSocketPath() mirrors getSocketPath() above: different npm packages, no
 * shared module to import from. Exported so scripts/check-mirror-drift.mjs can invoke
 * it directly rather than compare it by AST, the same way it treats orchestratorSocketPath.
 */
export function newestMtimeMs(dir: string, depth = 0): number {
	if (depth > 4) return 0;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let newest = 0;
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			newest = Math.max(newest, newestMtimeMs(full, depth + 1));
		} else if (entry.isFile()) {
			try {
				newest = Math.max(newest, statSync(full).mtimeMs);
			} catch {
				// racing delete — skip
			}
		}
	}
	return newest;
}

/**
 * The build identifier a FRESHLY spawned daemon would report right now, computed from the
 * currently-installed @earendil-works/pi-server package's dist/ — not from any running
 * daemon. Compared against a running daemon's own self-reported `buildId` (see
 * getDaemonInfo()) to detect "the daemon process predates the code that is on disk now",
 * the classic stale-dist failure a semver comparison alone would miss, since a local
 * rebuild during development does not bump package.json's version
 * (IMPROVEMENT-PLAN.md §4.5/§5.3).
 */
export function currentDaemonBuildId(): string {
	let cliPath: string;
	try {
		cliPath = daemonCliPath();
	} catch {
		return "unknown"; // package not resolvable — same "can't tell" outcome as a stat failure
	}
	const newest = newestMtimeMs(dirname(cliPath));
	return newest > 0 ? new Date(newest).toISOString() : "unknown";
}

export class OrchestratorClient {
	private readonly socketPath: string;

	constructor(socketPath: string = orchestratorSocketPath()) {
		this.socketPath = socketPath;
	}

	private request(req: Request, timeoutMs = 2000): Promise<AnyResponse> {
		return new Promise<AnyResponse>((resolve, reject) => {
			const socket = createConnection(this.socketPath);
			let buffer = "";
			let settled = false;
			const done = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.removeAllListeners();
				socket.end();
				fn();
			};
			const timer = setTimeout(() => done(() => reject(new Error("orchestrator request timed out"))), timeoutMs);
			socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
			socket.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const nl = buffer.indexOf("\n");
				if (nl === -1) return;
				const line = buffer.slice(0, nl).trim();
				if (!line) return;
				try {
					const parsed = JSON.parse(line) as AnyResponse;
					// The protocol populates ok/error on every response (ipc/protocol.ts's
					// ResponseBase), but every call site used to await this promise and use the
					// payload without ever looking at `ok` — so a daemon-side rejection (e.g. an
					// unknown instance id) resolved exactly like success (IMPROVEMENT-PLAN.md
					// §5.1d). Reject centrally, once, instead of repeating the check in every
					// method below.
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

	/** Probe the daemon and, if reachable, read back its self-reported version/buildId
	 *  (IMPROVEMENT-PLAN.md §4.5/§5.3). `buildId` is undefined for a daemon that predates
	 *  the version-echo handshake — a distinct case from "not running" for a caller that
	 *  wants to warn about a stale daemon rather than treat it as absent. */
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

	async stop(instanceId: string): Promise<void> {
		await this.request({ type: "stop", instanceId });
	}

	/** Send a follow-up message to a running session (reply without jumping into it). */
	async reply(instanceId: string, message: string): Promise<void> {
		await this.request({ type: "rpc", instanceId, command: { type: "follow_up", message } });
	}

	/** Register/heartbeat this foreground session as an external instance. */
	async register(instance: RegisterInput): Promise<void> {
		await this.request({ type: "register", instance }, 1000);
	}

	async unregister(instanceId: string): Promise<void> {
		await this.request({ type: "unregister", instanceId }, 1000);
	}

	/**
	 * Spawn a background session and (optionally) match a model + seed an initial prompt.
	 * Pass `sessionFile` to RESUME an existing session (continue its history) instead of a fresh one.
	 */
	async spawn(opts: {
		cwd: string;
		label?: string;
		prompt?: string;
		model?: { provider: string; id: string };
		sessionFile?: string;
	}): Promise<InstanceSummary | undefined> {
		// Pin the model at child startup (daemon-side --provider/--model) instead of a post-spawn
		// set_model RPC — set_model silently no-ops when the model isn't yet in the child's registry,
		// which is exactly when a fresh child would otherwise stay on the weak settings default.
		const res = await this.request({
			type: "spawn",
			cwd: opts.cwd,
			label: opts.label,
			sessionFile: opts.sessionFile,
			provider: opts.model?.provider,
			model: opts.model?.id,
		});
		const instance = res.instance;
		if (!instance) return instance;
		if (opts.prompt) {
			await this.request({
				type: "rpc",
				instanceId: instance.id,
				command: { type: "prompt", message: opts.prompt },
			}).catch(() => undefined);
		}
		return instance;
	}

	/** Best-effort: if the daemon is down, launch `server serve` detached (dev/monorepo only). */
	async ensureDaemon(): Promise<boolean> {
		if (await this.isRunning()) return true;
		try {
			spawn(process.execPath, [daemonCliPath(), "serve"], { detached: true, stdio: "ignore" }).unref();
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
