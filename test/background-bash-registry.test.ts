import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BackgroundExec,
	BackgroundJobRegistry,
	describeJobStatus,
	looksLikePrompt,
	STALL_MS,
	STALL_POLL_MS,
} from "../ext/_shared/background-bash.ts";

type Registry = typeof import("../ext/_shared/background-bash.ts");

/** Two separately-loaded copies of the module, as pi's loader gives two top-level extensions. */
async function twoCopies(): Promise<[Registry, Registry]> {
	const path = new URL("../ext/_shared/background-bash.ts", import.meta.url).pathname;
	const a = (await import(`${path}?copy=a`)) as Registry;
	const b = (await import(`${path}?copy=b`)) as Registry;
	expect(a.BackgroundJobRegistry).not.toBe(b.BackgroundJobRegistry);
	return [a, b];
}

/** An exec that never produces output and resolves when `finish` is called. */
function pendingExec(): { exec: BackgroundExec; finish: (code: number | null) => void } {
	let resolve!: (r: { exitCode: number | null }) => void;
	const done = new Promise<{ exitCode: number | null }>((r) => {
		resolve = r;
	});
	return { exec: () => done, finish: (code) => resolve({ exitCode: code }) };
}

describe("backgroundBashJobs across module copies", () => {
	it("is the same registry in both copies", async () => {
		const [a, b] = await twoCopies();
		const { exec, finish } = pendingExec();
		const job = a.backgroundBashJobs.start({ command: "sleep 1", cwd: "/", exec });
		expect(b.backgroundBashJobs.get(job.id)?.command).toBe("sleep 1");
		finish(0);
	});
});

/** An exec that streams the given chunks then resolves with `code`. */
function streamingExec(chunks: (string | Buffer)[], code: number | null, error?: string): BackgroundExec {
	return async (_command, _cwd, { onData }) => {
		for (const chunk of chunks) onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		if (error) throw new Error(error);
		return { exitCode: code };
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("registry sinks", () => {
	it("delivers whole lines to onLines and the trailing partial line before onExit", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const seen: string[][] = [];
		let exited: string | undefined;
		registry.start({
			command: "x",
			cwd: "/",
			exec: streamingExec(["a\nb", "c\nd"], 0),
			kind: "monitor",
			onLines: (lines) => seen.push(lines),
			onExit: (job) => {
				exited = describeJobStatus(job);
			},
		});
		await tick();
		expect(seen).toEqual([["a"], ["bc"], ["d"]]);
		expect(exited).toBe("exited with code 0");
	});

	it("keeps a multibyte character split across two chunks intact", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const seen: string[][] = [];
		const buf = Buffer.from("héllo\n");
		registry.start({
			command: "x",
			cwd: "/",
			exec: streamingExec([buf.subarray(0, 2), buf.subarray(2)], 0),
			onLines: (lines) => seen.push(lines),
		});
		await tick();
		expect(seen).toEqual([["héllo"]]);
	});

	it("flushes an oversized carry when a bare-\\r stream never emits a newline", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const seen: string[][] = [];
		registry.start({
			command: "x",
			cwd: "/",
			exec: streamingExec(
				Array.from({ length: 1000 }, (_, i) => `\rp ${i + 1}%`),
				0,
			),
			onLines: (lines) => seen.push(lines),
		});
		await tick();
		// One flush from the carry cap while running, one from the exit flush.
		expect(seen.length).toBe(2);
		expect(seen.flat().at(-1)).toBe("p 1000%");
	});

	it("defaults kind to job and counts events for monitors only", () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const job = registry.start({ command: "x", cwd: "/", exec: pendingExec().exec });
		expect(job.kind).toBe("job");
		expect(job.events).toBe(0);
		registry.recordEvent(job.id);
		expect(registry.get(job.id)?.events).toBe(0);
		const monitor = registry.start({ command: "y", cwd: "/", exec: pendingExec().exec, kind: "monitor" });
		registry.recordEvent(monitor.id);
		expect(registry.get(monitor.id)?.events).toBe(1);
	});

	it("survives a throwing sink without double-finishing the job", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		let exits = 0;
		const job = registry.start({
			command: "x",
			cwd: "/",
			exec: streamingExec(["a\n"], 0),
			onLines: () => {
				throw new Error("onLines boom");
			},
			onExit: () => {
				exits++;
				if (exits === 1) throw new Error("onExit boom");
			},
		});
		await tick();
		expect(exits).toBe(1);
		expect(registry.get(job.id)?.exit?.code).toBe(0);
		expect(registry.get(job.id)?.exit?.error).toBeUndefined();
	});

	it("peek returns the buffered output without moving the read cursor", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const job = registry.start({ command: "x", cwd: "/", exec: streamingExec(["one\ntwo\n"], 0) });
		await tick();
		expect(registry.peek(job.id)).toBe("one\ntwo\n");
		expect(registry.read(job.id)?.newOutput).toBe("one\ntwo\n");
	});

	it("peek inside onExit still sees the output at the retention cap", async () => {
		const registry = new BackgroundJobRegistry({ maxFinishedJobs: 1, outputRoot: null });
		let tail: string | undefined;
		registry.start({ command: "a", cwd: "/", exec: streamingExec(["one\n"], 0) });
		await tick();
		registry.start({
			command: "b",
			cwd: "/",
			exec: streamingExec(["two\n"], 0),
			onExit: (job) => {
				tail = registry.peek(job.id);
			},
		});
		await tick();
		expect(tail).toBe("two\n");
	});

	it("kill with a reason records it and describeJobStatus reports it", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const { exec, finish } = pendingExec();
		const job = registry.start({ command: "x", cwd: "/", exec });
		registry.kill(job.id, "too many events");
		finish(null);
		await tick();
		expect(describeJobStatus(registry.get(job.id)!)).toBe("stopped: too many events");
	});
});

describe("describeJobStatus", () => {
	const base = {
		id: "bash_1",
		command: "x",
		cwd: "/",
		startedAt: 0,
		killed: false,
		kind: "job" as const,
		events: 0,
	};
	it("names a timeout in seconds", () => {
		expect(describeJobStatus({ ...base, exit: { code: null, error: "timeout:300", at: 1 } })).toBe(
			"timed out after 300s",
		);
	});
	it("names a plain kill", () => {
		expect(describeJobStatus({ ...base, killed: true, exit: { code: null, at: 1 } })).toBe("killed");
	});
	it("names an error", () => {
		expect(describeJobStatus({ ...base, exit: { code: null, error: "spawn ENOENT", at: 1 } })).toBe(
			"failed: spawn ENOENT",
		);
	});
});

describe("output file", () => {
	it("writes every byte to the job's output file, beyond the memory cap", async () => {
		const { mkdtempSync, readFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const root = mkdtempSync(join(tmpdir(), "bb-out-"));
		const registry = new BackgroundJobRegistry({ outputRoot: root, maxBufferBytes: 4 });
		const job = registry.start({
			command: "x",
			cwd: "/work/dir",
			owner: "sess-1",
			exec: streamingExec(["abc", "def\n"], 0),
		});
		expect(job.id).toMatch(/^b[0-9a-z]{8}$/);
		expect(job.outputFile).toBe(join(root, "-work-dir", "sess-1", "tasks", `${job.id}.output`));
		await registry.waitFor(job.id, 1000);
		// The stream flushes after the job ends.
		await new Promise((r) => setTimeout(r, 20));
		expect(readFileSync(job.outputFile!, "utf-8")).toBe("abcdef\n\n[exited with code 0]\n");
		expect(registry.peek(job.id)).toBe("def\n");
	});

	it("keeps a job memory-only when the output root cannot be created", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: "/dev/null/nope" });
		const job = registry.start({ command: "x", cwd: "/", exec: streamingExec(["a\n"], 0) });
		expect(job.outputFile).toBeUndefined();
		await tick();
		expect(registry.peek(job.id)).toBe("a\n");
	});
});

describe("waitFor, owners and listeners", () => {
	it("resolves on exit, or as the job stands when the timeout passes first", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const { exec, finish } = pendingExec();
		const job = registry.start({ command: "x", cwd: "/", exec });
		expect((await registry.waitFor(job.id, 10))?.exit).toBeUndefined();
		const waiting = registry.waitFor(job.id, 10_000);
		finish(3);
		expect((await waiting)?.exit?.code).toBe(3);
		expect(await registry.waitFor("b99999999", 10)).toBeUndefined();
	});

	it("stops waiting when the signal aborts", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const job = registry.start({ command: "x", cwd: "/", exec: pendingExec().exec });
		const controller = new AbortController();
		const waiting = registry.waitFor(job.id, 60_000, controller.signal);
		controller.abort();
		expect((await waiting)?.exit).toBeUndefined();
	});

	it("lists only the owner's jobs when asked", () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		registry.start({ command: "a", cwd: "/", owner: "p", exec: pendingExec().exec });
		registry.start({ command: "b", cwd: "/", owner: "c", exec: pendingExec().exec });
		expect(registry.list("p").map((j) => j.command)).toEqual(["a"]);
		expect(registry.list().length).toBe(2);
	});

	it("tells listeners about start, kill and exit", async () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		let calls = 0;
		const off = registry.subscribe(() => calls++);
		const { exec, finish } = pendingExec();
		const job = registry.start({ command: "x", cwd: "/", exec });
		registry.kill(job.id);
		finish(null);
		await tick();
		expect(calls).toBe(3);
		off();
	});
});

describe("stall watchdog", () => {
	afterEach(() => vi.useRealTimers());

	/** An exec that writes `output` once and then never ends until finished. */
	function quiet(output: string) {
		let emit!: (s: string) => void;
		let finish!: () => void;
		const exec: BackgroundExec = (_c, _w, { onData }) =>
			new Promise((resolve) => {
				emit = (s) => onData(Buffer.from(s));
				finish = () => resolve({ exitCode: 0 });
				onData(Buffer.from(output));
			});
		return { exec, emit: (s: string) => emit(s), finish: () => finish() };
	}

	it("reads Claude Code's prompt patterns off the last line only", () => {
		for (const prompt of [
			"Proceed? (y/n)",
			"Delete all [Y/n] ",
			"Continue? (yes/no)",
			"Do you want to install these packages? ",
			"Press any key to continue",
			"Press Enter to exit",
			"Continue?",
			"Overwrite? ",
		]) {
			expect(looksLikePrompt(`building...\n${prompt}\n`), prompt).toBe(true);
		}
		expect(looksLikePrompt("Proceed? (y/n)\ncompiled 3 files")).toBe(false);
		expect(looksLikePrompt("listening on :3000")).toBe(false);
	});

	it("reports a shell quiet for 45s on a prompt, once, with its tail, and leaves it running", async () => {
		vi.useFakeTimers();
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const c = quiet("installing\nProceed? (y/n) ");
		const stalls: string[] = [];
		const job = registry.start({ command: "x", cwd: "/", exec: c.exec, onStall: (_j, tail) => stalls.push(tail) });
		await vi.advanceTimersByTimeAsync(STALL_MS);
		expect(stalls).toEqual([]);
		await vi.advanceTimersByTimeAsync(STALL_POLL_MS * 2);
		expect(stalls).toEqual(["installing\nProceed? (y/n) "]);
		await vi.advanceTimersByTimeAsync(STALL_MS * 3);
		expect(stalls.length).toBe(1);
		expect(registry.get(job.id)?.exit).toBeUndefined();
		c.finish();
	});

	it("restarts the clock on new output, and on a quiet tail that is no prompt", async () => {
		vi.useFakeTimers();
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const c = quiet("server listening\n");
		const stalls: string[] = [];
		registry.start({ command: "x", cwd: "/", exec: c.exec, onStall: (_j, tail) => stalls.push(tail) });
		await vi.advanceTimersByTimeAsync(STALL_MS * 3);
		expect(stalls).toEqual([]);
		c.emit("Continue?");
		await vi.advanceTimersByTimeAsync(STALL_MS - STALL_POLL_MS);
		expect(stalls).toEqual([]);
		await vi.advanceTimersByTimeAsync(STALL_MS);
		expect(stalls.length).toBe(1);
		c.finish();
	});

	it("never watches a monitor, and stops watching a job that ended", async () => {
		vi.useFakeTimers();
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const stalls: string[] = [];
		const monitor = quiet("Continue?");
		registry.start({ command: "x", cwd: "/", exec: monitor.exec, kind: "monitor", onStall: () => stalls.push("m") });
		const ended = quiet("Continue?");
		registry.start({ command: "y", cwd: "/", exec: ended.exec, onStall: () => stalls.push("j") });
		ended.finish();
		await vi.advanceTimersByTimeAsync(STALL_MS * 2);
		expect(stalls).toEqual([]);
		monitor.finish();
	});
});
