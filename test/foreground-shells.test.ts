import { describe, expect, it } from "vitest";
import { type BackgroundExec, backgroundBashJobs } from "../ext/_shared/background-bash.ts";
import {
	detachAll,
	detachableExec,
	runningForegroundShells,
	ShellDetachedError,
} from "../ext/_shared/foreground-shells.ts";

/** An exec whose output and exit the test drives. */
function controlled() {
	let emit!: (s: string) => void;
	let finish!: (code: number) => void;
	let aborted = false;
	const exec: BackgroundExec = (_c, _w, { onData, signal }) =>
		new Promise((resolve, reject) => {
			emit = (s) => onData(Buffer.from(s));
			finish = (code) => resolve({ exitCode: code });
			signal?.addEventListener("abort", () => {
				aborted = true;
				reject(new Error("aborted"));
			});
		});
	return { exec, emit: (s: string) => emit(s), finish: (c: number) => finish(c), wasAborted: () => aborted };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("detachableExec", () => {
	it("behaves as the plain exec when nobody detaches it", async () => {
		const c = controlled();
		const seen: string[] = [];
		const run = detachableExec(c.exec)("x", "/", { onData: (d) => seen.push(d.toString()) });
		expect(runningForegroundShells().length).toBe(1);
		c.emit("a\n");
		c.finish(0);
		expect(await run).toEqual({ exitCode: 0 });
		expect(seen).toEqual(["a\n"]);
		expect(runningForegroundShells().length).toBe(0);
	});

	it("hands the live process to the job registry on detach, output and all", async () => {
		const c = controlled();
		let exited: string | undefined;
		const run = detachableExec(c.exec, {
			owner: "s",
			onExit: (job) => {
				exited = job.id;
			},
		})("sleep 9", "/", {
			onData: () => {},
		});
		c.emit("before\n");
		expect(detachAll()).toBe(1);
		const err = await run.catch((e) => e);
		expect(err).toBeInstanceOf(ShellDetachedError);
		const id = (err as ShellDetachedError).job.id;
		expect(backgroundBashJobs.get(id)).toMatchObject({ command: "sleep 9", owner: "s" });
		c.emit("after\n");
		c.finish(0);
		await tick();
		expect(backgroundBashJobs.peek(id)).toBe("before\nafter\n");
		expect(backgroundBashJobs.get(id)?.exit?.code).toBe(0);
		expect(exited).toBe(id);
		expect(c.wasAborted()).toBe(false);
	});

	it("no longer dies with the tool call's signal once detached, but does with task_stop", async () => {
		const c = controlled();
		const controller = new AbortController();
		const run = detachableExec(c.exec)("x", "/", { onData: () => {}, signal: controller.signal });
		detachAll();
		const { job } = (await run.catch((e) => e)) as ShellDetachedError;
		controller.abort();
		expect(c.wasAborted()).toBe(false);
		backgroundBashJobs.kill(job.id);
		await tick();
		expect(c.wasAborted()).toBe(true);
	});

	it("moves a command still running at its timeout to the background instead of killing it", async () => {
		const c = controlled();
		const run = detachableExec(c.exec)("x", "/", { onData: () => {}, timeout: 0.01 });
		const err = (await run.catch((e) => e)) as ShellDetachedError;
		expect(err).toBeInstanceOf(ShellDetachedError);
		expect(err.timeout).toBe(0.01);
		expect(c.wasAborted()).toBe(false);
		backgroundBashJobs.kill(err.job.id);
	});
});
