/**
 * The transcript's tool look: a collapsed tool call is one `⏺ Name(arg)` line
 * with a short `⎿` summary. Expanded views of pi's tools, and every tool without
 * a look here, are pi's own rendering (ADR 0007); bluclawd's own tools, which pi
 * has no renderer for, show their whole output expanded.
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	ReadToolDetails,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type CompactLook,
	compactTool,
	hasPiRenderers,
	type OwnLook,
	outputOf,
	ownTool,
	type TextResult,
} from "../_shared/tool-line.ts";
import { RUNNING_IN_BACKGROUND, wentToBackground } from "../background-bash/bash-tool.ts";

/** A path as the user would type it: relative inside the working directory, `~` for home. */
function displayPath(raw: unknown, cwd: string): string {
	const path = typeof raw === "string" ? raw.replace(/^@/, "") : "";
	if (!path) return "";
	const absolute = resolve(cwd, path);
	const inside = relative(cwd, absolute);
	if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
	const home = homedir();
	return absolute === home || absolute.startsWith(`${home}/`) ? `~${absolute.slice(home.length)}` : absolute;
}

const fileArg = (args: Record<string, unknown>, cwd: string) => displayPath(args.path ?? args.file_path, cwd);

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const lines = (n: number) => count(n, "line", "lines");
const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length);

const read: CompactLook = {
	title: "Read",
	arg: fileArg,
	summary(result) {
		if (result.content.some((block) => block.type === "image")) return "Read image";
		const truncation = (result.details as ReadToolDetails | undefined)?.truncation;
		if (truncation?.truncated && truncation.outputLines !== undefined) return `Read ${lines(truncation.outputLines)}`;
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		// A read stopped by `limit` ends in pi's `[N more lines in file. Use offset=M to continue.]`, not file content.
		const body = text
			.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, "")
			.replace(/\n$/, "");
		return `Read ${lines(lineCount(body))}`;
	},
};

const BASH_TAIL = 3;

const bash: CompactLook = {
	title: "Bash",
	arg: (args) => (typeof args.command === "string" ? args.command : ""),
	summary(result, theme) {
		if (wentToBackground(result.details)) return theme.fg("dim", RUNNING_IN_BACKGROUND);
		const details = result.details as BashToolDetails | undefined;
		let output = outputOf(result);
		// A truncated output ends in pi's `[Showing lines … Full output: <path>]`, not command output.
		if (details?.fullOutputPath) output = output.replace(/\n\n\[[^\n]*Full output: [^\n]*\]$/, "");
		const all = output === "" ? [] : output.split("\n");
		const tail = all.slice(-BASH_TAIL);
		const hidden = (details?.truncation?.truncated ? details.truncation.totalLines : all.length) - tail.length;
		const shown = tail.map((line) => theme.fg("toolOutput", line));
		return hidden > 0 ? [...shown, theme.fg("muted", `… +${lines(hidden)}`)] : shown;
	},
};

/** A search's result lines, without pi's trailing `[… limit reached]` notice or its empty-result sentence. */
function resultLines(result: TextResult, empty: string): string[] {
	const output = outputOf(result).replace(/\n\n\[[^\n]*\]$/, "");
	return output === "" || output === empty ? [] : output.split("\n");
}

/** A path argument as displayPath shows it, or "" for the working directory itself. */
const belowCwd = (path: unknown, cwd: string) =>
	typeof path === "string" && resolve(cwd, path) !== resolve(cwd) ? displayPath(path, cwd) : "";

const where = (path: unknown, cwd: string) => {
	const shown = belowCwd(path, cwd);
	return shown ? ` in ${shown}` : "";
};

/** A search's pattern, then the path it searched when that is not the working directory. */
const patternArg = (args: Record<string, unknown>, cwd: string) =>
	`${typeof args.pattern === "string" ? args.pattern : ""}${where(args.path, cwd)}`;

/** A match is `path:N: text`; a context line around it is `path-N- text`. */
const isMatch = (line: string) => /^.*?([:-])\d+\1 /.exec(line)?.[1] === ":";

const grep: CompactLook = {
	title: "Grep",
	arg: patternArg,
	summary: (result) =>
		`Found ${count(resultLines(result, "No matches found").filter(isMatch).length, "match", "matches")}`,
};

const find: CompactLook = {
	title: "Find",
	arg: patternArg,
	summary: (result) => count(resultLines(result, "No files found matching pattern").length, "file", "files"),
};

const ls: CompactLook = {
	title: "Ls",
	arg: (args, cwd) => belowCwd(args.path, cwd) || ".",
	summary: (result) => count(resultLines(result, "(empty directory)").length, "entry", "entries"),
};

/** Lines a change added and removed, as ` (+2 -1)`; ` (+2)` when what it replaced is unknown, nothing for no change. */
function changed(theme: Theme, added: number, removed?: number): string {
	if (added === 0 && !removed) return "";
	const minus = removed === undefined ? "" : ` ${theme.fg("toolDiffRemoved", `-${removed}`)}`;
	return ` (${theme.fg("toolDiffAdded", `+${added}`)}${minus})`;
}

/** pi's diff marks a changed line `+N text` or `-N text`, its number padded; context and its `...` gap start blank. */
const changedLines = (diff: string, sign: "+" | "-") =>
	diff.split("\n").filter((line) => line.startsWith(sign) && /^. *\d+ /.test(line)).length;

const edit: CompactLook = {
	title: "Edit",
	arg: fileArg,
	tally(result, theme) {
		const diff = (result.details as EditToolDetails | undefined)?.diff ?? "";
		return changed(theme, changedLines(diff, "+"), changedLines(diff, "-"));
	},
};

// write does not know what the file held before, so it counts only what it wrote.
const write: CompactLook = {
	title: "Write",
	arg: fileArg,
	tally: (_result, theme, args) => changed(theme, lineCount(str(args.content).replace(/\n+$/, ""))),
};

const LOOKS: Record<string, CompactLook> = { read, bash, grep, find, ls, edit, write };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const quoted = (value: unknown) => JSON.stringify(str(value));
const detail = (result: { details?: unknown }, key: string): unknown =>
	(result.details as Record<string, unknown> | undefined)?.[key];

const websearch: OwnLook = {
	title: "WebSearch",
	arg: (args) => quoted(args.query),
	summary(result) {
		const results = count(Number(detail(result, "results") ?? 0), "result", "results");
		return detail(result, "answered") ? `Answered, ${results}` : results;
	},
};

const webfetch: OwnLook = {
	title: "WebFetch",
	arg: (args) => {
		const urls = Array.isArray(args.urls) ? args.urls.map(str) : [];
		return urls.length > 1 ? `${urls[0]} +${urls.length - 1}` : (urls[0] ?? "");
	},
	summary(result) {
		const pages = Number(detail(result, "pages") ?? 0);
		const fetched = pages - Number(detail(result, "failed") ?? 0);
		return `Fetched ${fetched === pages ? count(pages, "page", "pages") : `${fetched} of ${count(pages, "page", "pages")}`}`;
	},
};

/** The first line of a result: a tool that answers in one sentence says it there. */
const firstLine = (result: TextResult) => outputOf(result).split("\n")[0];

/** A result that answers in JSON, parsed; undefined when it is not JSON. */
function parsed(result: TextResult): Record<string, unknown> | undefined {
	try {
		return JSON.parse(outputOf(result));
	} catch {
		return undefined;
	}
}

const memory: OwnLook = {
	title: "Memory",
	arg: (args) => `${str(args.action)} ${str(args.name)}`.trim(),
	summary: (result, _theme, args) =>
		args.action === "read" ? `Read ${lines(lineCount(outputOf(result)))}` : firstLine(result),
};

const monitor: OwnLook = {
	title: "Monitor",
	arg: (args) => str(args.description),
	summary(result) {
		const task = /\(task (\S+?),/.exec(outputOf(result))?.[1];
		return task ? `Started task ${task}` : firstLine(result);
	},
};

const task_stop: OwnLook = {
	title: "TaskStop",
	arg: (args) => str(args.task_id) || str(args.shell_id),
	summary: (result) => str(parsed(result)?.message) || firstLine(result),
};

const subagent: OwnLook = {
	title: "Subagent",
	arg: (args) =>
		Array.isArray(args.tasks)
			? count(args.tasks.length, "task", "tasks")
			: Array.isArray(args.chain)
				? `chain of ${count(args.chain.length, "step", "steps")}`
				: str(args.name) || str(args.agent) || str((args.agent as { name?: unknown } | undefined)?.name),
	summary(result, theme) {
		if (detail(result, "deliveryMode") === "background") return theme.fg("dim", "Running in the background");
		// Reports start with a line that says who sent them, not what they say.
		const report = outputOf(result).replace(/^\[Reports? from (the )?subagents? [^\n]*\]\n*/, "");
		return `Reported (${lines(lineCount(report))})`;
	},
};

/** A subagent tool that answers in one sentence: its target, then that sentence. */
const answers = (title: string, key?: string): OwnLook => ({
	title,
	arg: (args) => (key ? str(args[key]) : ""),
	summary: firstLine,
});

const subagent_status: OwnLook = {
	...answers("SubagentStatus", "agent"),
	// Each run it lists is a block with its task and elapsed time under it; no run is one sentence.
	summary: (result) => {
		const output = outputOf(result);
		return output.includes("\n  task: ") ? count(output.split("\n\n").length, "run", "runs") : firstLine(result);
	},
};

const subagent_models: OwnLook = {
	...answers("SubagentModels", "provider"),
	summary(result) {
		const models = parsed(result)?.models;
		return Array.isArray(models) ? count(models.length, "model", "models") : firstLine(result);
	},
};

const OWN_LOOKS: Record<string, OwnLook> = {
	websearch,
	webfetch,
	memory,
	monitor,
	task_stop,
	subagent,
	subagent_message: answers("SubagentMessage", "to"),
	subagent_stop: answers("SubagentStop", "agent"),
	subagent_close: answers("SubagentClose", "agent"),
	subagent_roster: answers("SubagentRoster"),
	subagent_status,
	subagent_models,
};

export default function transcript(pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		const own = OWN_LOOKS[toolName];
		if (own && !hasPiRenderers(base)) return ownTool(own);
		const look = LOOKS[toolName];
		return look && hasPiRenderers(base) ? compactTool(base, look) : base;
	});
}
