import { readFileSync } from "node:fs";
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { generationDefinition } from "./generation-state.ts";
import { sanitizeReportText, textOf, truncateUtf8Safe } from "./results.ts";
import type { RunDefinition } from "./rpc-runs.ts";
import { describeWorkspace, worktreeOwner } from "./run-worktree.ts";
import { readRunReports, runDirParentSessionId, type StoredRunReport, storedRunReportTextPath } from "./storage.ts";

export interface GenerationEvidence {
	report?: StoredRunReport;
	reportFile?: string;
	tools: string[];
	commands: { ran: RunCommand[] } | { unknown: "unreadable" | "resumed" };
	workspace?: { root: string; lines: string[] };
}

export function generationReport(runDir: string, generation: number): StoredRunReport | undefined {
	return readRunReports(runDir, 0)
		.filter((report) => report.generation === generation)
		.at(-1);
}

export async function generationEvidence(
	agentDir: string,
	runDir: string,
	generation: number,
	known: { transcript?: string; startForPreAdmittedAtGenerations?: number },
): Promise<GenerationEvidence> {
	const report = generationReport(runDir, generation);
	const definition = generationDefinition(runDir, generation);
	const next = generationDefinition(runDir, generation + 1);
	const isolated = definition?.workspace;
	const owner = isolated && worktreeOwner(isolated, agentDir, runDirParentSessionId(runDir));
	const workspace = owner && { root: isolated.root, lines: await describeWorkspace(isolated, owner.runDir) };
	return {
		...(report ? { report, reportFile: storedRunReportTextPath(runDir, report.seq) } : {}),
		tools: definition?.tools ?? [],
		commands: commandsOf(
			known.transcript,
			betweenAdmissions(definition, next, known.startForPreAdmittedAtGenerations),
		),
		...(workspace ? { workspace } : {}),
	};
}

interface AdmissionSpan {
	since: number | undefined;
	until: number | undefined;
}

const betweenAdmissions = (
	definition: RunDefinition | undefined,
	next: RunDefinition | undefined,
	startForPreAdmittedAtGenerations: number | undefined,
): AdmissionSpan => ({
	since: definition?.admittedAt ?? (next ? undefined : (startForPreAdmittedAtGenerations ?? 0)),
	until: next?.admittedAt,
});

function commandsOf(transcript: string | undefined, { since, until }: AdmissionSpan): GenerationEvidence["commands"] {
	if (since === undefined) return { unknown: "resumed" };
	const entries = transcript ? sessionFileEntries(transcript) : undefined;
	return entries ? { ran: commandsRun(entries, since, until) } : { unknown: "unreadable" };
}

export function sessionFileEntries(sessionFile: string): SessionEntry[] | undefined {
	try {
		const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
		return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	} catch {
		return undefined;
	}
}

export interface RunCommand {
	command: string;
	ended: string;
}

const MAX_LISTED_COMMANDS = 10;
const MAX_COMMAND_BYTES = 160;

type Message = { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
type NestedCall = { name?: string; arguments?: { command?: unknown }; status?: string; error?: string };

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

function endedBy(text: string): string {
	const last = text.trim().split("\n").at(-1) ?? "";
	const code = /Command exited with code (\d+)$/.exec(last);
	if (code) return `exit ${code[1]}`;
	if (/^Command aborted$/.test(last)) return "aborted";
	return `failed: ${line(last) || "no output"}`;
}

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

function line(text: string): string {
	const flat = sanitizeReportText(text).replace(/\s+/g, " ").trim();
	const { text: cut, truncated } = truncateUtf8Safe(flat, MAX_COMMAND_BYTES);
	return truncated ? `${cut} […]` : cut;
}

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
