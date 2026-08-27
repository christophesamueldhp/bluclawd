import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { isBunBinary } from "./config.ts";

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

/** How long a SIGTERM'd child is given to exit before we escalate to SIGKILL, so a child stuck
 *  in a tool can never hang stopInstance()/shutdown() indefinitely. */
const DISPOSE_KILL_TIMEOUT_MS = 5000;

/** Keep only the tail of the child's stderr — it is echoed into every error string and would
 *  otherwise grow without bound for a chatty long-lived child. */
const MAX_STDERR_BUFFER = 64 * 1024;

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Build the shared arg tail for an RPC child: resume an existing session and/or pin its model.
 *  `main()` parses `--session <path>` and `--provider <name> --model <pattern>` before the mode
 *  branch, so a pinned model wins over the weak settings default a fresh child would otherwise pick. */
export function buildRpcTailArgs(opts: { sessionFile?: string; provider?: string; model?: string }): string[] {
	const args: string[] = [];
	if (opts.sessionFile) args.push("--session", opts.sessionFile);
	if (opts.provider) args.push("--provider", opts.provider);
	if (opts.model) args.push("--model", opts.model);
	return args;
}

export class RpcProcessInstance {
	readonly process: ChildProcess;

	private exited = false;
	private nextRequestId = 0;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	constructor(options: {
		cwd: string;
		env?: NodeJS.ProcessEnv;
		sessionFile?: string;
		provider?: string;
		model?: string;
	}) {
		const rpcCommand = this.getSpawnCommand(options);
		this.process = spawn(rpcCommand.command, rpcCommand.args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!this.process.stdin || !this.process.stdout) {
			throw new Error("Failed to create RPC process stdio");
		}
		this.attachListeners();
	}

	private getSpawnCommand(opts: { sessionFile?: string; provider?: string; model?: string }): {
		command: string;
		args: string[];
	} {
		// Resume an existing session and/or pin the model; `main()` parses these before the mode
		// branch, and the node rpc-entry forwards process.argv through to main().
		const tail = buildRpcTailArgs(opts);
		if (isBunBinary) {
			return {
				command: join(dirname(process.execPath), process.platform === "win32" ? "pi.exe" : "pi"),
				args: ["--mode", "rpc", ...tail],
			};
		}
		return {
			command: process.execPath,
			// import.meta.resolve honors the package's "import" export condition; require.resolve
			// does not, and @earendil-works/pi-coding-agent exports ./rpc-entry as import-only.
			args: [fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")), ...tail],
		};
	}

	private attachListeners(): void {
		this.process.stdout?.setEncoding("utf8");
		this.process.stdout?.on("data", (chunk: string) => {
			this.stdoutBuffer += chunk;
			while (true) {
				const newlineIndex = this.stdoutBuffer.indexOf("\n");
				if (newlineIndex === -1) {
					break;
				}
				const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
				this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
				if (!line) {
					continue;
				}
				this.handleLine(line);
			}
		});

		this.process.stderr?.setEncoding("utf8");
		this.process.stderr?.on("data", (chunk: string) => {
			this.stderrBuffer += chunk;
			if (this.stderrBuffer.length > MAX_STDERR_BUFFER) {
				this.stderrBuffer = this.stderrBuffer.slice(-MAX_STDERR_BUFFER);
			}
		});

		this.process.once("error", (error) => {
			this.exited = true;
			const wrapped = new Error(`RPC process error: ${error.message}. Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(wrapped);
			this.notifyExit(wrapped);
		});

		this.process.once("exit", (code, signal) => {
			this.exited = true;
			const error = new Error(`RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(error);
			this.notifyExit(error);
		});
	}

	private handleLine(line: string): void {
		// This runs synchronously inside the child's stdout `data` handler. A child that writes a
		// single non-JSON line (a stray log/progress line, a partial write) must NOT throw out of
		// here — an uncaught throw reaches serve.ts's uncaughtException handler and takes the WHOLE
		// daemon (every session) down. Drop the bad line instead.
		let parsed: { type?: string; id?: string };
		try {
			parsed = JSON.parse(line) as { type?: string; id?: string };
		} catch {
			return;
		}
		switch (parsed.type) {
			case "response": {
				if (!parsed.id) {
					return;
				}
				const pending = this.pendingRequests.get(parsed.id);
				if (!pending) {
					return;
				}
				this.pendingRequests.delete(parsed.id);
				pending.resolve(parsed as RpcResponse);
				return;
			}

			case "extension_ui_request": {
				this.uiRequestHandler?.(parsed as RpcExtensionUIRequest);
				return;
			}

			default: {
				for (const listener of this.eventListeners) {
					listener(parsed as AgentSessionEvent);
				}
			}
		}
	}

	private rejectAllPending(error: Error): void {
		for (const [id, pending] of this.pendingRequests) {
			this.pendingRequests.delete(id);
			pending.reject(error);
		}
	}

	private notifyExit(error?: Error): void {
		for (const listener of this.exitListeners) {
			listener(error);
		}
	}

	send(command: RpcCommand): Promise<RpcResponse> {
		if (this.exited) {
			// Reject rather than throw synchronously so callers using `.then()` (not just `await`)
			// see a normal rejected promise instead of an exception at the call site.
			return Promise.reject(new Error(`RPC process is not running. Stderr: ${this.stderrBuffer}`));
		}
		const id = command.id ?? `server_${++this.nextRequestId}_${randomUUID()}`;
		const fullCommand = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.process.stdin?.write(`${JSON.stringify(fullCommand)}\n`, (error) => {
				if (!error) {
					return;
				}
				this.pendingRequests.delete(id);
				reject(toError(error));
			});
		});
	}

	handleUiResponse(response: RpcExtensionUIResponse): void {
		if (this.exited) {
			return;
		}
		this.process.stdin?.write(`${JSON.stringify(response)}\n`);
	}

	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void {
		this.uiRequestHandler = handler;
	}

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onExit(listener: (error?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	async dispose(): Promise<void> {
		this.uiRequestHandler = undefined;
		this.rejectAllPending(new Error("RPC process disposed"));
		if (this.exited) {
			return;
		}
		this.process.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			// Escalate to SIGKILL if the child ignores SIGTERM, so a wedged child can't hang
			// stopInstance()/supervisor.shutdown() (and therefore daemon exit) forever.
			const timer = setTimeout(() => {
				this.process.kill("SIGKILL");
				finish();
			}, DISPOSE_KILL_TIMEOUT_MS);
			this.process.once("exit", finish);
		});
	}
}

export function createRpcProcessInstance(options: {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	sessionFile?: string;
	provider?: string;
	model?: string;
}): RpcProcessInstance {
	return new RpcProcessInstance(options);
}
