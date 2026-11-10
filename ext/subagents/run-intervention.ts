/**
 * The user's own way into a run on pi's RPC, which has no pane to open: its conversation as its session holds it, and
 * an instruction of the user's for it. A working run takes the instruction at its next safe point; a finished one
 * resumes with it, as its next generation, through Admission and the daemon's queue. Either way its orchestrator is
 * told, without being woken.
 */

import { readFileSync } from "node:fs";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { type AdmissionContext, formatRunLabel, type RunAdmission, type RunExecutionContext } from "./admission.ts";
import { readRpcHostState } from "./rpc-host.ts";
import { postToRun, whenGiven } from "./run-mailbox.ts";
import { rpcRunMessageText } from "./run-messages.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord, type SubagentRunScheduler } from "./runs.ts";
import { subagentRunDir } from "./storage.ts";

/** The custom entry that shows a run's conversation in the orchestrator's session, for the user only. */
export const RUN_CONVERSATION_ENTRY = "bluclawd:subagent-conversation";

const SHOWN_MESSAGES = 12;
const SHOWN_CHARS = 300;
/** How much of the user's instruction the orchestrator's note repeats. */
const NOTED_CHARS = 1000;
/** How long the user waits for a working run's host to give the instruction to its pi. */
const GIVE_WAIT_MS = 5000;

const oneLine = (text: string, max = SHOWN_CHARS) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

type Block = { type?: string; text?: string; name?: string; arguments?: unknown };
const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as Block[]).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("")
			: "";

/** One message as the user reads it; the runtime's frame of a message to the run is left out. */
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

/** The latest messages of a run's session, as the user reads them. */
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

export interface RunInterventionDeps {
	scheduler: Pick<SubagentRunScheduler<RunExecutionContext>, "getRun" | "whenFinal">;
	admission: Pick<RunAdmission, "resume">;
	agentDir: () => string;
	/** Tells the orchestrator, without starting a turn of its own. */
	note(text: string): void;
}

export function createRunIntervention(deps: RunInterventionDeps) {
	const runDirOf = (run: Readonly<SubagentRunRecord>) =>
		subagentRunDir(deps.agentDir(), run.parentSessionId, run.runId);

	/** The run's session file: its host's while it works, else the one its last generation ended with. */
	const sessionFile = (run: Readonly<SubagentRunRecord>) =>
		readRpcHostState(runDirOf(run))?.sessionFile ?? run.transcriptPath;

	const noteFor = (run: Readonly<SubagentRunRecord>, text: string) =>
		deps.note(`The user instructed subagent ${formatRunLabel(run)} directly: ${oneLine(text, NOTED_CHARS)}`);

	return {
		/** What the user sees of the run: who it is, how it is, and its latest messages. */
		conversation(run: Readonly<SubagentRunRecord>): string[] {
			const current = deps.scheduler.getRun(run.runId) ?? run;
			return [
				`${formatRunLabel(current)}: ${current.status}, generation ${current.generation}`,
				...runConversation(sessionFile(current)),
			];
		},

		/**
		 * Gives the run the user's instruction: posted to a working run, which takes it at its next safe point; a run
		 * that finished meanwhile, or before, resumes with it once Admission and the queue let it.
		 */
		async instruct(
			run: Readonly<SubagentRunRecord>,
			text: string,
			ctx: AdmissionContext,
		): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
			let current = deps.scheduler.getRun(run.runId) ?? run;
			const name = current.name ?? current.runId;
			// A stopping run takes no more instructions: it resumes with this one once stopped.
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
			// It settled first, or is stopping: its pi is ending, and only a Resume continues its session.
			if (!isTerminalSubagentStatus(current.status)) {
				current = (await deps.scheduler.whenFinal(current.runId)) ?? current;
			}
			const resumed = await deps.admission.resume(current, () => text, ctx, { from: "user" });
			if (!resumed.ok) return { ok: false, error: resumed.error };
			noteFor(current, text);
			return { ok: true, text: `${name} resumes with your instruction, in the background, once its turn comes.` };
		},
	};
}
