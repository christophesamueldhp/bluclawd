/**
 * What the runtime saw of a Generation, its Evidence, from what it left on disk: its Report and outcome, the
 * commands its transcript shows it ran and how each ended, as its pi recorded them, never as the run's own text tells
 * it, and where it worked and what it changed there, as Git sees it. Facts only: each reader words them its own way.
 */

import { readFileSync } from "node:fs";
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { generationDefinition } from "./generation-state.ts";
import { sanitizeReportText, textOf, truncateUtf8Safe } from "./results.ts";
import { describeWorkspace } from "./run-worktree.ts";
import { readRunReports, type StoredRunReport, storedRunReportTextPath } from "./storage.ts";

/** What the runtime saw of a Generation, apart from its Report's claim. */
export interface GenerationEvidence {
	/** Its Report, with its outcome: the last one stored with its number; none when it stored none. */
	report?: StoredRunReport;
	/** Where its Report's full text is, as its run stored it. */
	reportFile?: string;
	/** The tools it was held to, as its definition stored them; none when that cannot be read. */
	tools: string[];
	/**
	 * The commands its transcript shows it ran, or why they are not known: its transcript could not be read, or its run
	 * was resumed since, both Generations stored before Admission kept when it admitted each.
	 */
	commands: { ran: RunCommand[] } | { unknown: "unreadable" | "resumed" };
	/** A Generation that edits: its worktree, and where it worked and what it changed there, as Git sees it. */
	workspace?: { root: string; lines: string[] };
}

/** A Generation's Report: the last one stored with its number; none when it stored none. */
export function generationReport(runDir: string, generation: number): StoredRunReport | undefined {
	return readRunReports(runDir, 0)
		.filter((report) => report.generation === generation)
		.at(-1);
}

/**
 * What generation `generation` of the run kept in `runDir` left on disk. Its commands are those from its admission to
 * the next Generation's, or to the end of `transcript`, the run's session file. A Generation stored before Admission
 * kept when it admitted it counts them from `startedAt`, its reader's own start for it.
 */
export async function generationEvidence(
	runDir: string,
	generation: number,
	known: { transcript?: string; startedAt?: number },
): Promise<GenerationEvidence> {
	const report = generationReport(runDir, generation);
	const definition = generationDefinition(runDir, generation);
	const next = generationDefinition(runDir, generation + 1);
	const isolated = definition?.workspace;
	const workspace = isolated && { root: isolated.root, lines: await describeWorkspace(isolated, runDir) };
	return {
		...(report ? { report, reportFile: storedRunReportTextPath(runDir, report.seq) } : {}),
		tools: definition?.tools ?? [],
		commands: commandsOf(
			known.transcript,
			definition?.admittedAt ?? (next ? undefined : (known.startedAt ?? 0)),
			next?.admittedAt,
		),
		...(workspace ? { workspace } : {}),
	};
}

/** The commands in `transcript` from `since` on, before `until` when given; unknown when `since` is. */
function commandsOf(
	transcript: string | undefined,
	since: number | undefined,
	until: number | undefined,
): GenerationEvidence["commands"] {
	if (since === undefined) return { unknown: "resumed" };
	const entries = transcript ? sessionFileEntries(transcript) : undefined;
	return entries ? { ran: commandsRun(entries, since, until) } : { unknown: "unreadable" };
}

/** The entries of the run's session, from its file; none before its pi wrote one. */
export function sessionFileEntries(sessionFile: string): SessionEntry[] | undefined {
	try {
		const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
		return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	} catch {
		return undefined;
	}
}

/** A command the run's shell ran, and how it ended. */
export interface RunCommand {
	command: string;
	ended: string;
}

/** How many of its commands a Report lists, the latest; its transcript keeps every one. */
const MAX_LISTED_COMMANDS = 10;
/** How much of one command, or of how it ended, a Report gives. */
const MAX_COMMAND_BYTES = 160;

type Message = { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
type NestedCall = { name?: string; arguments?: { command?: unknown }; status?: string; error?: string };

/**
 * The commands the run ran from `since` (ms) on, and before `until` when given: its pi's `bash` calls, those its
 * codemode scripts made among them, in order, with how each ended as its tool's result says.
 */
export function commandsRun(
	entries: readonly SessionEntry[],
	since: number,
	until = Number.POSITIVE_INFINITY,
): RunCommand[] {
	const asked = new Map<string, string>();
	const commands: RunCommand[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const at = Date.parse(entry.timestamp);
		if (at < since || at >= until) continue;
		const message = entry.message as Message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
				const command = (part.arguments as { command?: unknown } | undefined)?.command;
				if (part.type === "toolCall" && part.name === "bash" && part.id && typeof command === "string")
					asked.set(part.id, command);
			}
		}
		if (message.role !== "toolResult") continue;
		const command = message.toolCallId ? asked.get(message.toolCallId) : undefined;
		if (message.toolName === "bash" && command !== undefined) {
			commands.push({ command, ended: message.isError ? endedBy(textOf(message.content)) : "exit 0" });
		}
		const nested = (message as { nestedCalls?: { calls?: NestedCall[] } }).nestedCalls?.calls ?? [];
		for (const call of nested) {
			if (call.name !== "bash") continue;
			const command = typeof call.arguments?.command === "string" ? call.arguments.command : "(not recorded)";
			// bash fails its result on any exit but 0, so one that did not fail exited 0. pi keeps only the start of a
			// failed one's text, which may have lost its exit code.
			const code = call.status === "error" ? /Command exited with code (\d+)/.exec(call.error ?? "") : null;
			const ended =
				call.status === "ok"
					? "exit 0"
					: call.status === "error"
						? code
							? `exit ${code[1]}`
							: "failed, its exit not recorded"
						: "unfinished";
			commands.push({ command, ended: `${ended}, from codemode` });
		}
	}
	return commands;
}

/** How a failed command ended, from the last line its tool gave. */
function endedBy(text: string): string {
	const last = text.trim().split("\n").at(-1) ?? "";
	const code = /Command exited with code (\d+)$/.exec(last);
	if (code) return `exit ${code[1]}`;
	if (/^Command aborted$/.test(last)) return "aborted";
	return `failed: ${line(last) || "no output"}`;
}

/**
 * One line for a run among others, as a batch or chain lists it: how many commands it ran, how many did not exit 0,
 * or why that is not known.
 */
export function checksSummary({ tools, commands: known }: Pick<GenerationEvidence, "tools" | "commands">): string {
	if ("unknown" in known && known.unknown === "unreadable")
		return "Checks: unknown: its transcript could not be read.";
	if (!tools.includes("bash")) return "Checks: none ran: it had no tool that runs commands.";
	if ("unknown" in known) return "Checks: unknown: its run was resumed since.";
	const commands = known.ran;
	if (commands.length === 0) return "Checks: its transcript shows it ran no commands.";
	const failed = commands.filter(({ ended }) => !ended.startsWith("exit 0")).length;
	return `Checks: its transcript shows ${commands.length} command${commands.length === 1 ? "" : "s"}, ${failed} not ending with exit 0.`;
}

/** One line, bounded. */
function line(text: string): string {
	const flat = sanitizeReportText(text).replace(/\s+/g, " ").trim();
	const { text: cut, truncated } = truncateUtf8Safe(flat, MAX_COMMAND_BYTES);
	return truncated ? `${cut} […]` : cut;
}

/** The checks a run's Report states: those its transcript shows it ran, or why there are none. */
export function checksLines(tools: readonly string[], commands: readonly RunCommand[]): string[] {
	if (!tools.includes("bash"))
		return ["Checks: none ran: it had no tool that runs commands. Any check its text claims is its own claim."];
	if (commands.length === 0)
		return ["Checks: its transcript shows it ran no commands. Any check its text claims is its own claim."];
	const listed = commands.slice(-MAX_LISTED_COMMANDS);
	return [
		`Checks: the commands its transcript shows it ran, ${commands.length}:`,
		...(commands.length > listed.length
			? [`[${commands.length - listed.length} earlier ones not listed here: see its transcript.]`]
			: []),
		...listed.map(({ command, ended }) => `- \`${line(command)}\`: ${ended}`),
	];
}
