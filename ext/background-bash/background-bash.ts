import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sharedRef } from "../_shared/global-state.ts";
import { classifyExit, SIGNAL_EXIT_CODE } from "./exit-status.ts";
import { splitLines } from "./lines.ts";

export const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FINISHED_JOBS = 50;
const MAX_CARRY_CHARS = 4096;
const OVERSIZE_EXIT_CODE = 137;

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

export function looksLikePrompt(tail: string): boolean {
	const last = tail.trimEnd().split("\n").pop() ?? "";
	return PROMPT_PATTERNS.some((pattern) => pattern.test(last));
}

/**
 * Where job output files live, under /tmp/claude, which the sandbox runtime lets
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

const segment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-") || "-";

function stringHash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return h;
}

function projectSegment(cwd: string): string {
	const spelled = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	return spelled.length <= 200 ? spelled : `${spelled.slice(0, 200)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function randomTaskId(prefix: string): string {
	const bytes = randomBytes(8);
	let id = prefix;
	for (const byte of bytes) id += TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length];
	return id;
}

export function guardSink<A extends unknown[]>(fn: (...args: A) => void) {
	return (...args: A) => {
		try {
			fn(...args);
		} catch {}
	};
}

export type BackgroundExec = (
	command: string,
	cwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		env?: NodeJS.ProcessEnv;
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
	exit?: {
		code: number | null;
		error?: string;
		at: number;
		noExitStatus?: boolean;
	};
	killed: boolean;
	stopReason?: string;
	stoppedByUser?: boolean;
	stoppedBy?: string;
	agentId?: string;
	kind: BackgroundJobKind;
	events: number;
	owner?: string;
	outputFile?: string;
	outputBytes: number;
}

export interface JobSinks {
	onLines?: (lines: string[], job: BackgroundJobInfo) => void;
	onExit?: (job: BackgroundJobInfo) => void;
	onStall?: (job: BackgroundJobInfo, tail: string) => void;
}

interface JobState extends Omit<BackgroundJobInfo, "outputBytes"> {
	chunks: Buffer[];
	totalBytes: number;
	droppedBytes: number;
	cursor: number;
	abort: AbortController;
	sinks: Omit<JobSinks, "onLines">;
	lineSink?: LineSink;
	file?: WriteStream;
	oversize?: boolean;
	stallTimer?: ReturnType<typeof setInterval>;
}

interface LineSink {
	onLines: NonNullable<JobSinks["onLines"]>;
	decoder: StringDecoder;
	carry: string;
}

export interface BackgroundReadResult {
	job: BackgroundJobInfo;
	newOutput: string;
	droppedNote?: string;
}

export class BackgroundJobRegistry {
	private jobs = new Map<string, JobState>();
	private maxBufferBytes: number;
	private maxFinishedJobs: number;
	private maxFileBytes: number;
	private outputRoot: string | null;
	private listeners = new Set<() => void>();

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

	private openOutput(state: JobState): void {
		if (this.outputRoot === null) return;
		try {
			const dir = join(this.outputRoot, projectSegment(state.cwd), segment(state.owner ?? "process"), "tasks");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const path = join(dir, `${state.id}.output`);
			// Emptied, then appended to, because a monitor's shell appends its stderr to the same
			// file, and only O_APPEND on both sides keeps the two from overwriting each other.
			writeFileSync(path, "", { mode: 0o600 });
			state.file = createWriteStream(path, { flags: "a" });
			state.file.on("error", () => {
				state.file = undefined;
			});
			state.outputFile = path;
		} catch {}
	}

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
			agentId?: string;
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
				onExit: options.onExit && guardSink(options.onExit),
				onStall: options.onStall && guardSink(options.onStall),
			},
			lineSink: options.onLines && {
				onLines: guardSink(options.onLines),
				decoder: new StringDecoder("utf-8"),
				carry: "",
			},
		};
		this.openOutput(state);
		this.jobs.set(id, state);
		this.evictFinished();
		this.changed();

		if (state.kind !== "monitor" && state.sinks.onStall) this.watchStall(state);

		const finish = (exit: JobState["exit"]) => {
			clearInterval(state.stallTimer);
			state.exit = exit;
			const { lineSink } = state;
			if (lineSink) {
				const rest = lineSink.carry + lineSink.decoder.end();
				lineSink.carry = "";
				const { lines } = rest.length > 0 ? splitLines(rest, "\n") : { lines: [] };
				if (lines.length > 0) lineSink.onLines(lines, this.info(state));
			}
			state.sinks.onExit?.(this.info(state));
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
				finish(
					result.exitCode === null
						? { code: SIGNAL_EXIT_CODE, noExitStatus: true, at: Date.now() }
						: { code: result.exitCode, at: Date.now() },
				),
			)
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				if (state.oversize) return finish({ code: OVERSIZE_EXIT_CODE, at: Date.now() });
				finish({
					code: null,
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

	list(owner?: string): BackgroundJobInfo[] {
		return [...this.jobs.values()]
			.filter((state) => owner === undefined || state.owner === owner)
			.map((state) => this.info(state));
	}

	read(id: string): BackgroundReadResult | undefined {
		const state = this.jobs.get(id);
		if (!state) return undefined;

		let droppedNote: string | undefined;
		let start = state.cursor;
		if (start < state.droppedBytes) {
			droppedNote = `[${state.droppedBytes - start} bytes of earlier output were dropped by the buffer cap]`;
			start = state.droppedBytes;
		}
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

	peek(id: string): string | undefined {
		const state = this.jobs.get(id);
		if (!state) return undefined;
		return Buffer.concat(state.chunks).toString("utf-8");
	}

	recordEvent(id: string): void {
		const state = this.jobs.get(id);
		if (state?.kind === "monitor") state.events++;
	}

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
		const { lineSink } = state;
		if (!lineSink) return;
		const { lines, carry } = splitLines(lineSink.carry, lineSink.decoder.write(data));
		lineSink.carry = carry;
		if (lineSink.carry.length > MAX_CARRY_CHARS) {
			lines.push(...splitLines(lineSink.carry, "\n").lines);
			lineSink.carry = "";
		}
		if (lines.length > 0) lineSink.onLines(lines, this.info(state));
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
 * pi re-imports an extension each time it rebuilds the runtime (/new, /resume,
 * fork, /reload), so a plain module constant would lose the running jobs.
 */
export const backgroundBashJobs = sharedRef("backgroundBashJobs", new BackgroundJobRegistry()).get();

export type JobOutcomeState = "running" | "completed" | "failed" | "killed";

export function jobOutcome(job: BackgroundJobInfo): { state: JobOutcomeState; note?: string } {
	if (!job.exit) return { state: "running" };
	if (job.killed) return { state: "killed" };
	if (job.exit.noExitStatus || job.exit.code === null) return { state: "failed" };
	const { status, note } = classifyExit(job.command, job.exit.code);
	return { state: status, note };
}

export function describeJobStatus(job: BackgroundJobInfo): string {
	if (!job.exit) return "running";
	if (job.stopReason) return `stopped: ${job.stopReason}`;
	if (job.killed) return "killed";
	const timeout = job.exit.error?.match(/^timeout:(\d+)/);
	if (timeout) return `timed out after ${timeout[1]}s`;
	if (job.exit.error) return `failed: ${job.exit.error}`;
	return `exited with code ${job.exit.code}`;
}

export function isShellTaskId(id: string): boolean {
	return /^[bs][0-9a-z]{8}$/.test(id);
}

function taskType(job: BackgroundJobInfo): string {
	return job.id.startsWith("s") ? "monitor_ws" : "local_bash";
}

export function noTaskError(id: string): Error {
	return new Error(`No task found with ID: ${id}`);
}

export interface TaskCaller {
	owner: string | undefined;
	agentId?: string;
}

function findJob(id: string, caller: TaskCaller): BackgroundJobInfo | undefined {
	const job = backgroundBashJobs.get(id);
	if (!job) return undefined;
	if (caller.agentId === undefined && job.agentId === undefined && job.owner !== caller.owner) return undefined;
	return job;
}

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
