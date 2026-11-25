import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionFactory, getAgentDir } from "@earendil-works/pi-coding-agent";

type Handler = (...args: unknown[]) => unknown;

let logPath: string | undefined;

const recordIgnoringErrors = (ext: string, event: string, start: number) => {
	const end = performance.now();
	try {
		if (!logPath) {
			const dir = join(getAgentDir(), "bluclawd");
			mkdirSync(dir, { recursive: true });
			logPath = join(dir, "timing.jsonl");
		}
		const line = { pid: process.pid, ext, event, ms: end - start, sinceProcessStart: end };
		appendFileSync(logPath, `${JSON.stringify(line)}\n`);
	} catch {}
};

export function timedCall<T>(ext: string, event: string, fn: () => T): T {
	if (process.env.BLUCLAWD_TIMING !== "1") return fn();
	const start = performance.now();
	try {
		return fn();
	} finally {
		recordIgnoringErrors(ext, event, start);
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
				recordIgnoringErrors(ext, event, start);
				throw error;
			}
			if (result instanceof Promise) return result.finally(() => recordIgnoringErrors(ext, event, start));
			recordIgnoringErrors(ext, event, start);
			return result;
		};

	return (pi) => {
		const on = (event: string, handler: Handler) => pi.on(event as never, timedHandler(event, handler) as never);
		return factory(new Proxy(pi, { get: (target, key) => (key === "on" ? on : Reflect.get(target, key, target)) }));
	};
}
