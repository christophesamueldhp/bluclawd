import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timed } from "../ext/_shared/timing.ts";

const log = () => join(process.env.PI_CODING_AGENT_DIR as string, "bluclawd", "timing.jsonl");
const records = () =>
	readFileSync(log(), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

type Handler = (...args: unknown[]) => unknown;

/** A stand-in for pi's API: keeps each handler `on` registers, and one other method. */
function stubPi() {
	const handlers = new Map<string, Handler>();
	const unsubscribe = vi.fn();
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return unsubscribe;
		},
		registerCommand: vi.fn(),
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, unsubscribe };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	rmSync(log(), { force: true });
});

describe("timed", () => {
	it("hands back the extension untouched without BLUCLAWD_TIMING=1, and writes nothing", () => {
		const factory = (_pi: ExtensionAPI) => {};
		expect(timed("x", factory)).toBe(factory);
		vi.stubEnv("BLUCLAWD_TIMING", "0");
		expect(timed("x", factory)).toBe(factory);
		expect(existsSync(log())).toBe(false);
	});

	describe("with BLUCLAWD_TIMING=1", () => {
		it("records each handler call as {ext, event, ms, sinceProcessStart}, and passes its result through", () => {
			vi.stubEnv("BLUCLAWD_TIMING", "1");
			const { pi, handlers, unsubscribe } = stubPi();
			let off: unknown;
			timed("perms", (api) => {
				off = api.on("tool_call", (event) => ({ block: true, reason: (event as { toolName: string }).toolName }));
				api.registerCommand("c", { handler: async () => {} });
			})(pi);

			expect(off).toBe(unsubscribe);
			expect(pi.registerCommand).toHaveBeenCalledWith("c", expect.anything());
			const before = performance.now();
			expect(handlers.get("tool_call")?.({ toolName: "read" }, {})).toEqual({ block: true, reason: "read" });

			const [record] = records();
			expect(Object.keys(record).sort()).toEqual(["event", "ext", "ms", "sinceProcessStart"]);
			expect(record).toMatchObject({ ext: "perms", event: "tool_call" });
			expect(record.ms).toBeGreaterThanOrEqual(0);
			expect(record.sinceProcessStart).toBeGreaterThanOrEqual(before);
		});

		it("times an async handler until it settles, and records at its end", async () => {
			vi.stubEnv("BLUCLAWD_TIMING", "1");
			const { pi, handlers } = stubPi();
			timed("ckpt", (api) => {
				api.on("tool_call", () => new Promise((resolve) => setTimeout(() => resolve({ block: true }), 30)));
			})(pi);

			const start = performance.now();
			const pending = handlers.get("tool_call")?.({}, {});
			expect(existsSync(log())).toBe(false);
			await expect(pending).resolves.toEqual({ block: true });
			const end = performance.now();
			const [record] = records();
			expect(record).toMatchObject({ ext: "ckpt", event: "tool_call" });
			expect(record.ms).toBeGreaterThanOrEqual(25);
			expect(record.sinceProcessStart).toBeGreaterThanOrEqual(start + 25);
			expect(record.sinceProcessStart).toBeLessThanOrEqual(end);
		});

		it("still records a handler that throws or rejects, and rethrows the same error", async () => {
			vi.stubEnv("BLUCLAWD_TIMING", "1");
			const { pi, handlers } = stubPi();
			const boom = new Error("boom");
			timed("sbx", (api) => {
				api.on("tool_call", () => {
					throw boom;
				});
				api.on("tool_result", async () => {
					throw boom;
				});
			})(pi);

			expect(() => handlers.get("tool_call")?.({}, {})).toThrow(boom);
			await expect(handlers.get("tool_result")?.({}, {})).rejects.toBe(boom);
			expect(records().map((r) => r.event)).toEqual(["tool_call", "tool_result"]);
		});

		it("is wired into an extension's default export", async () => {
			vi.stubEnv("BLUCLAWD_TIMING", "1");
			vi.resetModules();
			const { default: vibes } = await import("../ext/vibes/index.ts");
			const { pi, handlers } = stubPi();
			vibes(pi);
			handlers.get("before_agent_start")?.({}, { hasUI: false });
			expect(records()).toEqual([expect.objectContaining({ ext: "vibes", event: "before_agent_start" })]);
		});
	});
});
