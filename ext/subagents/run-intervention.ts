import { readFileSync } from "node:fs";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { AdmissionContext, RunAdmission, RunExecutionContext } from "./admission.ts";
import { generationState } from "./generation-state.ts";
import { rpcRunMessageText } from "./messages.ts";
import { textOf } from "./results.ts";
import { postToRun, whenGiven } from "./run-mailbox.ts";
import { formatRunLabel, isTerminalSubagentStatus, type SubagentRunRecord, type SubagentRunScheduler } from "./runs.ts";
import { subagentRunDir } from "./storage.ts";

export const RUN_CONVERSATION_ENTRY = "bluclawd:subagent-conversation";

const SHOWN_MESSAGES = 12;
const SHOWN_CHARS = 300;
const NOTED_CHARS = 1000;
const GIVE_WAIT_MS = 5000;

const oneLine = (text: string, max = SHOWN_CHARS) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

type Block = { type?: string; text?: string; name?: string; arguments?: unknown };
function describe(message: { role?: string; content?: unknown; toolName?: string }): string[] {
	if (message.role === "user") return [`user: ${oneLine(textOf(message.content).replace(/^\[[^\n]*\]\n\n/, ""))}`];
	if (message.role === "toolResult") return [`  ${message.toolName ?? "tool"}: ${oneLine(textOf(message.content))}`];
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const text = textOf(message.content);
	return [
		...(text.trim() ? [`assistant: ${oneLine(text)}`] : []),
		...(message.content as Block[])
			.filter((block) => block.type === "toolCall")
			.map((call) => `  → ${call.name}(${oneLine(JSON.stringify(call.arguments ?? {}), 80)})`),
	];
}

export function runConversation(sessionFile: string | undefined): string[] {
	let entries: ReturnType<typeof parseSessionEntries>;
	try {
		entries = sessionFile ? parseSessionEntries(readFileSync(sessionFile, "utf8")) : [];
	} catch {
		entries = [];
	}
	const lines = entries.flatMap((entry) => (entry.type === "message" ? describe(entry.message) : []));
	return lines.length > 0 ? lines.slice(-SHOWN_MESSAGES) : ["(nothing in its session yet)"];
}

export const userInstructionNote = (run: Pick<SubagentRunRecord, "name" | "runId">, text: string) =>
	`The user instructed subagent ${formatRunLabel(run)} directly: ${oneLine(text, NOTED_CHARS)}`;

export interface RunInterventionDeps {
	scheduler: Pick<SubagentRunScheduler<RunExecutionContext>, "getRun" | "whenFinal">;
	admission: Pick<RunAdmission, "resume">;
	agentDir: () => string;
	note(text: string): void;
}

export function createRunIntervention(deps: RunInterventionDeps) {
	const runDirOf = (run: Readonly<SubagentRunRecord>) =>
		subagentRunDir(deps.agentDir(), run.parentSessionId, run.runId);

	const sessionFile = (run: Readonly<SubagentRunRecord>) => {
		const state = generationState(runDirOf(run), run.generation);
		return ("sessionFile" in state ? state.sessionFile : undefined) ?? run.transcriptPath;
	};

	const noteFor = (run: Readonly<SubagentRunRecord>, text: string) => deps.note(userInstructionNote(run, text));

	return {
		conversation(run: Readonly<SubagentRunRecord>): string[] {
			const current = deps.scheduler.getRun(run.runId) ?? run;
			return [
				`${formatRunLabel(current)}: ${current.status}, generation ${current.generation}`,
				...runConversation(sessionFile(current)),
			];
		},

		async instruct(
			run: Readonly<SubagentRunRecord>,
			text: string,
			ctx: AdmissionContext,
		): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
			let current = deps.scheduler.getRun(run.runId) ?? run;
			const name = current.name ?? current.runId;
			if (!isTerminalSubagentStatus(current.status) && current.status !== "stopping") {
				const runDir = runDirOf(current);
				const framed = rpcRunMessageText({ kind: "user" }, current, text);
				const posted = postToRun(runDir, current.generation, framed);
				if (posted.accepted) {
					noteFor(current, text);
					if (current.status === "running") await whenGiven(runDir, current.generation, posted.id, GIVE_WAIT_MS);
					return { ok: true, text: `${name} takes your instruction at its next safe point.` };
				}
			}
			if (!isTerminalSubagentStatus(current.status)) {
				current = (await deps.scheduler.whenFinal(current.runId)) ?? current;
			}
			const resumed = await deps.admission.resume(current, { from: "user", text: () => text }, ctx);
			if (!resumed.ok) return { ok: false, error: resumed.error };
			noteFor(current, text);
			return { ok: true, text: `${name} resumes with your instruction, in the background, once its turn comes.` };
		},
	};
}
