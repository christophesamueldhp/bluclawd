/**
 * How a finished background command is classified, as Claude Code 2.1.281 does it
 * (`xle`/`a6t`/`$2o`): a few commands exit 1 for an answer rather than a failure
 * (grep with no match, diff with a difference), so their exit 1 is `completed` with
 * a note, and only 2 and above fail. The command judged is the last one of a
 * compound command, unless it only runs after `&&`: then an earlier command may be
 * what failed, and the plain rule applies.
 */

export type ExitStatus = "completed" | "failed";

export interface ExitClass {
	status: ExitStatus;
	/** Why a non-zero exit still counts as completed; only ever set on `completed`. */
	note?: string;
}

/** Claude Code gives up on commands past this length (`aD`) and applies the plain rule. */
const MAX_COMMAND_CHARS = 10_000;

const EXIT_ONE_NOTES = new Map([
	["grep", "No matches found"],
	["rg", "No matches found"],
	["egrep", "No matches found"],
	["fgrep", "No matches found"],
	["find", "Some directories were inaccessible"],
	["diff", "Files differ"],
	["test", "Condition is false"],
	["[", "Condition is false"],
]);

const OPERATORS = ["&&", "||", "|&", ";", "|", "&", "\n"];

/**
 * The command's segments between shell operators, quote-aware, and the operator
 * before the last one; undefined when the quoting does not close.
 */
function lastSegment(command: string): { segment: string; before?: string } | undefined {
	let start = 0;
	let before: string | undefined;
	let quote: "'" | '"' | undefined;
	const segments: { text: string; before?: string }[] = [];
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) quote = undefined;
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (c === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
			while (i + 1 < command.length && command[i + 1] !== "\n") i++;
			continue;
		}
		const op = OPERATORS.find((o) => command.startsWith(o, i));
		// `2>&1` and `&>` are redirections, not operators.
		if (op && !(op.startsWith("&") && (command[i - 1] === ">" || command[i + 1] === ">"))) {
			segments.push({ text: command.slice(start, i), before });
			before = op;
			i += op.length - 1;
			start = i + 1;
		}
	}
	if (quote) return undefined;
	segments.push({ text: command.slice(start), before });
	const nonEmpty = segments.filter((s) => s.text.trim() !== "");
	const last = nonEmpty.at(-1);
	return last ? { segment: last.text.trim(), before: last.before } : { segment: "" };
}

/** `git [-C dir] [-c k=v] [--flag] <subcommand>` → the subcommand. */
function gitSubcommand(words: string[]): string | undefined {
	for (let i = 1; i < words.length; i++) {
		const word = words[i];
		if (word.startsWith("-")) {
			if (word === "-C" || word === "-c") i++;
			continue;
		}
		return word;
	}
	return undefined;
}

/** The note an exit-1 answer earns, or undefined when exit 1 is a plain failure. */
function exitOneNote(command: string): string | undefined {
	if (command.length > MAX_COMMAND_CHARS) return undefined;
	const last = lastSegment(command);
	if (!last || last.before === "&&") return undefined;
	const words = last.segment.split(/\s+/).filter(Boolean);
	const name = words[0] ?? "";
	if (name === "git") {
		const sub = gitSubcommand(words);
		if (sub === "grep") return "No matches found";
		if (sub === "diff") return "Files differ";
		return undefined;
	}
	return EXIT_ONE_NOTES.get(name);
}

/**
 * The status of a command that exited on its own (not killed by us). A null code
 * (the shell itself died of a signal) is a failure, as Claude Code's `noExitStatus`.
 */
export function classifyExit(command: string, code: number | null): ExitClass {
	if (code === null) return { status: "failed" };
	if (code === 0) return { status: "completed" };
	if (code === 1) {
		const note = exitOneNote(command);
		if (note) return { status: "completed", note };
	}
	return { status: "failed" };
}

/**
 * The exit code Claude Code reports for a shell that died of a signal: 144 for
 * SIGTERM, 1 for any other. pi resolves no signal name, so every such exit is 1.
 */
export const SIGNAL_EXIT_CODE = 1;
