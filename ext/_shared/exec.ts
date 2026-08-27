/**
 * Process runner for a child commands.
 *
 * pi's `execCommand` takes `{ signal, timeout, cwd }` and nothing else, but the
 * Claude Code hook protocol needs two more things: the event payload delivered
 * on **stdin**, and hook-specific **environment variables**. The fork branch got
 * those by widening pi's `ExecOptions`; this branch cannot edit that file, so
 * hooks bring their own runner instead. It is deliberately the same shape as
 * `HookExec`, so `runHook` cannot tell the difference.
 *
 * Failure policy matches pi's `execCommand` and the hook contract: this never
 * rejects. A spawn error, a timeout, or a kill all resolve to a result the
 * caller reads as "continue" — a broken hook must not take the session down.
 */
import { spawn } from "node:child_process";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

/** pi's ExecOptions plus the two things a hook or statusline command needs. */
export interface ExecWithIoOptions extends ExecOptions {
	/** Payload delivered on the child's stdin. */
	stdin?: string;
	/** Variables layered over the parent environment. */
	env?: Record<string, string>;
}

export async function execWithIo(command: string, args: string[], options?: ExecWithIoOptions): Promise<ExecResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		const child = spawn(command, args, {
			cwd: options?.cwd,
			env: options?.env ? { ...process.env, ...options.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;

		const timer =
			options?.timeout !== undefined
				? setTimeout(() => {
						killed = true;
						child.kill("SIGKILL");
					}, options.timeout)
				: undefined;

		const onAbort = () => {
			killed = true;
			child.kill("SIGKILL");
		};
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		// The child may exit before reading stdin (a hook that ignores its payload
		// is legitimate). That closes the pipe under us, so swallow EPIPE rather
		// than let it surface as an unhandled error event.
		child.stdin?.on("error", () => {});
		if (options?.stdin !== undefined) child.stdin?.end(options.stdin);
		else child.stdin?.end();

		child.on("error", () => {
			options?.signal?.removeEventListener("abort", onAbort);
			finish({ stdout, stderr, code: 1, killed });
		});

		child.on("close", (code) => {
			options?.signal?.removeEventListener("abort", onAbort);
			finish({ stdout, stderr, code: code ?? 1, killed });
		});
	});
}
