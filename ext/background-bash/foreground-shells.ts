import { notifyListeners, sharedRef } from "../_shared/global-state.ts";
import {
	type BackgroundExec,
	type BackgroundJobInfo,
	backgroundBashJobs,
	DEFAULT_MAX_BUFFER_BYTES,
} from "./background-bash.ts";

export type DetachReason = "user" | "timeout" | "message";

export const FOREGROUND_TASK_AFTER_MS = 2000;

export interface ForegroundShell {
	id: string;
	command: string;
	startedAt: number;
	owner?: string;
	agentId?: string;
	output(): string;
	detach(reason: DetachReason, timeout?: number): void;
	stop(): void;
}

let nextId = 0;

const state = sharedRef("foregroundShells", {
	running: new Set<ForegroundShell>(),
	listeners: new Set<() => void>(),
}).get();

function changed(): void {
	notifyListeners(state.listeners);
}

export function runningForegroundShells(): ForegroundShell[] {
	return [...state.running];
}

export function subscribeForegroundShells(listener: () => void): () => void {
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}

export function detachAll(reason: DetachReason, options: { owner?: string; now?: number } = {}): number {
	const now = options.now ?? Date.now();
	const shells = runningForegroundShells().filter(
		(shell) =>
			now - shell.startedAt >= FOREGROUND_TASK_AFTER_MS &&
			(options.owner === undefined || shell.owner === options.owner),
	);
	for (const shell of shells) shell.detach(reason);
	return shells.length;
}

export class ShellDetachedError extends Error {
	readonly job: BackgroundJobInfo;
	readonly reason: DetachReason;
	readonly timeout?: number;
	constructor(job: BackgroundJobInfo, reason: DetachReason, timeout?: number) {
		super(`moved to background as ${job.id}`);
		this.job = job;
		this.reason = reason;
		this.timeout = timeout;
	}
}

export interface DetachOptions {
	description?: string;
	owner?: string;
	agentId?: string;
	onExit?: (job: BackgroundJobInfo) => void;
	onStall?: (job: BackgroundJobInfo, tail: string) => void;
	autoBackground?: boolean;
}

export function detachableExec(inner: BackgroundExec, options: DetachOptions = {}): BackgroundExec {
	return (command, cwd, { onData, signal, timeout, env }) => {
		if (signal?.aborted) return Promise.reject(new Error("aborted"));
		const abort = new AbortController();
		const replay: Buffer[] = [];
		let replayBytes = 0;
		let sink: ((data: Buffer) => void) | undefined;
		let attached = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;

		const onAbort = () => abort.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		const run = inner(command, cwd, {
			env,
			signal: abort.signal,
			onData: (data) => {
				if (attached) {
					replay.push(data);
					replayBytes += data.length;
					while (replayBytes > DEFAULT_MAX_BUFFER_BYTES && replay.length > 1) {
						replayBytes -= replay.shift()?.length ?? 0;
					}
					onData(data);
				} else sink?.(data);
			},
		});

		return new Promise((resolve, reject) => {
			const shell: ForegroundShell = {
				id: `f${++nextId}`,
				command,
				startedAt: Date.now(),
				owner: options.owner,
				agentId: options.agentId,
				output: () => Buffer.concat(replay).toString("utf-8"),
				stop: () => abort.abort(),
				detach: (reason, movedAt) => {
					if (!attached) return;
					attached = false;
					release();
					const job = backgroundBashJobs.start({
						command,
						cwd,
						description: options.description,
						owner: options.owner,
						agentId: options.agentId,
						onExit: options.onExit,
						onStall: options.onStall,
						exec: (_command, _cwd, job) => {
							for (const chunk of replay) job.onData(chunk);
							replay.length = 0;
							sink = job.onData;
							if (job.signal?.aborted) abort.abort();
							else job.signal?.addEventListener("abort", () => abort.abort(), { once: true });
							return run;
						},
					});
					reject(new ShellDetachedError(job, reason, movedAt));
				},
			};
			if (timeout !== undefined && timeout > 0) {
				timer = setTimeout(() => {
					if (options.autoBackground !== false) shell.detach("timeout", timeout);
					else {
						timedOut = true;
						abort.abort();
					}
				}, timeout * 1000);
			}
			const release = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (state.running.delete(shell)) changed();
			};
			state.running.add(shell);
			changed();
			run.then(
				(result) => {
					if (!attached) return;
					release();
					resolve(result);
				},
				(err: unknown) => {
					if (!attached) return;
					release();
					// pi's own spelling of a timeout, which its bash tool turns into the result.
					reject(timedOut ? new Error(`timeout:${timeout}`) : err);
				},
			);
		});
	};
}
