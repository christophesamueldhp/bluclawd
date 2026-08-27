/**
 * Background bash jobs (Claude Code `run_in_background` parity — CC-PARITY-AUDIT B.1).
 *
 * The registry is a module-scoped, process-wide singleton: jobs belong to the
 * PROCESS, not to a session branch — resuming or forking a session must never
 * resurrect (or pretend to own) a dead child process, so no job state is ever
 * persisted to the session log. Each job owns its own AbortController; the tool
 * call's Esc/abort signal is deliberately NOT wired to it (backgrounding means
 * outliving the tool call).
 *
 * Output is buffered with a byte cap (oldest chunks dropped, noted to the
 * reader). `bash_output` reads are cursor-based and incremental: each call
 * returns only output produced since the previous call, mirroring Claude
 * Code's BashOutput tool.
 *
 * Deferred (documented): Ctrl+B mid-flight backgrounding of an already-running
 * foreground bash needs a transfer channel from the live execution into this
 * registry — audit Tier B follow-up.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { wrapToolDefinition } from "../../../packages/coding-agent/src/core/tools/tool-definition-wrapper.ts";

/** Cap on buffered output per job; the oldest chunks are dropped past this. */
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
/** Finished jobs retained for later `bash_output` / `/tasks` inspection before the oldest are dropped. */
const DEFAULT_MAX_FINISHED_JOBS = 50;

/** Exec function shape — matches BashOperations.exec (injected to avoid an import cycle with bash.ts). */
export type BackgroundExec = (
	command: string,
	cwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		env?: NodeJS.ProcessEnv;
	},
) => Promise<{ exitCode: number | null }>;

export interface BackgroundJobInfo {
	id: string;
	command: string;
	description?: string;
	cwd: string;
	startedAt: number;
	/** Set once the process has terminated (normally, by error, or by kill). */
	exit?: { code: number | null; error?: string; at: number };
	killed: boolean;
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
	private nextId = 1;
	private maxBufferBytes: number;
	private maxFinishedJobs: number;

	constructor(options?: { maxBufferBytes?: number; maxFinishedJobs?: number }) {
		this.maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
		this.maxFinishedJobs = options?.maxFinishedJobs ?? DEFAULT_MAX_FINISHED_JOBS;
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

	start(options: {
		command: string;
		cwd: string;
		exec: BackgroundExec;
		description?: string;
		timeout?: number;
		env?: NodeJS.ProcessEnv;
	}): BackgroundJobInfo {
		const id = `bash_${this.nextId++}`;
		const state: JobState = {
			id,
			command: options.command,
			description: options.description,
			cwd: options.cwd,
			startedAt: Date.now(),
			killed: false,
			chunks: [],
			totalBytes: 0,
			droppedBytes: 0,
			cursor: 0,
			abort: new AbortController(),
		};
		this.jobs.set(id, state);
		this.evictFinished();

		void options
			.exec(options.command, options.cwd, {
				onData: (data) => this.append(state, data),
				signal: state.abort.signal,
				timeout: options.timeout,
				env: options.env,
			})
			.then((result) => {
				state.exit = { code: result.exitCode, at: Date.now() };
				this.evictFinished();
			})
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				state.exit = {
					code: null,
					// An abort-kill is expected termination, not an error worth surfacing.
					error: state.killed && message === "aborted" ? undefined : message,
					at: Date.now(),
				};
				this.evictFinished();
			});

		return this.info(state);
	}

	get(id: string): BackgroundJobInfo | undefined {
		const state = this.jobs.get(id);
		return state ? this.info(state) : undefined;
	}

	list(): BackgroundJobInfo[] {
		return [...this.jobs.values()].map((state) => this.info(state));
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

	/** Kill a running job's whole process tree (via its abort signal). */
	kill(id: string): BackgroundJobInfo | undefined {
		const state = this.jobs.get(id);
		if (!state) return undefined;
		if (!state.exit) {
			state.killed = true;
			state.abort.abort();
		}
		return this.info(state);
	}

	/** Drop a finished job from the registry (bookkeeping only; no process interaction). */
	remove(id: string): boolean {
		const state = this.jobs.get(id);
		if (!state || !state.exit) return false;
		return this.jobs.delete(id);
	}

	private append(state: JobState, data: Buffer): void {
		state.chunks.push(data);
		state.totalBytes += data.length;
		while (state.totalBytes - state.droppedBytes > this.maxBufferBytes && state.chunks.length > 1) {
			const dropped = state.chunks.shift();
			if (dropped) state.droppedBytes += dropped.length;
		}
	}

	private info(state: JobState): BackgroundJobInfo {
		const { id, command, description, cwd, startedAt, exit, killed } = state;
		return { id, command, description, cwd, startedAt, exit, killed };
	}
}

/** The process-wide registry used by the bash tool, bash_output/kill_bash, and /tasks. */
export const backgroundBashJobs = new BackgroundJobRegistry();

export function describeJobStatus(job: BackgroundJobInfo): string {
	if (!job.exit) return "running";
	if (job.killed) return "killed";
	if (job.exit.error) return `failed (${job.exit.error})`;
	return `exited with code ${job.exit.code}`;
}

// ============================================================================
// Model-facing tools: bash_output + kill_bash
// ============================================================================

const bashOutputSchema = Type.Object({
	task_id: Type.String({ description: "Background task id returned by bash with run_in_background (e.g. bash_1)" }),
});

const killBashSchema = Type.Object({
	task_id: Type.String({ description: "Background task id to terminate (e.g. bash_1)" }),
});

export function createBashOutputToolDefinition(): ToolDefinition<typeof bashOutputSchema, undefined> {
	return {
		name: "bash_output",
		label: "bash_output",
		description:
			"Read new output from a background bash task started with run_in_background. Each call returns only output produced since the previous call, plus the task's status.",
		promptSnippet: "Read new output from a background bash task",
		parameters: bashOutputSchema,
		async execute(_toolCallId, { task_id }: { task_id: string }) {
			const result = backgroundBashJobs.read(task_id);
			if (!result) {
				const known = backgroundBashJobs.list().map((job) => job.id);
				throw new Error(`Unknown background task: ${task_id}. Known tasks: ${known.join(", ") || "(none)"}`);
			}
			const { job, newOutput, droppedNote } = result;
			const header = `[${job.id}] ${describeJobStatus(job)} — ${job.command}`;
			const body = [droppedNote, newOutput.length > 0 ? newOutput : "(no new output)"].filter(Boolean).join("\n");
			return { content: [{ type: "text", text: `${header}\n${body}` }], details: undefined };
		},
	};
}

export function createKillBashToolDefinition(): ToolDefinition<typeof killBashSchema, undefined> {
	return {
		name: "kill_bash",
		label: "kill_bash",
		description: "Terminate a background bash task started with run_in_background (kills its process tree).",
		promptSnippet: "Terminate a background bash task",
		parameters: killBashSchema,
		async execute(_toolCallId, { task_id }: { task_id: string }) {
			const job = backgroundBashJobs.kill(task_id);
			if (!job) {
				const known = backgroundBashJobs.list().map((j) => j.id);
				throw new Error(`Unknown background task: ${task_id}. Known tasks: ${known.join(", ") || "(none)"}`);
			}
			const status = job.exit ? `was already finished (${describeJobStatus(job)})` : "kill signal sent";
			return { content: [{ type: "text", text: `[${job.id}] ${status}.` }], details: undefined };
		},
	};
}

export function createBashOutputTool() {
	return wrapToolDefinition(createBashOutputToolDefinition());
}

export function createKillBashTool() {
	return wrapToolDefinition(createKillBashToolDefinition());
}
