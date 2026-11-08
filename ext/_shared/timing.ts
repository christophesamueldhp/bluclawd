/**
 * Opt-in handler timing. pi awaits extension handlers one after another, so a slow one delays
 * every handler after it; with `BLUCLAWD_TIMING=1`, `timed` records each handler call of an
 * extension as a JSONL line `{pid, ext, event, ms, sinceProcessStart}` in
 * `<agentDir>/bluclawd/timing.jsonl`, which every timed pi shares. Without it the extension is returned as is.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionFactory, getAgentDir } from "@earendil-works/pi-coding-agent";

type Handler = (...args: unknown[]) => unknown;

let logPath: string | undefined;

const record = (ext: string, event: string, start: number) => {
	const end = performance.now();
	try {
		if (!logPath) {
			const dir = join(getAgentDir(), "bluclawd");
			mkdirSync(dir, { recursive: true });
			logPath = join(dir, "timing.jsonl");
		}
		const line = { pid: process.pid, ext, event, ms: end - start, sinceProcessStart: end };
		appendFileSync(logPath, `${JSON.stringify(line)}\n`);
	} catch {
		// Timing must never change what the handler does.
	}
};

/** Times `fn` as a handler is timed, for work no handler runs (a timer's). */
export function timedCall<T>(ext: string, event: string, fn: () => T): T {
	if (process.env.BLUCLAWD_TIMING !== "1") return fn();
	const start = performance.now();
	try {
		return fn();
	} finally {
		record(ext, event, start);
	}
}

export function timed(ext: string, factory: ExtensionFactory): ExtensionFactory {
	if (process.env.BLUCLAWD_TIMING !== "1") return factory;

	const timedHandler =
		(event: string, handler: Handler): Handler =>
		(...args) => {
			const start = performance.now();
			let result: unknown;
			try {
				result = handler(...args);
			} catch (error) {
				record(ext, event, start);
				throw error;
			}
			// A sync handler stays sync; an async one is timed until it settles.
			if (result instanceof Promise) return result.finally(() => record(ext, event, start));
			record(ext, event, start);
			return result;
		};

	return (pi) => {
		const on = (event: string, handler: Handler) => pi.on(event as never, timedHandler(event, handler) as never);
		return factory(new Proxy(pi, { get: (target, key) => (key === "on" ? on : Reflect.get(target, key, target)) }));
	};
}
