/**
 * What a run's transcript shows it did, for its Report: the commands it ran and how each ended, as its pi recorded
 * them, never as the run's own text tells it.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sanitizeReportText, textOf, truncateUtf8Safe } from "./results.ts";

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
 * The commands the run ran from `since` (ms) on: its pi's `bash` calls, those its codemode scripts made among them,
 * in order, with how each ended as its tool's result says.
 */
export function commandsRun(entries: readonly SessionEntry[], since: number): RunCommand[] {
	const asked = new Map<string, string>();
	const commands: RunCommand[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || Date.parse(entry.timestamp) < since) continue;
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

/** One line for a run among others, as a batch or chain lists it: how many commands it ran, how many did not exit 0. */
export function checksSummary(tools: readonly string[], commands: readonly RunCommand[]): string {
	if (!tools.includes("bash")) return "Checks: none ran: it had no tool that runs commands.";
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
