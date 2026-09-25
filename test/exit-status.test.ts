import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BackgroundExec, BackgroundJobRegistry, jobOutcome } from "../ext/_shared/background-bash.ts";
import { classifyExit } from "../ext/_shared/exit-status.ts";
import { taskExitSummary } from "../ext/_shared/monitor-events.ts";

describe("classifyExit (Claude Code's xle/a6t)", () => {
	it.each([
		["grep foo x", 1, "completed", "No matches found"],
		["rg foo", 1, "completed", "No matches found"],
		["egrep a b", 1, "completed", "No matches found"],
		["fgrep a b", 1, "completed", "No matches found"],
		["find . -name x", 1, "completed", "Some directories were inaccessible"],
		["diff a b", 1, "completed", "Files differ"],
		["test -f x", 1, "completed", "Condition is false"],
		["[ -f x ]", 1, "completed", "Condition is false"],
		["git diff --quiet", 1, "completed", "Files differ"],
		["git -C dir grep foo", 1, "completed", "No matches found"],
		["git -c core.pager=cat diff", 1, "completed", "Files differ"],
		// The last command is the one judged: a pipeline ending in grep.
		["cat f | grep x", 1, "completed", "No matches found"],
		["echo a; grep x f", 1, "completed", "No matches found"],
		// A pipe inside quotes does not split the command.
		['grep "a|b" f', 1, "completed", "No matches found"],
		// After &&, an earlier command may be what failed.
		["cd x && grep y", 1, "failed", undefined],
		["grep foo x", 2, "failed", undefined],
		["npm test", 1, "failed", undefined],
		["git status", 1, "failed", undefined],
		["grep x | sort", 1, "failed", undefined],
		['grep "unclosed', 1, "failed", undefined],
		["grep foo x", 0, "completed", undefined],
		["anything", 0, "completed", undefined],
		["anything", null, "failed", undefined],
		// 2>&1 is a redirection, not a background operator.
		["grep x f 2>&1", 1, "completed", "No matches found"],
	] as const)("%s exit %s → %s", (command, code, status, note) => {
		expect(classifyExit(command, code)).toEqual(note ? { status, note } : { status });
	});

	it("applies the plain rule past 10000 characters", () => {
		expect(classifyExit(`grep ${"x".repeat(10_001)}`, 1)).toEqual({ status: "failed" });
	});
});

describe("background job outcome and summary", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function run(command: string, exec: BackgroundExec, description?: string) {
		const outputRoot = mkdtempSync(join(tmpdir(), "exit-status-"));
		dirs.push(outputRoot);
		const registry = new BackgroundJobRegistry({ outputRoot });
		let done!: () => void;
		const exited = new Promise<void>((r) => {
			done = r;
		});
		const started = registry.start({ command, description, cwd: "/", exec, onExit: () => done() });
		await exited;
		// The trailer is written by the stream's end, after onExit.
		await new Promise((r) => setTimeout(r, 20));
		const job = registry.get(started.id);
		if (!job?.outputFile) throw new Error("no job");
		return { job, file: readFileSync(job.outputFile, "utf-8") };
	}

	it("reports grep's exit 1 as completed with a note", async () => {
		const { job, file } = await run("grep nope f", async () => ({ exitCode: 1 }), "Search f");
		expect(jobOutcome(job)).toEqual({ state: "completed", note: "No matches found" });
		expect(taskExitSummary(job)).toBe('Background command "Search f" completed (exit code 1: No matches found)');
		expect(file).toBe("\n[exited with code 1]\n");
	});

	it("reports a failure with its exit code", async () => {
		const { job } = await run("npm test", async () => ({ exitCode: 2 }));
		expect(taskExitSummary(job)).toBe('Background command "npm test" failed with exit code 2');
	});

	it("reports a shell that died of a signal as failed, with Claude Code's code", async () => {
		const { job, file } = await run("server", async () => ({ exitCode: null }));
		expect(jobOutcome(job).state).toBe("failed");
		expect(job.exit?.noExitStatus).toBe(true);
		expect(taskExitSummary(job)).toBe('Background command "server" failed with exit code 1');
		expect(file).toBe("\n[exited with code 1]\n");
	});

	it("reports a command that could not run as failed without a code", async () => {
		const { job, file } = await run("x", async () => {
			throw new Error("spawn ENOENT");
		});
		expect(taskExitSummary(job)).toBe('Background command "x" failed');
		expect(file).toBe("\n[exited with code unknown]\n");
	});
});
