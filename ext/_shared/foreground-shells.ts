/**
 * Ctrl+B: moving the model's running foreground bash into the background
 * (Claude Code parity). The sandbox extension wraps the foreground exec with
 * `detachableExec`; background-bash owns the key and calls `detachAll`. The two
 * load in separate module graphs, so the set of running foreground shells is a
 * sharedRef.
 *
 * Detaching hands the live process to the job registry without restarting it:
 * output produced so far is replayed into the job, later output goes there
 * directly, and the tool call ends with `ShellDetachedError`, which the bash
 * tool turns into its "moved to background" result.
 */

import { type BackgroundExec, type BackgroundJobInfo, backgroundBashJobs } from "./background-bash.ts";
import { sharedRef } from "./global-state.ts";

export interface ForegroundShell {
	command: string;
	startedAt: number;
	/** Moves it to the background; `timeout` (seconds) when its timeout did it. */
	detach(timeout?: number): void;
}

const state = sharedRef("foregroundShells", {
	running: new Set<ForegroundShell>(),
	listeners: new Set<() => void>(),
}).get();

function changed(): void {
	for (const listener of state.listeners) {
		try {
			listener();
		} catch {}
	}
}

export function runningForegroundShells(): ForegroundShell[] {
	return [...state.running];
}

/** Called when a foreground shell starts or stops running here. Returns the unsubscribe. */
export function subscribeForegroundShells(listener: () => void): () => void {
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}

/** Moves every running foreground shell to the background; returns how many moved. */
export function detachAll(): number {
	const shells = runningForegroundShells();
	for (const shell of shells) shell.detach();
	return shells.length;
}

export class ShellDetachedError extends Error {
	readonly job: BackgroundJobInfo;
	/** Set when the foreground timeout moved it, in seconds; absent for Ctrl+B. */
	readonly timeout?: number;
	constructor(job: BackgroundJobInfo, timeout?: number) {
		super(`moved to background as ${job.id}`);
		this.job = job;
		this.timeout = timeout;
	}
}

export interface DetachOptions {
	description?: string;
	owner?: string;
	/** Runs once the job ends, as run_in_background's exit notification does. */
	onExit?: (job: BackgroundJobInfo) => void;
	/** The stall watchdog's notice, which Claude Code also runs on a shell moved to the background. */
	onStall?: (job: BackgroundJobInfo, tail: string) => void;
}

/**
 * `inner` wrapped so the call can be detached mid-flight. The timeout is enforced
 * here rather than handed to `inner`: as in Claude Code, a command still running at
 * its timeout is moved to the background, not killed.
 */
export function detachableExec(inner: BackgroundExec, options: DetachOptions = {}): BackgroundExec {
	return (command, cwd, { onData, signal, timeout, env }) => {
		if (signal?.aborted) return Promise.reject(new Error("aborted"));
		const abort = new AbortController();
		const replay: Buffer[] = [];
		let sink: ((data: Buffer) => void) | undefined;
		let attached = true;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const onAbort = () => abort.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		const run = inner(command, cwd, {
			env,
			signal: abort.signal,
			onData: (data) => {
				if (attached) {
					replay.push(data);
					onData(data);
				} else sink?.(data);
			},
		});

		return new Promise((resolve, reject) => {
			const shell: ForegroundShell = {
				command,
				startedAt: Date.now(),
				detach: (movedAt?: number) => {
					if (!attached) return;
					attached = false;
					release();
					const job = backgroundBashJobs.start({
						command,
						cwd,
						description: options.description,
						owner: options.owner,
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
					reject(new ShellDetachedError(job, movedAt));
				},
			};
			if (timeout !== undefined && timeout > 0) timer = setTimeout(() => shell.detach(timeout), timeout * 1000);
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
					reject(err);
				},
			);
		});
	};
}
