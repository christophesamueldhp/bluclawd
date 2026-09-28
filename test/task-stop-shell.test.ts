import { afterEach, describe, expect, it } from "vitest";
import { type BackgroundExec, backgroundBashJobs, shellTaskStop } from "../ext/_shared/background-bash.ts";
import backgroundBash from "../ext/background-bash/index.ts";

/** An exec that runs until it is aborted. */
const forever: BackgroundExec = (_c, _w, { signal }) =>
	new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
	for (const job of backgroundBashJobs.list()) backgroundBashJobs.kill(job.id);
});

describe("task_stop for shells (Claude Code's TaskStop ownership)", () => {
	it("stops the caller's own shell and answers in Claude Code's JSON", () => {
		const job = backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: "main", exec: forever });
		expect(JSON.parse(shellTaskStop(job.id, { owner: "main" }))).toEqual({
			message: `Successfully stopped task: ${job.id} (npm run dev)`,
			task_id: job.id,
			task_type: "local_bash",
			command: "npm run dev",
		});
		expect(backgroundBashJobs.get(job.id)?.killed).toBe(true);
	});

	it("lets the main session stop a subagent's shell, and tells the subagent", async () => {
		let exited: { stoppedBy?: string } | undefined;
		const job = backgroundBashJobs.start({
			command: "watch",
			cwd: "/",
			owner: "child-session",
			agentId: "child-session",
			exec: forever,
			onExit: (j) => {
				exited = j;
			},
		});
		shellTaskStop(job.id, { owner: "main" });
		await tick();
		expect(exited?.stoppedBy).toBe("main session");
	});

	it("refuses a subagent stopping a shell it does not own", () => {
		const mains = backgroundBashJobs.start({ command: "a", cwd: "/", owner: "main", exec: forever });
		const other = backgroundBashJobs.start({ command: "b", cwd: "/", owner: "c2", agentId: "c2", exec: forever });
		expect(() => shellTaskStop(mains.id, { owner: "c1", agentId: "c1" })).toThrow(
			`Task ${mains.id} is owned by main session; agent c1 cannot stop it.`,
		);
		expect(() => shellTaskStop(other.id, { owner: "c1", agentId: "c1" })).toThrow(
			`Task ${other.id} is owned by c2; agent c1 cannot stop it.`,
		);
	});

	it("does not reach another main session's shells, and says when a task already ended", async () => {
		const foreign = backgroundBashJobs.start({ command: "a", cwd: "/", owner: "other", exec: forever });
		expect(() => shellTaskStop(foreign.id, { owner: "main" })).toThrow(`No task found with ID: ${foreign.id}`);
		const done = backgroundBashJobs.start({
			command: "true",
			cwd: "/",
			owner: "main",
			exec: async () => ({ exitCode: 0 }),
		});
		await tick();
		expect(() => shellTaskStop(done.id, { owner: "main" })).toThrow(
			`Task ${done.id} is not running (status: completed)`,
		);
	});
});

describe("the task_stop tool (registered by background-bash)", () => {
	function taskStop() {
		let tool: any;
		const noop = () => {};
		backgroundBash({
			on: noop,
			registerEntryRenderer: noop,
			registerCommand: noop,
			registerMessageRenderer: noop,
			registerTool: (t: unknown) => {
				tool = t;
			},
		} as any);
		const ctx = { sessionManager: { getSessionId: () => "main" } };
		return (params: Record<string, string>) => tool.execute("call", params, undefined, undefined, ctx);
	}

	it("stops a shell by task_id, or by the deprecated shell_id", async () => {
		const stop = taskStop();
		const a = backgroundBashJobs.start({ command: "a", cwd: "/", owner: "main", exec: forever });
		const b = backgroundBashJobs.start({ command: "b", cwd: "/", owner: "main", exec: forever });
		await stop({ task_id: a.id });
		await stop({ task_id: "", shell_id: b.id });
		expect(backgroundBashJobs.get(a.id)?.killed).toBe(true);
		expect(backgroundBashJobs.get(b.id)?.killed).toBe(true);
	});

	it("rejects a missing id and one that names no shell", async () => {
		const stop = taskStop();
		await expect(stop({})).rejects.toThrow("Missing required parameter: task_id");
		await expect(stop({ task_id: "a0123456789abcdef" })).rejects.toThrow("No task found with ID: a0123456789abcdef");
	});
});
