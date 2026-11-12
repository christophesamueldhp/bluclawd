/**
 * The process that holds an RPC run's pi (ADR-0010). pi aborts its work once its stdin closes, so the pi's stdio
 * belongs to a detached host of its own, not to the orchestrator, whose pi may end first, nor to the daemon, which only
 * starts the host once the run's turn in its queue comes. The host starts the run's pi, gives it its task, stores its Report once its work settles with nothing pending, then closes its stdin and
 * records how it exited. Everything between the orchestrator and the host goes through the run's directory: the
 * launch spec and messages for the run in, the host's state, what the run sends out and its Reports out
 * (run-mailbox.ts), and approvals the run asks for out with their answers in (run-approvals.ts); a SIGTERM to the
 * host stops the run.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestratorClient, piPackageRoot } from "../../daemon/orchestrator-client.ts";
import { processAlive, processGroupAlive } from "../../daemon/processes.ts";
import type { RunHostLaunch } from "../../daemon/run-queue.ts";
import { PANE_ENV, PARENT_ENV, RUN_PANE_ENV, Tmux } from "../../daemon/tmux.ts";
import { SUBAGENT_MESSAGE_TOOL } from "./messages.ts";
import { textOf } from "./results.ts";
import {
	dialogAnswer,
	type RunApprovalAnswer,
	runApprovalAnswer,
	runApprovalAsked,
	runApprovalSeenAt,
	storeRunApprovalRequest,
	withdrawRunApproval,
} from "./run-approvals.ts";
import {
	markGiven,
	type RunInboxMessage,
	type RunOutboxMessage,
	readRunInbox,
	sealRunInbox,
	unsealRunInbox,
	writeRunOutbox,
} from "./run-mailbox.ts";
import type { RunRuntimeOutcome } from "./runs.ts";
import { storeRunReport, writeAtomicPrivateFile } from "./storage.ts";

/** What the host starts: the run's pi and its first prompt. */
export interface RpcHostSpec {
	/** The run's pi's flags, `--mode rpc` among them; the pi is the one the host's own install has. */
	args: string[];
	cwd: string;
	/** The pi config directory the run's pi uses, with its auth and models: the orchestrator's. */
	agentDir: string;
	prompt: string;
	/** The model and thinking level the run's pi must have started with, as admitted. */
	model: { provider: string; id: string; thinkingLevel: string };
	/** The run's generation this host runs: 0 for the launch, then one more for each Resume. */
	generation: number;
	/** The saved session a Resume's pi must have opened, by its absolute path. */
	sessionFile?: string;
	/**
	 * Set for a generation that runs as an interactive pi in a pane of agent view's tmux (ADR-0013): the pane's tmux
	 * session, which the daemon starts the host in, and its orchestrator's, where a terminal showing it goes back to.
	 * A session that takes the run over stores its own pane as the orchestrator's ({@link paneParent}).
	 */
	pane?: { session: string; parent: string };
}

/** The host as it last stored itself. */
export interface RpcHostState {
	hostPid: number;
	/** The run's generation it runs; absent in a state stored before hosts said. */
	generation?: number;
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
	/** Set when a Resume opened for the user to type in ended with nothing typed: there is no Report to deliver. */
	idle?: true;
	/** Why its pi was never started: a host in a pane could not take the run's environment from the daemon. */
	notStarted?: string;
}

/** What a run's pi in a pane stores of its work (pane-child.ts), which its host takes into its state once it exits. */
export type PaneChildState = Pick<RpcHostState, "sessionFile" | "sessionId" | "outcome" | "reportSeq" | "idle"> & {
	/** Whether it waits on a blocking dialog of its own, an approval among them, which the user answers in its pane. */
	awaiting?: boolean;
};

/** Why a run in a pane stopped once its pane was ended from outside its pi. */
export const PANE_ENDED = "its pane was ended";

export const paneChildStatePath = (runDir: string) => join(runDir, "pane-child.json");

export function readPaneChildState(runDir: string): PaneChildState | undefined {
	try {
		return JSON.parse(readFileSync(paneChildStatePath(runDir), "utf8")) as PaneChildState;
	} catch {
		return undefined;
	}
}

const specPath = (runDir: string) => join(runDir, "rpc-spec.json");
const statePath = (runDir: string) => join(runDir, "rpc-host.json");
/** Holds the pid of the one host that runs the generation: whichever started first, however often it was launched. */
const hostClaimPath = (runDir: string, generation: number) => join(runDir, "hosts", String(generation));
/** Child stderr: pi reports a failed start only there. */
const stderrPath = (runDir: string) => join(runDir, "rpc-child.stderr");
/** How long a run's host and its pi may take to end, once stopped or done, before what is left of them is killed. */
export const STOP_GRACE_MS = 10_000;
/** How often the host looks for messages posted to the run. */
const INBOX_CHECK_MS = 50;
/** How long the orchestrator may go without noting it sees an approval the run asks for: past it, no one is there. */
const APPROVAL_SEEN_MS = 5000;
/** pi's dialogs, each of which waits for an answer. */
const DIALOGS = ["select", "confirm", "input", "editor"];
const HOST_FILE = fileURLToPath(import.meta.url);

/**
 * Stores the run's spec in `runDir` and returns what the daemon starts its host with once the run's turn comes
 * (daemon/run-queue.ts): detached, so it outlives whoever started it. The daemon's environment is not this pi's, so
 * this pi's goes with it; bluclawd's own variables are left out.
 */
export function prepareRpcHost(runDir: string, spec: RpcHostSpec): RunHostLaunch {
	writeAtomicPrivateFile(specPath(runDir), JSON.stringify(spec));
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("BLUCLAWD_"),
		),
	);
	return { runDir, env, ...(spec.pane ? { pane: spec.pane.session } : {}) };
}

/**
 * Whether `value` is a spec a host runs: the daemon starts a host for any run directory a client names, so what the
 * spec there holds is checked before anything of it starts.
 */
function isRpcHostSpec(value: unknown): value is RpcHostSpec {
	const spec = value as Partial<RpcHostSpec> | null;
	const text = (field: unknown) => typeof field === "string";
	return (
		typeof spec === "object" &&
		spec !== null &&
		Array.isArray(spec.args) &&
		spec.args.every(text) &&
		text(spec.cwd) &&
		text(spec.agentDir) &&
		text(spec.prompt) &&
		text(spec.model?.provider) &&
		text(spec.model?.id) &&
		text(spec.model?.thinkingLevel) &&
		Number.isInteger(spec.generation) &&
		(spec.generation ?? -1) >= 0 &&
		(spec.sessionFile === undefined || text(spec.sessionFile)) &&
		(spec.pane === undefined || (text(spec.pane?.session) && text(spec.pane?.parent)))
	);
}

/** The pi of the install this host runs from, which a run's pi is: never one a spec names. */
function piEntry(): string {
	const root =
		process.env.PI_PACKAGE_ROOT ??
		piPackageRoot(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	if (!root) throw new Error("pi's install was not found");
	const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: { pi?: unknown } };
	if (typeof bin?.pi !== "string") throw new Error(`${root} names no pi to start`);
	return join(root, bin.pi);
}

export function readRpcHostState(runDir: string): RpcHostState | undefined {
	try {
		return JSON.parse(readFileSync(statePath(runDir), "utf8")) as RpcHostState;
	} catch {
		return undefined;
	}
}

/**
 * The spec the run's latest generation was launched with, as stored before it queued; a session that took the run
 * over since rewrote its orchestrator's pane.
 */
export function readRpcHostSpec(runDir: string): RpcHostSpec | undefined {
	try {
		return JSON.parse(readFileSync(specPath(runDir), "utf8")) as RpcHostSpec;
	} catch {
		return undefined;
	}
}

/**
 * The orchestrator pane of a run's generation in `pane` now: a session that took the run over after a crash runs in
 * another pane, which it stores in the run's spec. A spec stored since for another generation is not this one's.
 */
export function paneParent(runDir: string, generation: number, pane: NonNullable<RpcHostSpec["pane"]>): string {
	const spec = readRpcHostSpec(runDir);
	return (spec?.generation === generation && spec.pane?.parent) || pane.parent;
}

/** The pid of the host that took generation `generation` of the run, once one did. */
export function generationHost(runDir: string, generation: number): number | undefined {
	try {
		const pid = Number(readFileSync(hostClaimPath(runDir, generation), "utf8"));
		return pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether anything of the run still runs in the process group its host `pid` led, a pid read from disk: one given to
 * another process since is not the host, whose command names the run's directory. No pid is given out again while a
 * group of that id has members, so once the host is gone, any member left is the run's.
 */
export function runGroupAlive(pid: number, runDir: string): boolean {
	if (!processAlive(pid)) return processGroupAlive(pid);
	return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(runDir);
}

/** Asks the host to stop the run: its pi ends its work as on a SIGTERM, and the host stores how it ended. */
export function stopRpcHost(hostPid: number): void {
	try {
		process.kill(hostPid, "SIGTERM");
	} catch {
		// Gone already.
	}
}

/** What points at the daemon's socket and tmux's: a run reaches neither, so nothing it runs is told where they are. */
const ENDPOINT_ENV = ["PI_SERVER_DIR", "TMUX", "TMUX_PANE"];

/**
 * The run's pi inherits the orchestrator's environment but none of bluclawd's own variables, so nothing in it takes
 * itself for the orchestrator's pane or a run in tmux, nor the daemon's or tmux's endpoints; its config directory is
 * set explicitly.
 */
function childEnv(env: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
	const kept = Object.fromEntries(
		Object.entries(env).filter(([key]) => !key.startsWith("BLUCLAWD_") && !ENDPOINT_ENV.includes(key)),
	);
	return { ...kept, PI_CODING_AGENT_DIR: agentDir };
}

/**
 * A run's pi in a pane gets the environment its run was launched with, as on RPC, and the pane's own: tmux's variables
 * and where pi keeps its state, which the daemon started the pane with. It draws in that pane, and goes back to its
 * orchestrator's from there. Its commands still reach neither tmux nor the daemon (run-shell.ts).
 */
function paneChildEnv(
	launched: Record<string, string>,
	own: NodeJS.ProcessEnv,
	runDir: string,
	pane: NonNullable<RpcHostSpec["pane"]>,
	agentDir: string,
): NodeJS.ProcessEnv {
	const kept = Object.entries(own).filter(
		(entry): entry is [string, string] =>
			entry[1] !== undefined && (ENDPOINT_ENV.includes(entry[0]) || /^PI_\w*(DIR|ROOT)$/.test(entry[0])),
	);
	return {
		...childEnv(launched, agentDir),
		...Object.fromEntries(kept),
		PI_CODING_AGENT_DIR: agentDir,
		[RUN_PANE_ENV]: runDir,
		[PANE_ENV]: pane.session,
		[PARENT_ENV]: pane.parent,
	};
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

async function host(runDir: string): Promise<void> {
	const spec: unknown = JSON.parse(readFileSync(specPath(runDir), "utf8"));
	if (!isRpcHostSpec(spec)) throw new Error(`${specPath(runDir)} is not a run's spec`);
	// A generation runs once: a host launched for it again, after a lost reply or a recovery, leaves it to the first.
	mkdirSync(dirname(hostClaimPath(runDir, spec.generation)), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(hostClaimPath(runDir, spec.generation), String(process.pid), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
		throw error;
	}
	const state: RpcHostState = { hostPid: process.pid, generation: spec.generation };
	const save = () => writeAtomicPrivateFile(statePath(runDir), JSON.stringify(state));
	save();
	if (spec.pane) return paneHost(runDir, { ...spec, pane: spec.pane }, state, save);

	const child = spawn(process.execPath, [piEntry(), ...spec.args], {
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

	/** Approvals the run's pi waits for, by pi's id for their dialog, with when each was asked. */
	const approvals = new Map<string, number>();
	const answerDialog = (id: string, answer: RunApprovalAnswer | undefined) => {
		approvals.delete(id);
		child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, ...dialogAnswer(answer) })}\n`);
	};
	const checkApprovals = () => {
		for (const [id, asked] of approvals) {
			const answer = runApprovalAnswer(runDir, spec.generation, id);
			if (answer) answerDialog(id, answer);
			else if (Date.now() - Math.max(asked, runApprovalSeenAt(runDir, spec.generation, id)) > APPROVAL_SEEN_MS) {
				withdrawRunApproval(runDir, spec.generation, id);
				answerDialog(id, "blocked");
			}
		}
	};
	/**
	 * A run that stops or ends takes no answer any more. Its pi is not answered either, which would let it go on to
	 * its next step: ending, it drops the dialog itself.
	 */
	const withdrawApprovals = () => {
		for (const id of approvals.keys()) withdrawRunApproval(runDir, spec.generation, id);
		approvals.clear();
	};

	let stopped = false;
	process.on("SIGTERM", () => {
		stopped = true;
		// A stopped run takes no more messages: those posted from now on are refused, not left untaken.
		clearInterval(watching);
		sealRunInbox(runDir, spec.generation);
		withdrawApprovals();
		// pi ends its work in order on a SIGTERM, its shell commands included.
		child.kill("SIGTERM");
	});

	let last: { text: string; stopReason?: string; errorMessage?: string } = { text: "" };
	let onSettled: ((aborted: boolean) => void) | undefined;
	/** Messages from the inbox given to pi, by id, and those of them its conversation does not hold yet. */
	const given = new Set<string>();
	const taken = new Set<string>();
	let waiting: RunInboxMessage[] = [];
	let sent = 0;
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
			// pi queues a message in memory only: it is the run's once its conversation holds it.
			const text = message.role === "user" ? textOf(message.content) : undefined;
			const at = waiting.findIndex((given) => given.text === text);
			if (at >= 0) {
				taken.add(waiting[at].id);
				waiting = waiting.filter((_, index) => index !== at);
			}
		}
		// What the run sends out is read off its own tool's results, which its pi alone produces.
		if (event.type === "tool_execution_end" && event.toolName === SUBAGENT_MESSAGE_TOOL && !event.isError) {
			const details = (event.result as { details?: Omit<RunOutboxMessage, "seq"> } | undefined)?.details;
			if (details) writeRunOutbox(runDir, spec.generation, { ...details, seq: ++sent });
		}
		if (event.type === "agent_settled") onSettled?.(event.aborted === true);
		// A dialog waits for its answer: only an approval the run asks for goes to its orchestrator, and any other is
		// dismissed at once, as if no one were there.
		if (
			event.type === "extension_ui_request" &&
			typeof event.id === "string" &&
			DIALOGS.includes(String(event.method))
		) {
			const ask = event.method === "select" && !stopped ? runApprovalAsked(event.title) : undefined;
			if (ask && storeRunApprovalRequest(runDir, spec.generation, { id: event.id, ...ask })) {
				approvals.set(event.id, Date.now());
			} else answerDialog(event.id, undefined);
		}
	});
	// One at a time, so the last look at the inbox and its seal cannot interleave with a message being given.
	let turn = Promise.resolve();
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const next = turn.then(task);
		turn = next.then(
			() => {},
			() => {},
		);
		return next;
	};
	/**
	 * Gives pi each message not given yet, as a prompt that steers it at its next safe point when it works and starts
	 * it when it is idle: a bare steer would wait on an idle pi for a prompt that never comes.
	 */
	const give = async (messages: RunInboxMessage[]) => {
		for (const message of messages) {
			if (given.has(message.id)) continue;
			given.add(message.id);
			waiting.push(message);
			const reply = await request({ type: "prompt", message: message.text, streamingBehavior: "steer" });
			if (!reply.success) {
				given.delete(message.id);
				waiting = waiting.filter((held) => held !== message);
			} else markGiven(runDir, spec.generation, message.id);
		}
	};
	let watching: ReturnType<typeof setInterval> | undefined;
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
		// pi starts a new session at a path that holds none, without a word.
		if (spec.sessionFile && !sameFile(data.sessionFile, spec.sessionFile)) {
			return {
				status: "failed",
				error: `its pi opened ${data.sessionFile ?? "no session"}, not the run's session ${spec.sessionFile}`,
			};
		}
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
		const inbox = () => readRunInbox(runDir, spec.generation);
		watching = setInterval(() => {
			checkApprovals();
			void serial(() => give(inbox())).catch(() => {});
		}, INBOX_CHECK_MS);
		for (;;) {
			const aborted = await next;
			if (aborted || stopped) return { status: "stopped", error: "its work was stopped" };
			next = settled();
			const done = await serial(async () => {
				await give(inbox());
				// pi goes on by itself with what was queued meanwhile: the work is done once nothing is.
				const now = (await request({ type: "get_state" })).data as {
					isStreaming?: boolean;
					pendingMessageCount?: number;
				};
				if (now.isStreaming || now.pendingMessageCount || waiting.length > 0) return false;
				// What landed before the seal is the run's to take: it goes on with it.
				const late = sealRunInbox(runDir, spec.generation).filter(({ id }) => !given.has(id));
				if (late.length === 0) return true;
				if (stopped) return false;
				unsealRunInbox(runDir, spec.generation);
				await give(late);
				// pi refused them all, so nothing settles again: they stay untaken, and the work is done.
				if (waiting.length > 0) return false;
				sealRunInbox(runDir, spec.generation);
				return true;
			});
			if (done) break;
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
	clearInterval(watching);
	withdrawApprovals();
	// Whatever it was sent and never took, stopped or failed first, stays in the sealed inbox, and the Report says so.
	const untaken = sealRunInbox(runDir, spec.generation).filter(({ id }) => !taken.has(id)).length;
	// Stored before its pi is let go: its work is on disk whatever happens next.
	state.outcome = outcome;
	state.reportSeq = storeRunReport(runDir, {
		text: last.text,
		outcome,
		sessionId: state.sessionId,
		generation: spec.generation,
		...(untaken ? { untaken } : {}),
	});
	save();
	child.stdin?.end();
	state.exit = await exited;
	save();
}

/**
 * The host of a run in a pane (ADR-0013). Its pi takes the pane's terminal and does over its extension API what this
 * host does over RPC (pane-child.ts). The host still holds the generation, passes a stop on, and stores how its pi
 * exited, with what the pi stored of its work. A terminal that shows the pane goes back to the orchestrator once the
 * host exits and the pane with it.
 */
async function paneHost(
	runDir: string,
	spec: RpcHostSpec & { pane: NonNullable<RpcHostSpec["pane"]> },
	state: RpcHostState,
	save: () => void,
): Promise<void> {
	// Ctrl+C reaches the pane's process group while its pi does not hold the terminal: it is not the host's to act on.
	process.on("SIGINT", () => {});
	// Its pane ended from outside, as by tmux kill-session, hangs its process group up: the host stays to store how its
	// pi ended. The hang-up may reach the host alone, its pane's session leader, so its pi is passed it; a pi that does
	// not end on it in time is killed, since nothing else ends it while the host waits for it.
	let paneEnded = false;
	let running: ChildProcess | undefined;
	process.on("SIGHUP", () => {
		paneEnded = true;
		running?.kill("SIGHUP");
		setTimeout(() => running?.kill("SIGKILL"), STOP_GRACE_MS).unref();
	});
	// What an earlier generation's pi stored is not this one's.
	rmSync(paneChildStatePath(runDir), { force: true });
	let launched: Record<string, string>;
	try {
		launched = await new OrchestratorClient().takeRunEnv(spec.pane.session);
	} catch (error) {
		// The daemon holds the environment in memory only: one started since it launched this host has none to give.
		state.notStarted = `the daemon restarted, or could not be reached, between launching the run's host and that host taking the run's environment (${error instanceof Error ? error.message : String(error)})`;
		save();
		return;
	}
	if (paneEnded) {
		state.notStarted = `${PANE_ENDED} before its pi started`;
		save();
		return;
	}
	const child = spawn(process.execPath, [piEntry(), ...spec.args], {
		cwd: spec.cwd,
		env: paneChildEnv(launched, process.env, runDir, spec.pane, spec.agentDir),
		stdio: "inherit",
	});
	running = child;
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
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
		sealRunInbox(runDir, spec.generation);
		child.kill("SIGTERM");
	});
	const exit = await exited;
	const { sessionFile, sessionId, outcome, reportSeq, idle } = readPaneChildState(runDir) ?? {};
	Object.assign(state, { sessionFile, sessionId, outcome, reportSeq, idle });
	// Its pi ended before it stored a Report: it crashed, or was killed.
	if (state.reportSeq === undefined && !state.idle) {
		sealRunInbox(runDir, spec.generation);
		state.outcome = stopped
			? { status: "stopped", error: "its work was stopped" }
			: paneEnded
				? { status: "stopped", error: PANE_ENDED }
				: {
						status: "failed",
						error: `its pi exited before its work settled (${exit.signal ?? `code ${exit.code}`})`,
					};
		state.reportSeq = storeRunReport(runDir, {
			text: "",
			outcome: state.outcome,
			sessionId: state.sessionId,
			generation: spec.generation,
		});
	}
	state.exit = exit;
	save();
	const socket = process.env.TMUX?.split(",")[0];
	if (!socket) return;
	try {
		new Tmux(dirname(socket), undefined, { timeoutMs: 2000 }).moveClients(
			spec.pane.session,
			paneParent(runDir, spec.generation, spec.pane),
		);
	} catch {
		// Its orchestrator's pane is gone, or tmux did not answer: tmux shows another session once this one ends.
	}
}

function sameFile(path: string | undefined, expected: string): boolean {
	if (!path) return false;
	try {
		return realpathSync(path) === realpathSync(expected);
	} catch {
		return false;
	}
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
