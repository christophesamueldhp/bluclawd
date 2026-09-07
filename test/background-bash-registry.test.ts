import { describe, expect, it } from "vitest";
import { type BackgroundExec, BackgroundJobRegistry, describeJobStatus } from "../ext/_shared/background-bash.ts";

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
		const registry = new BackgroundJobRegistry();
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
		const registry = new BackgroundJobRegistry();
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
		const registry = new BackgroundJobRegistry();
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
		expect(seen.length).toBeGreaterThanOrEqual(2);
		expect(seen.flat().at(-1)).toBe("p 1000%");
	});

	it("defaults kind to job and counts events", () => {
		const registry = new BackgroundJobRegistry();
		const job = registry.start({ command: "x", cwd: "/", exec: pendingExec().exec });
		expect(job.kind).toBe("job");
		expect(job.events).toBe(0);
		registry.recordEvent(job.id);
		expect(registry.get(job.id)?.events).toBe(1);
	});

	it("peek returns the buffered output without moving the read cursor", async () => {
		const registry = new BackgroundJobRegistry();
		const job = registry.start({ command: "x", cwd: "/", exec: streamingExec(["one\ntwo\n"], 0) });
		await tick();
		expect(registry.peek(job.id)).toBe("one\ntwo\n");
		expect(registry.read(job.id)?.newOutput).toBe("one\ntwo\n");
	});

	it("kill with a reason records it and describeJobStatus reports it", async () => {
		const registry = new BackgroundJobRegistry();
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
