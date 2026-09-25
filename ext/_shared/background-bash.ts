/**
 * Background bash jobs (Claude Code `run_in_background` parity — CC-PARITY-AUDIT B.1).
 *
 * The registry is a process-wide singleton (shared across extension module
 * graphs via sharedRef): jobs belong to the PROCESS, not to a session branch —
 * resuming or forking a session must never resurrect (or pretend to own) a dead
 * child process, so no job state is ever persisted to the session log. Each job
 * owns its own AbortController; the tool call's Esc/abort signal is
 * deliberately NOT wired to it (backgrounding means outliving the tool call).
 *
 * Every byte a job produces goes to its output file (Claude Code keeps task
 * output in a file the model reads with its read tool); a byte-capped copy stays
 * in memory for exit tails and /tasks. Jobs carry the session id that
 * started them, so a subagent child running in this process cannot see or stop
 * its parent's shells.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { classifyExit, SIGNAL_EXIT_CODE } from "./exit-status.ts";
import { sharedRef } from "./global-state.ts";
import { splitLines } from "./lines.ts";

/** Cap on buffered output per job; the oldest chunks are dropped past this. */
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
/** Claude Code's cap on a task's output file (5 GB). */
const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
/** Finished jobs retained for later `/tasks` inspection before the oldest are dropped. */
const DEFAULT_MAX_FINISHED_JOBS = 50;
/**
 * A process writing only bare-`\r` progress rewrites never ends a line, so cap the carry and flush it.
 * A genuine line longer than this is delivered as several lines.
 */
const MAX_CARRY_CHARS = 4096;

/**
 * Claude Code's stall watchdog: every 5s it checks whether a background shell's
 * output grew; after 45s without growth, a last line that reads as a prompt
 * means the command is waiting for input nobody will type.
 */
export const STALL_POLL_MS = 5000;
export const STALL_MS = 45000;
const STALL_TAIL_BYTES = 1024;
const PROMPT_PATTERNS = [
	/\(y\/n\)/i,
	/\[y\/n\]/i,
	/\(yes\/no\)/i,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
	/Press (any key|Enter)/i,
	/Continue\?/i,
	/Overwrite\?/i,
];

/** Whether the last line of `tail` reads as an interactive prompt. */
export function looksLikePrompt(tail: string): boolean {
	const last = tail.trimEnd().split("\n").pop() ?? "";
	return PROMPT_PATTERNS.some((pattern) => pattern.test(last));
}

/**
 * Where job output files live: under /tmp/claude, which the sandbox runtime lets
 * sandboxed commands write by default, so a sandboxed read of the file works too.
 */
function defaultOutputRoot(): string {
	const base = process.platform === "win32" ? tmpdir() : "/tmp/claude";
	let uid = "user";
	try {
		uid = String(userInfo().uid);
	} catch {}
	return join(base, `bluclawd-${uid}`);
}

/** A path segment from a session id: anything a path could trip on becomes `-`. */
const segment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-") || "-";

/** Claude Code's string hash (`NY`), for a project dir cut short. */
function stringHash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return h;
}

/** The cwd as Claude Code spells its project dirs (`gT`): every non-alphanumeric a `-`, long ones cut and hashed. */
function projectSegment(cwd: string): string {
	const spelled = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	return spelled.length <= 200 ? spelled : `${spelled.slice(0, 200)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Claude Code's task id (`MS`): a type letter and 8 random base36 characters (`b` shell, `s` WebSocket). */
function randomTaskId(prefix: string): string {
	const bytes = randomBytes(8);
	let id = prefix;
	for (const byte of bytes) id += TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length];
	return id;
}

/**
 * A sink belongs to the caller, not to the registry: a throw from it must not
 * corrupt job bookkeeping, or, from the synchronous onData path, take the
 * process down. Swallowed silently: this is a TUI, console output would
 * corrupt the render.
 */
function guardSink<A extends unknown[]>(fn: ((...args: A) => void) | undefined) {
	return (
		fn &&
		((...args: A) => {
			try {
				fn(...args);
			} catch {}
		})
	);
}

/** Exec function shape — matches BashOperations.exec (injected to avoid an import cycle with bash.ts). */
export type BackgroundExec = (
	command: string,
	cwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		env?: NodeJS.ProcessEnv;
		/** The job's output file, for a command that writes part of its output there itself. */
		outputFile?: string;
	},
) => Promise<{ exitCode: number | null }>;

export type BackgroundJobKind = "job" | "monitor";

export interface BackgroundJobInfo {
	id: string;
	command: string;
	description?: string;
	cwd: string;
	startedAt: number;
	/** Set once the process has terminated (normally, by error, or by kill). */
	exit?: {
		code: number | null;
		error?: string;
		at: number;
		/** The shell died of a signal; `code` is the one Claude Code reports for that. */
		noExitStatus?: boolean;
	};
	killed: boolean;
	/** Why the job was stopped programmatically (e.g. the monitor rate limit); absent for a caller's task_stop. */
	stopReason?: string;
	/** Stopped by the user from /tasks: the model is told, as Claude Code tells it. */
	stoppedByUser?: boolean;
	/** Who stopped it for its owner: "main session" when the main session stopped a subagent's shell. */
	stoppedBy?: string;
	/** The subagent child that started it; absent for the main session's own jobs. */
	agentId?: string;
	kind: BackgroundJobKind;
	/** Batches delivered to the model (monitors only; always 0 for plain jobs). */
	events: number;
	/** Session id of the session that started the job. */
	owner?: string;
	/** File holding the job's whole output; absent when it could not be created. */
	outputFile?: string;
	/** Bytes the job has written so far (a monitor: its stdout only). */
	outputBytes: number;
}

export interface JobSinks {
	/** Whole output lines, as they arrive; the trailing partial line is delivered before onExit. */
	onLines?: (lines: string[], job: BackgroundJobInfo) => void;
	/**
	 * Fires once, after `exit` is set. Read anything you need (peek) synchronously
	 * inside the callback: eviction of finished jobs runs right after it returns.
	 */
	onExit?: (job: BackgroundJobInfo) => void;
	/** Fires at most once, when a shell job (not a monitor) looks blocked on a prompt; `tail` is its last output. */
	onStall?: (job: BackgroundJobInfo, tail: string) => void;
}

interface JobState extends Omit<BackgroundJobInfo, "outputBytes"> {
	chunks: Buffer[];
	/** Total bytes ever produced (absolute stream offset of the buffer end). */
	totalBytes: number;
	/** Absolute stream offset of the buffer start (bytes dropped by the cap). */
	droppedBytes: number;
	/** Absolute stream offset of the next unread byte. */
	cursor: number;
	abort: AbortController;
	sinks: JobSinks;
	/** Partial last line not yet delivered to onLines. */
	carry: string;
	/** Holds a multibyte sequence split across chunks; only built when onLines is wired. */
	decoder?: StringDecoder;
	file?: WriteStream;
	/** The output file passed Claude Code's disk cap: nothing more is written, and the job is ended. */
	oversize?: boolean;
	stallTimer?: ReturnType<typeof setInterval>;
}

export interface BackgroundReadResult {
	job: BackgroundJobInfo;
	/** Output produced since the previous read (may be empty). */
	newOutput: string;
	/** Set when the buffer cap dropped bytes the reader never saw. */
	droppedNote?: string;
}

export class BackgroundJobRegistry {
	private jobs = new Map<string, JobState>();
	private maxBufferBytes: number;
	private maxFinishedJobs: number;
	private maxFileBytes: number;
	private outputRoot: string | null;
	private listeners = new Set<() => void>();

	/** `outputRoot: null` keeps output in memory only (tests). */
	constructor(options?: {
		maxBufferBytes?: number;
		maxFinishedJobs?: number;
		outputRoot?: string | null;
		maxFileBytes?: number;
	}) {
		this.maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
		this.maxFileBytes = options?.maxFileBytes ?? MAX_FILE_BYTES;
		this.maxFinishedJobs = options?.maxFinishedJobs ?? DEFAULT_MAX_FINISHED_JOBS;
		this.outputRoot = options?.outputRoot === undefined ? defaultOutputRoot() : options.outputRoot;
	}

	/** Called whenever a job starts, is killed or ends. Returns the unsubscribe. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {}
		}
	}

	/** Opens the job's output file; a failure leaves the job memory-only rather than failing it. */
	private openOutput(state: JobState): void {
		if (this.outputRoot === null) return;
		try {
			const dir = join(this.outputRoot, projectSegment(state.cwd), segment(state.owner ?? "process"), "tasks");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const path = join(dir, `${state.id}.output`);
			// Emptied, then appended to: a monitor's shell appends its stderr to the same
			// file, and only O_APPEND on both sides keeps the two from overwriting each other.
			writeFileSync(path, "", { mode: 0o600 });
			state.file = createWriteStream(path, { flags: "a" });
			// An error after open (disk full) must not crash the process; the memory copy remains.
			state.file.on("error", () => {
				state.file = undefined;
			});
			state.outputFile = path;
		} catch {}
	}

	/**
	 * Drop the oldest finished jobs past the retention cap.
	 *
	 * remove() existed but nothing ever called it, so every finished job — command,
	 * cwd, and up to maxBufferBytes of output — was retained for the life of the
	 * process. Running jobs are never evicted; Map preserves insertion order, so
	 * iteration is already oldest-first.
	 */
	private evictFinished(): void {
		const finished = [...this.jobs.values()].filter((state) => state.exit);
		for (const state of finished.slice(0, Math.max(0, finished.length - this.maxFinishedJobs))) {
			this.jobs.delete(state.id);
		}
	}

	start(
		options: {
			command: string;
			cwd: string;
			exec: BackgroundExec;
			description?: string;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			kind?: BackgroundJobKind;
			owner?: string;
			/** The subagent child starting it; absent for the main session. */
			agentId?: string;
			/** Task id type letter: `b` for a shell (the default), `s` for a WebSocket monitor. */
			idPrefix?: string;
		} & JobSinks,
	): BackgroundJobInfo {
		let id = randomTaskId(options.idPrefix ?? "b");
		while (this.jobs.has(id)) id = randomTaskId(options.idPrefix ?? "b");
		const state: JobState = {
			id,
			command: options.command,
			description: options.description,
			cwd: options.cwd,
			startedAt: Date.now(),
			killed: false,
			kind: options.kind ?? "job",
			events: 0,
			owner: options.owner,
			agentId: options.agentId,
			chunks: [],
			totalBytes: 0,
			droppedBytes: 0,
			cursor: 0,
			abort: new AbortController(),
			sinks: {
				onLines: guardSink(options.onLines),
				onExit: guardSink(options.onExit),
				onStall: guardSink(options.onStall),
			},
			carry: "",
			// Derived from the sink, not from options, so the two cannot drift apart.
			decoder: undefined,
		};
		if (state.sinks.onLines) state.decoder = new StringDecoder("utf-8");
		this.openOutput(state);
		this.jobs.set(id, state);
		this.evictFinished();
		this.changed();

		if (state.kind !== "monitor" && state.sinks.onStall) this.watchStall(state);

		const finish = (exit: JobState["exit"]) => {
			clearInterval(state.stallTimer);
			state.exit = exit;
			if (state.decoder) state.carry += state.decoder.end();
			if (state.carry.length > 0) {
				const { lines } = splitLines(state.carry, "\n");
				state.carry = "";
				if (lines.length > 0) state.sinks.onLines?.(lines, this.info(state));
			}
			state.sinks.onExit?.(this.info(state));
			// The end is marked in the file, as Claude Code marks it; the memory copy stays the output alone.
			state.file?.end(state.killed ? "\n[killed]\n" : `\n[exited with code ${exit?.code ?? "unknown"}]\n`);
			this.evictFinished();
			this.changed();
		};

		void options
			.exec(options.command, options.cwd, {
				onData: (data) => this.append(state, data),
				signal: state.abort.signal,
				timeout: options.timeout,
				env: options.env,
				outputFile: state.outputFile,
			})
			.then((result) =>
				// A null code means the shell itself died of a signal: Claude Code reports that as
				// a failure with a code of its own, not as an exit without a status.
				finish(
					result.exitCode === null
						? { code: SIGNAL_EXIT_CODE, noExitStatus: true, at: Date.now() }
						: { code: result.exitCode, at: Date.now() },
				),
			)
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				// Claude Code ends such a command with 137, a failure rather than a stop.
				if (state.oversize) return finish({ code: 137, at: Date.now() });
				finish({
					code: null,
					// An abort-kill is expected termination, not an error worth surfacing.
					error: state.killed && message === "aborted" ? undefined : message,
					at: Date.now(),
				});
			});

		return this.info(state);
	}

	get(id: string): BackgroundJobInfo | undefined {
		const state = this.jobs.get(id);
		return state ? this.info(state) : undefined;
	}

	/** Every job, or only those `owner` started. */
	list(owner?: string): BackgroundJobInfo[] {
		return [...this.jobs.values()]
			.filter((state) => owner === undefined || state.owner === owner)
			.map((state) => this.info(state));
	}

	/** Incremental read: everything produced since the last read. */
	read(id: string): BackgroundReadResult | undefined {
		const state = this.jobs.get(id);
		if (!state) return undefined;

		let droppedNote: string | undefined;
		let start = state.cursor;
		if (start < state.droppedBytes) {
			droppedNote = `[${state.droppedBytes - start} bytes of earlier output were dropped by the buffer cap]`;
			start = state.droppedBytes;
		}
		// Collect only the chunks at or after the cursor. Concatenating the whole
		// buffer and slicing made each poll cost the length of the entire stream, so
		// repeatedly polling a chatty job was quadratic in its output.
		const skip = start - state.droppedBytes;
		const unread: Buffer[] = [];
		let offset = 0;
		for (const chunk of state.chunks) {
			const chunkEnd = offset + chunk.length;
			if (chunkEnd > skip) unread.push(offset >= skip ? chunk : chunk.subarray(skip - offset));
			offset = chunkEnd;
		}
		const newOutput = Buffer.concat(unread).toString("utf-8");
		state.cursor = state.totalBytes;
		return { job: this.info(state), newOutput, droppedNote };
	}

	/** The whole buffered output, without moving the read cursor. */
	peek(id: string): string | undefined {
		const state = this.jobs.get(id);
		if (!state) return undefined;
		return Buffer.concat(state.chunks).toString("utf-8");
	}

	/** Count a delivered batch (monitors). */
	recordEvent(id: string): void {
		const state = this.jobs.get(id);
		if (state?.kind === "monitor") state.events++;
	}

	/**
	 * Kill a running job's whole process tree (via its abort signal). `reason` marks a
	 * registry-initiated stop, `byUser` a stop from /tasks, `stoppedBy` a stop made for
	 * the job's owner by another session.
	 */
	kill(
		id: string,
		options: { reason?: string; byUser?: boolean; stoppedBy?: string } = {},
	): BackgroundJobInfo | undefined {
		const state = this.jobs.get(id);
		if (!state) return undefined;
		if (!state.exit) {
			state.killed = true;
			state.stopReason = options.reason;
			state.stoppedByUser = options.byUser ?? false;
			state.stoppedBy = options.stoppedBy;
			state.abort.abort();
			this.changed();
		}
		return this.info(state);
	}

	/**
	 * Hands the running jobs `from` started to `to`: Claude Code keeps background shells
	 * across /clear, so the new session owns what the old one left running. A
	 * subagent's jobs stay its own.
	 */
	reown(from: string, to: string): number {
		let moved = 0;
		for (const state of this.jobs.values()) {
			if (state.exit || state.owner !== from || state.agentId !== undefined) continue;
			state.owner = to;
			moved++;
		}
		if (moved > 0) this.changed();
		return moved;
	}

	/** Drop a finished job from the registry (bookkeeping only; no process interaction). */
	remove(id: string): boolean {
		const state = this.jobs.get(id);
		if (!state || !state.exit) return false;
		return this.jobs.delete(id);
	}

	private watchStall(state: JobState): void {
		let seen = 0;
		let quietSince = Date.now();
		state.stallTimer = setInterval(() => {
			if (state.totalBytes > seen) {
				seen = state.totalBytes;
				quietSince = Date.now();
				return;
			}
			if (Date.now() - quietSince < STALL_MS) return;
			const all = Buffer.concat(state.chunks);
			const tail = all.subarray(Math.max(0, all.length - STALL_TAIL_BYTES)).toString("utf-8");
			if (!looksLikePrompt(tail)) {
				quietSince = Date.now();
				return;
			}
			clearInterval(state.stallTimer);
			state.sinks.onStall?.(this.info(state), tail);
		}, STALL_POLL_MS);
		state.stallTimer.unref?.();
	}

	private append(state: JobState, data: Buffer): void {
		if (state.oversize) return;
		if (state.totalBytes + data.length > this.maxFileBytes) {
			state.oversize = true;
			state.file?.write("\n[output truncated: exceeded 5GB disk cap]\n");
			state.abort.abort();
			return;
		}
		state.file?.write(data);
		state.chunks.push(data);
		state.totalBytes += data.length;
		while (state.totalBytes - state.droppedBytes > this.maxBufferBytes && state.chunks.length > 1) {
			const dropped = state.chunks.shift();
			if (dropped) state.droppedBytes += dropped.length;
		}
		if (!state.sinks.onLines) return;
		const { lines, carry } = splitLines(state.carry, state.decoder.write(data));
		state.carry = carry;
		if (state.carry.length > MAX_CARRY_CHARS) {
			lines.push(...splitLines(state.carry, "\n").lines);
			state.carry = "";
		}
		if (lines.length > 0) state.sinks.onLines(lines, this.info(state));
	}

	private info(state: JobState): BackgroundJobInfo {
		const { id, command, description, cwd, startedAt, exit, killed, stopReason, stoppedByUser, stoppedBy, kind } =
			state;
		const { events, owner, outputFile, totalBytes } = state;
		return {
			id,
			command,
			description,
			cwd,
			startedAt,
			exit,
			killed,
			stopReason,
			stoppedByUser,
			stoppedBy,
			agentId: state.agentId,
			kind,
			events,
			owner,
			outputFile,
			outputBytes: totalBytes,
		};
	}
}

/**
 * The process-wide registry used by the bash tool, task_stop, and /tasks.
 *
 * `sandbox` starts jobs and `background-bash` reads them, and pi loads each
 * top-level extension in its own module graph, so a plain module constant
 * would be two registries. `sharedRef` keeps it one (see global-state.ts).
 */
export const backgroundBashJobs = sharedRef("backgroundBashJobs", new BackgroundJobRegistry()).get();

export type JobOutcomeState = "running" | "completed" | "failed" | "killed";

/**
 * Where a job stands, in Claude Code's four task statuses. A job killed by us is
 * `killed`; one that could not run or died of a signal has failed; otherwise its
 * exit code is judged by the command that produced it (grep's exit 1 is an answer).
 */
export function jobOutcome(job: BackgroundJobInfo): { state: JobOutcomeState; note?: string } {
	if (!job.exit) return { state: "running" };
	if (job.killed) return { state: "killed" };
	if (job.exit.noExitStatus || job.exit.code === null) return { state: "failed" };
	const { status, note } = classifyExit(job.command, job.exit.code);
	return { state: status, note };
}

// Precedence ladder: a programmatic stop is more informative than a kill, which beats a timeout,
// which beats a generic error.
export function describeJobStatus(job: BackgroundJobInfo): string {
	if (!job.exit) return "running";
	if (job.stopReason) return `stopped: ${job.stopReason}`;
	if (job.killed) return "killed";
	const timeout = job.exit.error?.match(/^timeout:(\d+)/);
	if (timeout) return `timed out after ${timeout[1]}s`;
	if (job.exit.error) return `failed: ${job.exit.error}`;
	return `exited with code ${job.exit.code}`;
}

// ============================================================================
// The shell half of task_stop (the tool lives in ext/subagents, which owns the
// name; this answers for shell and monitor ids)
// ============================================================================

export function isShellTaskId(id: string): boolean {
	return /^[bs][0-9a-z]{8}$/.test(id);
}

function taskType(job: BackgroundJobInfo): string {
	return job.id.startsWith("s") ? "monitor_ws" : "local_bash";
}

/** Claude Code's answer for an id that names no task of this session. */
export function noTaskError(id: string): Error {
	return new Error(`No task found with ID: ${id}`);
}

/** Who is asking: the session calling task_stop, and its agent id when it is a subagent child. */
export interface TaskCaller {
	owner: string | undefined;
	/** Absent for the main session. */
	agentId?: string;
}

/**
 * The job, if the caller may name it. The main session reaches its own jobs and
 * its subagents'; a child finds any job, so that one it does not own gets
 * Claude Code's ownership error rather than a claim that it does not exist.
 */
function findJob(id: string, caller: TaskCaller): BackgroundJobInfo | undefined {
	const job = backgroundBashJobs.get(id);
	if (!job) return undefined;
	if (caller.agentId === undefined && job.agentId === undefined && job.owner !== caller.owner) return undefined;
	return job;
}

/**
 * task_stop for a shell (Claude Code's TaskStop). The main session may stop a
 * subagent's shell, whose owner is then told; a subagent stops only its own.
 */
export function shellTaskStop(id: string, caller: TaskCaller): string {
	const found = findJob(id, caller);
	if (!found) throw noTaskError(id);
	if (caller.agentId !== undefined && found.agentId !== caller.agentId) {
		throw new Error(
			`Task ${id} is owned by ${found.agentId ?? "main session"}; agent ${caller.agentId} cannot stop it.`,
		);
	}
	if (found.exit) throw new Error(`Task ${id} is not running (status: ${jobOutcome(found).state})`);
	backgroundBashJobs.kill(id, found.agentId !== caller.agentId ? { stoppedBy: "main session" } : {});
	return JSON.stringify({
		message: `Successfully stopped task: ${id} (${found.command})`,
		task_id: id,
		task_type: taskType(found),
		command: found.command,
	});
}
