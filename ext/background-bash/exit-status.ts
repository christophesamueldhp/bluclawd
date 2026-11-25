type ExitStatus = "completed" | "failed";

export interface ExitClass {
	status: ExitStatus;
	note?: string;
}

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

export function classifyExit(command: string, code: number | null): ExitClass {
	if (code === null) return { status: "failed" };
	if (code === 0) return { status: "completed" };
	if (code === 1) {
		const note = exitOneNote(command);
		if (note) return { status: "completed", note };
	}
	return { status: "failed" };
}

export const SIGNAL_EXIT_CODE = 1;
