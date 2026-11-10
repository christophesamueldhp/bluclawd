/**
 * The process that holds an RPC run's pi (ADR-0010). pi aborts its work once its stdin closes, so the pi's stdio
 * belongs to a detached host of its own, not to the orchestrator, whose pi may end first. The host starts the run's
 * pi, gives it its task, stores its Report once its work settles with nothing pending, then closes its stdin and
 * records how it exited. Everything between the orchestrator and the host goes through the run's directory: the
 * launch spec in, the host's state and the run's Reports out; a SIGTERM to the host stops the run.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piPackageRoot } from "../../daemon/orchestrator-client.ts";
import type { RunRuntimeOutcome } from "./runs.ts";
import { storeRunReport, writeAtomicPrivateFile } from "./storage.ts";

/** What the host starts: the run's pi and its first prompt. */
export interface RpcHostSpec {
	/** The run's pi with its flags, `--mode rpc` among them. */
	command: string[];
	cwd: string;
	/** The pi config directory the run's pi uses, with its auth and models: the orchestrator's. */
	agentDir: string;
	prompt: string;
	/** The model and thinking level the run's pi must have started with, as admitted. */
	model: { provider: string; id: string; thinkingLevel: string };
}

/** The host as it last stored itself. */
export interface RpcHostState {
	hostPid: number;
	/** Stored as soon as the run's pi is spawned. */
	childPid?: number;
	/** The run's session; pi writes the file only once it holds a message. */
	sessionFile?: string;
	sessionId?: string;
	/** How the work settled; stored with the Report. */
	outcome?: RunRuntimeOutcome;
	reportSeq?: number;
	/** How the run's pi exited, after its stdin was closed or it ended by itself. */
	exit?: { code: number | null; signal: string | null };
}

const specPath = (runDir: string) => join(runDir, "rpc-spec.json");
const statePath = (runDir: string) => join(runDir, "rpc-host.json");
/** Child stderr: pi reports a failed start only there. */
const stderrPath = (runDir: string) => join(runDir, "rpc-child.stderr");
const HOST_FILE = fileURLToPath(import.meta.url);
const RESOLVE_HOOK = join(dirname(HOST_FILE), "../../daemon/pi-resolve-hook.mjs");

/** Starts a detached host for the run in `runDir`; it outlives the caller. Returns the host's pid. */
export function launchRpcHost(runDir: string, spec: RpcHostSpec): number {
	writeAtomicPrivateFile(specPath(runDir), JSON.stringify(spec));
	// Started as pi starts the daemon: node strips the types, and the hook resolves pi's packages from its install.
	const root = piPackageRoot();
	const host = spawn(process.execPath, ["--import", RESOLVE_HOOK, HOST_FILE, runDir], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, ...(root ? { PI_PACKAGE_ROOT: root } : {}) },
	});
	// A host that cannot be spawned leaves no pid, which fails the run; its error event must not end this pi.
	host.on("error", () => {});
	host.unref();
	if (host.pid === undefined) throw new Error("the run's host did not start");
	return host.pid;
}

export function readRpcHostState(runDir: string): RpcHostState | undefined {
	try {
		return JSON.parse(readFileSync(statePath(runDir), "utf8")) as RpcHostState;
	} catch {
		return undefined;
	}
}

export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Asks the host to stop the run: its pi ends its work as on a SIGTERM, and the host stores how it ended. */
export function stopRpcHost(hostPid: number): void {
	try {
		process.kill(hostPid, "SIGTERM");
	} catch {
		// Gone already.
	}
}

/**
 * The run's pi inherits the orchestrator's environment but none of bluclawd's own variables, so nothing in it takes
 * itself for the orchestrator's pane or a run in tmux; its config directory is set explicitly.
 */
function childEnv(env: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
	const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("BLUCLAWD_")));
	return { ...kept, PI_CODING_AGENT_DIR: agentDir };
}

type RpcRecord = { type: string; id?: string; [key: string]: unknown };

/** pi's RPC over the child's stdio: strict JSONL, split on LF only, as pi frames it. */
function connect(child: ChildProcess, onEvent: (event: RpcRecord) => void) {
	const pending = new Map<string, { resolve: (record: RpcRecord) => void; reject: (error: Error) => void }>();
	let nextId = 0;
	let buffer = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at).replace(/\r$/, "");
			buffer = buffer.slice(at + 1);
			if (!line) continue;
			let record: RpcRecord;
			try {
				record = JSON.parse(line) as RpcRecord;
			} catch {
				continue;
			}
			const waiter = record.type === "response" && record.id ? pending.get(record.id) : undefined;
			if (waiter && record.id) {
				pending.delete(record.id);
				waiter.resolve(record);
			} else onEvent(record);
		}
	});
	child.on("exit", () => {
		for (const waiter of pending.values()) waiter.reject(new Error("the run's pi exited"));
		pending.clear();
	});
	return (command: Record<string, unknown>): Promise<RpcRecord> =>
		new Promise((resolve, reject) => {
			const id = `host-${++nextId}`;
			pending.set(id, { resolve, reject });
			child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
		});
}

const textOf = (content: unknown): string =>
	Array.isArray(content)
		? content
				.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
				.join("")
		: typeof content === "string"
			? content
			: "";

async function host(runDir: string): Promise<void> {
	const spec = JSON.parse(readFileSync(specPath(runDir), "utf8")) as RpcHostSpec;
	const state: RpcHostState = { hostPid: process.pid };
	const save = () => writeAtomicPrivateFile(statePath(runDir), JSON.stringify(state));
	save();

	const child = spawn(spec.command[0], spec.command.slice(1), {
		cwd: spec.cwd,
		env: childEnv(process.env, spec.agentDir),
		stdio: ["pipe", "pipe", openSync(stderrPath(runDir), "a", 0o600)],
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
		// A pi that could not be spawned never exits: why goes where its stderr would have.
		child.on("error", (error) => {
			appendFileSync(stderrPath(runDir), `${error.message}\n`);
			resolve({ code: null, signal: null });
		});
	});
	state.childPid = child.pid;
	save();

	let stopped = false;
	process.on("SIGTERM", () => {
		stopped = true;
		// pi ends its work in order on a SIGTERM, its shell commands included.
		child.kill("SIGTERM");
	});

	let last: { text: string; stopReason?: string; errorMessage?: string } = { text: "" };
	let onSettled: ((aborted: boolean) => void) | undefined;
	const request = connect(child, (event) => {
		if (event.type === "message_end") {
			const message = event.message as {
				role?: string;
				content?: unknown;
				stopReason?: string;
				errorMessage?: string;
			};
			if (message.role === "assistant") {
				last = {
					text: textOf(message.content),
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
				};
			}
		}
		if (event.type === "agent_settled") onSettled?.(event.aborted === true);
	});
	const settled = () =>
		new Promise<boolean>((resolve) => {
			onSettled = resolve;
		});

	const work = async (): Promise<RunRuntimeOutcome> => {
		const started = await request({ type: "get_state" });
		const data = started.data as {
			model?: { provider?: string; id?: string };
			thinkingLevel?: string;
			sessionFile?: string;
			sessionId?: string;
		};
		state.sessionFile = data.sessionFile;
		state.sessionId = data.sessionId;
		save();
		// pi lowers a level its model lacks, and takes an id its provider lacks for a custom one, warning only.
		const { provider, id } = data.model ?? {};
		const admitted = spec.model;
		if (provider !== admitted.provider || id !== admitted.id || data.thinkingLevel !== admitted.thinkingLevel) {
			return {
				status: "failed",
				error: `its pi runs ${provider ?? "no model"}/${id ?? ""} at thinking ${data.thinkingLevel}, not ${admitted.provider}/${admitted.id} at thinking ${admitted.thinkingLevel}`,
			};
		}
		const available = (await request({ type: "get_available_models" })).data as {
			models?: { provider: string; id: string }[];
		};
		if (!available.models?.some((model) => model.provider === admitted.provider && model.id === admitted.id)) {
			return {
				status: "failed",
				error: `its pi cannot use ${admitted.provider}/${admitted.id}: the model is unknown to it, or it has no authentication for it`,
			};
		}
		// Subscribed before the prompt goes, so its settling cannot be missed.
		let next = settled();
		const prompted = await request({ type: "prompt", message: spec.prompt });
		if (!prompted.success) return { status: "failed", error: String(prompted.error ?? "its task was refused") };
		for (;;) {
			const aborted = await next;
			if (aborted || stopped) return { status: "stopped", error: "its work was stopped" };
			next = settled();
			// pi goes on by itself with what was queued meanwhile: the work is done once nothing is.
			const now = (await request({ type: "get_state" })).data as {
				isStreaming?: boolean;
				pendingMessageCount?: number;
			};
			if (!now.isStreaming && !now.pendingMessageCount) break;
		}
		if (last.stopReason === "error") return { status: "failed", error: last.errorMessage ?? "its model failed" };
		if (last.stopReason === "aborted") return { status: "stopped", error: "its work was stopped" };
		return { status: "completed" };
	};

	const outcome = await Promise.race([
		work().catch(
			(error: unknown): RunRuntimeOutcome => ({
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		),
		exited.then(
			(exit): RunRuntimeOutcome =>
				stopped
					? { status: "stopped", error: "its work was stopped" }
					: {
							status: "failed",
							error: `its pi exited first (${exit.signal ?? `code ${exit.code}`}): ${stderrTail(runDir)}`,
						},
		),
	]);
	// Stored before its pi is let go: its work is on disk whatever happens next.
	state.outcome = outcome;
	state.reportSeq = storeRunReport(runDir, { text: last.text, outcome, sessionId: state.sessionId });
	save();
	child.stdin?.end();
	state.exit = await exited;
	save();
}

function stderrTail(runDir: string): string {
	try {
		return readFileSync(stderrPath(runDir), "utf8").trim().split("\n").slice(-5).join("\n") || "no output";
	} catch {
		return "no output";
	}
}

/** Whether this module runs as the host: node gives the entry by its real path, which an install may link to. */
function isEntry(): boolean {
	try {
		return realpathSync(process.argv[1] ?? "") === realpathSync(HOST_FILE);
	} catch {
		return false;
	}
}

if (isEntry()) {
	const runDir = process.argv[2];
	host(runDir).then(
		() => process.exit(0),
		(error: unknown) => {
			try {
				writeFileSync(join(runDir, "rpc-host.error"), String(error instanceof Error ? error.stack : error));
			} finally {
				process.exit(1);
			}
		},
	);
}
