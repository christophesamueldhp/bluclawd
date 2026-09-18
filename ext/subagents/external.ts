/**
 * External CLI runners: a def whose `runner` names a command runs that command
 * instead of a pi child (pi-subagents' `runner.type: external-cli`) — another agent
 * CLI such as `claude -p` or `codex exec`, or any script.
 *
 * The def body and the task go to the command on stdin, from a temp file; what it
 * prints is the result. It is a shell command like any other: judged by the parent's
 * rules and mode, run through the sandbox (runHostCommand). What such a child does
 * inside its own process is that tool's business — bluclawd's per-tool gate cannot
 * see into it, which is why the command itself is what gets judged.
 *
 * Nothing pi-specific applies: no tools, fork, resume, steering or nesting.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GatePrompt } from "../permissions/subagent-gate.ts";
import type { AgentRunner } from "./defs.ts";
import { type RunHostCommand, runHostCommand } from "./host-command.ts";
import type { SingleResult } from "./render.ts";

/**
 * POSIX quoting for one argument, only where needed: plain words stay bare so the
 * command reads as the user would write it — a `Bash(codex *)` rule does not match
 * `'codex' 'exec'`. Anything else is single-quoted, reaching the command as written.
 */
export const shellQuote = (arg: string): string =>
	/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;

export interface ExternalRunOptions {
	runner: AgentRunner;
	systemPrompt: string;
	task: string;
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
	cwd: string;
	agent: string;
	prompt?: GatePrompt;
	signal?: AbortSignal;
	timeoutMs?: number;
	runCommand?: RunHostCommand;
}

export async function runExternal(base: SingleResult, opts: ExternalRunOptions): Promise<SingleResult> {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-runner-"));
	const promptFile = join(dir, "prompt.md");
	try {
		writeFileSync(promptFile, [opts.systemPrompt.trim(), `Task: ${opts.task}`].filter(Boolean).join("\n\n"));
		const command = `${[opts.runner.command, ...opts.runner.args].map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
		const run = opts.runCommand ?? runHostCommand;
		const check = await run(command, {
			ctx: opts.ctx,
			cwd: opts.cwd,
			asker: `Subagent "${opts.agent}" runs an external command`,
			prompt: opts.prompt,
			signal: opts.signal,
			timeout: opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : undefined,
		});
		const message = {
			role: "assistant",
			content: [{ type: "text", text: check.output }],
			stopReason: check.outcome === "passed" ? "stop" : "error",
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const model = `external: ${opts.runner.command}`;
		if (check.outcome === "passed") return { ...base, status: "ok", stopReason: "end", model, messages: [message] };
		return {
			...base,
			status: "failed",
			model,
			stopReason: opts.signal?.aborted ? "aborted" : "error",
			errorMessage: `External runner \`${opts.runner.command}\` ${check.outcome === "blocked" ? "was blocked" : "failed"}: ${check.output}`,
			messages: [message],
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
