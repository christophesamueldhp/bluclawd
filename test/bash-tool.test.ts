import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backgroundBashJobs } from "../ext/_shared/background-bash.ts";
import { formatClaudeDuration } from "../ext/_shared/bash-limits.ts";
import { backgroundStartText, createClaudeBashTool } from "../ext/sandbox/bash-tool.ts";

/** Operations whose runs the test ends; each call is recorded with its timeout. */
function fakeOps() {
	const calls: { command: string; timeout?: number; finish: (code: number) => void; aborted: () => boolean }[] = [];
	const ops: BashOperations = {
		exec: (command, _cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				let aborted = false;
				signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
				onData(Buffer.from(`ran ${command}\n`));
				calls.push({ command, timeout, finish: (code) => resolve({ exitCode: code }), aborted: () => aborted });
			}),
	};
	return { ops, calls };
}

function makeTool(ops: BashOperations, extra: Partial<Parameters<typeof createClaudeBashTool>[0]> = {}) {
	const sent: unknown[] = [];
	const tool = createClaudeBashTool({
		cwd: "/work",
		operations: () => ops,
		refusal: () => undefined,
		sendMessage: (message) => sent.push(message),
		isMain: true,
		sandboxEscape: true,
		...extra,
	});
	return { tool, sent };
}

const ctx = { sessionManager: { getSessionId: () => "main" } } as never;
const text = (result: { content: { type: string; text?: string }[] }) => result.content[0]?.text ?? "";

afterEach(() => {
	vi.unstubAllEnvs();
	for (const job of backgroundBashJobs.list()) backgroundBashJobs.kill(job.id);
});

describe("schema and prompt (Claude Code 2.1.281)", () => {
	it("takes timeout in milliseconds and CC's parameter texts", () => {
		const { tool } = makeTool(fakeOps().ops);
		const props = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
		expect(Object.keys(props)).toEqual([
			"command",
			"timeout",
			"description",
			"run_in_background",
			"dangerouslyDisableSandbox",
		]);
		expect(props.timeout.description).toBe("Optional timeout in milliseconds (max 600000)");
		expect(props.run_in_background.description).toBe("Set to true to run this command in the background.");
		expect(props.dangerouslyDisableSandbox.description).toBe(
			"Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
		);
		expect(props.description.description).toMatch(/^Clear, concise description of what this command does/);
		expect(tool.promptGuidelines).toContain("`timeout` is in milliseconds: default 120000, max 600000.");
		expect(tool.promptGuidelines).toContain(
			"`run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
		);
		expect(tool.description).toContain("timeout in milliseconds");
	});

	it("drops every background path when background tasks are disabled", () => {
		vi.stubEnv("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1");
		const { tool } = makeTool(fakeOps().ops);
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(props.run_in_background).toBeUndefined();
		expect(tool.promptGuidelines?.some((g) => g.includes("run_in_background"))).toBe(false);
	});

	it("honours BASH_DEFAULT_TIMEOUT_MS and never lets the max fall below it", () => {
		vi.stubEnv("BASH_DEFAULT_TIMEOUT_MS", "900000");
		const { tool } = makeTool(fakeOps().ops);
		expect(tool.promptGuidelines).toContain("`timeout` is in milliseconds: default 900000, max 900000.");
	});

	it("leaves dangerouslyDisableSandbox out for a session with nobody to ask", () => {
		const { tool } = makeTool(fakeOps().ops, { sandboxEscape: false });
		expect((tool.parameters as { properties: Record<string, unknown> }).properties.dangerouslyDisableSandbox).toBe(
			undefined,
		);
	});
});

describe("timeouts", () => {
	it("gives the default 120s when the model names none, and converts milliseconds", async () => {
		const { ops, calls } = fakeOps();
		const { tool } = makeTool(ops);
		const run = tool.execute("t1", { command: "echo hi" } as never, undefined, undefined, ctx);
		await vi.waitFor(() => expect(calls.length).toBe(1));
		calls[0].finish(0);
		await run;
		// The foreground timeout is enforced by the detachable wrapper, not handed to the exec.
		expect(calls[0].timeout).toBeUndefined();
	});

	it("moves a command still running at its timeout to the background", async () => {
		const { ops, calls } = fakeOps();
		const { tool } = makeTool(ops);
		const result = await tool.execute(
			"t2",
			{ command: "npm run dev", timeout: 20 } as never,
			undefined,
			undefined,
			ctx,
		);
		expect(text(result)).toMatch(
			/^Command did not complete within its 1s timeout and was moved to the background \(ID: b[0-9a-z]{8}\)\. Output is being written to: .*\. You will be notified when it completes\. To check interim output, use read on that file path\.$/,
		);
		expect(result.details).toMatchObject({ backgroundTaskId: expect.stringMatching(/^b/) });
		expect(calls[0].aborted()).toBe(false);
	});

	it("times a leading sleep out as asked, in Claude Code's duration", async () => {
		const { ops, calls } = fakeOps();
		const { tool } = makeTool(ops);
		const err = await tool
			.execute("t3", { command: "sleep 30", timeout: 20 } as never, undefined, undefined, ctx)
			.catch((e: Error) => e);
		expect((err as Error).message).toMatch(/Command timed out after 0s$/);
		expect(calls[0].aborted()).toBe(true);
	});

	it("runs a run_in_background job with no timeout at all", async () => {
		const { ops, calls } = fakeOps();
		const { tool } = makeTool(ops);
		const result = await tool.execute(
			"t4",
			{ command: "tail -f log", run_in_background: true, timeout: 20 } as never,
			undefined,
			undefined,
			ctx,
		);
		expect(text(result)).toMatch(/^Command running in background with ID: b[0-9a-z]{8}\./);
		await new Promise((r) => setTimeout(r, 60));
		expect(calls[0].timeout).toBeUndefined();
		expect(calls[0].aborted()).toBe(false);
		expect(backgroundBashJobs.get((result.details as { backgroundTaskId: string }).backgroundTaskId)?.owner).toBe(
			"main",
		);
	});

	it("with background tasks off, kills at the timeout instead", async () => {
		vi.stubEnv("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "true");
		const { ops, calls } = fakeOps();
		const { tool } = makeTool(ops);
		const run = tool.execute("t5", { command: "npm run dev", timeout: 5000 } as never, undefined, undefined, ctx);
		await vi.waitFor(() => expect(calls.length).toBe(1));
		// Handed straight to the exec, which kills at it.
		expect(calls[0].timeout).toBe(5);
		calls[0].finish(0);
		await run;
	});

	it("CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS moves the main agent's command sooner, never under 2s", async () => {
		const { autoBackgroundTimeoutMs } = await import("../ext/_shared/bash-limits.ts");
		vi.stubEnv("CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS", "500");
		expect(autoBackgroundTimeoutMs(120_000, { isMain: true, canAutoBackground: true })).toBe(2000);
		expect(autoBackgroundTimeoutMs(120_000, { isMain: false, canAutoBackground: true })).toBe(120_000);
		expect(autoBackgroundTimeoutMs(120_000, { isMain: true, canAutoBackground: false })).toBe(120_000);
	});
});

describe("backgroundStartText (Claude Code's xxn)", () => {
	const job = { id: "b12345678", command: "npm run dev", outputFile: "/tmp/o/b12345678.output" } as never;

	it("names the file and what comes next", () => {
		expect(backgroundStartText(job, { cwd: "/w" })).toBe(
			"Command running in background with ID: b12345678. Output is being written to: /tmp/o/b12345678.output. You will be notified when it completes. To check interim output, use read on that file path.",
		);
	});

	it("says only the first sentence for Ctrl+B", () => {
		expect(backgroundStartText(job, { cwd: "/w", reason: "user" })).toBe(
			"Command was manually backgrounded by user with ID: b12345678. Output is being written to: /tmp/o/b12345678.output.",
		);
	});

	it("explains a move made for a message", () => {
		expect(backgroundStartText(job, { cwd: "/w", reason: "message" })).toMatch(
			/^Command was moved to the background \(ID: b12345678\) so that a message that arrived while it was running can reach you; it was not interrupted\. Output is being written to: /,
		);
	});

	it("warns a synchronous subagent that its jobs end with its final response", () => {
		expect(backgroundStartText(job, { cwd: "/w", endsWithFinalResponse: true })).toContain(
			"it is terminated when you give your final response and no notification can follow that",
		);
	});

	it("adds the cwd hint when the command changes directory", () => {
		const cd = { ...(job as object), command: "cd web && npm run dev" } as never;
		expect(backgroundStartText(cd, { cwd: "/w" })).toMatch(
			/\nSession cwd remains \/w; directory changes made by the backgrounded command do not apply to subsequent commands\.$/,
		);
		expect(backgroundStartText(job, { cwd: "/w" })).not.toContain("Session cwd");
	});
});

describe("formatClaudeDuration (Claude Code's Qt)", () => {
	it.each([
		[0, "0s"],
		[45_000, "45s"],
		[120_000, "2m 0s"],
		[3_905_000, "1h 5m 5s"],
		[59_600, "59s"],
		[119_700, "2m 0s"],
	])("%d → %s", (ms, out) => {
		expect(formatClaudeDuration(ms)).toBe(out);
	});
});
