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
 * in memory for exit tails and `task_output`. Jobs carry the session id that
 * started them, so a subagent child running in this process cannot see or stop
 * its parent's shells.
 */

import { createWriteStream, mkdirSync, type WriteStream, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sharedRef } from "./global-state.ts";
import { splitLines } from "./lines.ts";

/** Cap on buffered output per job; the oldest chunks are dropped past this. */
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
/** Finished jobs retained for later `task_output` / `/tasks` inspection before the oldest are dropped. */
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

/** A path segment from a cwd or session id, spelled as Claude Code spells its project dirs. */
const segment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-") || "-";

/** Claude Code's task id: a type letter and 8 random base36 characters (`b` shell, `s` WebSocket). */
function randomTaskId(prefix: string): string {
	let id = prefix;
	while (id.length < prefix.length + 8) id += Math.floor(Math.random() * 36).toString(36);
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
	exit?: { code: number | null; error?: string; at: number };
	killed: boolean;
	/** Why the job was stopped programmatically (e.g. the monitor rate limit); absent for a caller's task_stop. */
	stopReason?: string;
	/** Stopped by the user from /tasks: the model is told, as Claude Code tells it. */
	stoppedByUser?: boolean;
	/** A blocking task_output was waiting when it ended, and took the result itself. */
	awaited?: boolean;
	kind: BackgroundJobKind;
	/** Batches delivered to the model (monitors only; always 0 for plain jobs). */
	events: number;
	/** Session id of the session that started the job. */
	owner?: string;
	/** File holding the job's whole output; absent when it could not be created. */
	outputFile?: string;
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

interface JobState extends BackgroundJobInfo {
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
	/** task_output calls blocked on the job's exit. */
	waiters: Set<() => void>;
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
	private outputRoot: string | null;
	private listeners = new Set<() => void>();

	/** `outputRoot: null` keeps output in memory only (tests). */
	constructor(options?: { maxBufferBytes?: number; maxFinishedJobs?: number; outputRoot?: string | null }) {
		this.maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
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
			const dir = join(this.outputRoot, segment(state.cwd), segment(state.owner ?? "process"), "tasks");
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
			waiters: new Set(),
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
			state.awaited = state.waiters.size > 0;
			if (state.decoder) state.carry += state.decoder.end();
			if (state.carry.length > 0) {
				const { lines } = splitLines(state.carry, "\n");
				state.carry = "";
				if (lines.length > 0) state.sinks.onLines?.(lines, this.info(state));
			}
			state.sinks.onExit?.(this.info(state));
			// The end is marked in the file, as Claude Code marks it; the memory copy stays the output alone.
			state.file?.end(state.killed || exit?.code === null ? "\n[killed]\n" : `\n[exited with code ${exit?.code}]\n`);
			for (const wake of state.waiters) wake();
			state.waiters.clear();
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
			.then((result) => finish({ code: result.exitCode, at: Date.now() }))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
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

	/**
	 * Resolves with the job once it has ended, or as it stands when `timeoutMs`
	 * passes or `signal` aborts first; undefined for an unknown id.
	 */
	async waitFor(id: string, timeoutMs: number, signal?: AbortSignal): Promise<BackgroundJobInfo | undefined> {
		const state = this.jobs.get(id);
		if (!state) return undefined;
		if (!state.exit && timeoutMs > 0 && !signal?.aborted) {
			let wake!: () => void;
			let timer: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve) => {
				wake = resolve;
				state.waiters.add(wake);
				timer = setTimeout(wake, timeoutMs);
				signal?.addEventListener("abort", wake, { once: true });
			});
			clearTimeout(timer);
			state.waiters.delete(wake);
			signal?.removeEventListener("abort", wake);
		}
		return this.info(state);
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
	 * registry-initiated stop; `byUser` a stop from /tasks.
	 */
	kill(id: string, reason?: string, byUser = false): BackgroundJobInfo | undefined {
		const state = this.jobs.get(id);
		if (!state) return undefined;
		if (!state.exit) {
			state.killed = true;
			state.stopReason = reason;
			state.stoppedByUser = byUser;
			state.abort.abort();
			this.changed();
		}
		return this.info(state);
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
		const { id, command, description, cwd, startedAt, exit, killed, stopReason, stoppedByUser, awaited, kind } =
			state;
		const { events, owner, outputFile } = state;
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
			awaited,
			kind,
			events,
			owner,
			outputFile,
		};
	}
}

/**
 * The process-wide registry used by the bash tool, task_output/task_stop, and /tasks.
 *
 * `sandbox` starts jobs and `background-bash` reads them, and pi loads each
 * top-level extension in its own module graph, so a plain module constant
 * would be two registries. `sharedRef` keeps it one (see global-state.ts).
 */
export const backgroundBashJobs = sharedRef("backgroundBashJobs", new BackgroundJobRegistry()).get();

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
// The shell half of task_output / task_stop (the tools live in ext/subagents,
// which owns the names; these answer for bash_N ids)
// ============================================================================

/** The job, if `owner` may see it: a child session never reaches its parent's shells. */
function ownJob(id: string, owner: string | undefined): BackgroundJobInfo | undefined {
	const job = backgroundBashJobs.get(id);
	if (!job || (job.owner !== undefined && owner !== undefined && job.owner !== owner)) return undefined;
	return job;
}

export function isShellTaskId(id: string): boolean {
	return /^[bs][0-9a-z]{8}$/.test(id);
}

/** Claude Code caps a shell's returned output at this many characters, keeping the end. */
const MAX_TASK_OUTPUT_CHARS = 30_000;

function taskType(job: BackgroundJobInfo): string {
	return job.id.startsWith("s") ? "monitor_ws" : "local_bash";
}

function taskState(job: BackgroundJobInfo): string {
	if (!job.exit) return "running";
	if (job.killed) return "killed";
	return job.exit.error || (job.exit.code ?? 0) !== 0 ? "failed" : "completed";
}

/** Claude Code's answer for an id that names no task of this session. */
export function noTaskError(id: string): Error {
	return new Error(`No task found with ID: ${id}`);
}

/**
 * task_output for a shell (Claude Code's TaskOutput): waits for the exit when
 * `block`, up to `timeoutMs`, then returns the status and the output so far.
 */
export async function shellTaskOutput(
	id: string,
	owner: string | undefined,
	options: { block: boolean; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
	if (!ownJob(id, owner)) throw noTaskError(id);
	const job =
		(options.block ? await backgroundBashJobs.waitFor(id, options.timeoutMs, options.signal) : undefined) ??
		backgroundBashJobs.get(id);
	if (!job) throw noTaskError(id);
	const retrieval = job.exit ? "success" : options.block ? "timeout" : "not_ready";
	const lines = [
		`<retrieval_status>${retrieval}</retrieval_status>`,
		`<task_id>${job.id}</task_id>`,
		`<task_type>${taskType(job)}</task_type>`,
		`<status>${taskState(job)}</status>`,
	];
	if (job.exit && job.exit.code !== null) lines.push(`<exit_code>${job.exit.code}</exit_code>`);
	let output = (backgroundBashJobs.peek(id) ?? "").replace(/\n$/, "");
	if (output.length > MAX_TASK_OUTPUT_CHARS) output = output.slice(-MAX_TASK_OUTPUT_CHARS);
	if (output) lines.push(`<output>\n${output}\n</output>`);
	if (job.exit?.error && !job.killed) lines.push(`<error>${describeJobStatus(job)}</error>`);
	return lines.join("\n");
}

/** task_stop for a shell (Claude Code's TaskStop). */
export function shellTaskStop(id: string, owner: string | undefined): string {
	const found = ownJob(id, owner);
	if (!found) throw noTaskError(id);
	if (found.exit) throw new Error(`Task ${id} is not running (status: ${taskState(found)})`);
	backgroundBashJobs.kill(id);
	return JSON.stringify({
		message: `Successfully stopped task: ${id} (${found.command})`,
		task_id: id,
		task_type: taskType(found),
		command: found.command,
	});
}
