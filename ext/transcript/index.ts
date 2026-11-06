/**
 * The transcript's tool look: a collapsed tool call is one `⏺ Name(arg)` line
 * with a short `⎿` summary. Expanded views, and every tool without a look here,
 * are pi's own rendering (ADR 0007).
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { BashToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../../daemon/ansi.ts";
import { type CompactLook, compactTool, hasPiRenderers } from "../_shared/tool-line.ts";
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

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const lines = (n: number) => count(n, "line", "lines");

const read: CompactLook = {
	title: "Read",
	arg: (args, cwd) => displayPath(args.path ?? args.file_path, cwd),
	summary(result) {
		if (result.content.some((block) => block.type === "image")) return "Read image";
		const truncation = (result.details as ReadToolDetails | undefined)?.truncation;
		if (truncation?.truncated && truncation.outputLines !== undefined) return `Read ${lines(truncation.outputLines)}`;
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		// A read stopped by `limit` ends in pi's `[N more lines in file. Use offset=M to continue.]`, not file content.
		const body = text
			.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, "")
			.replace(/\n$/, "");
		return `Read ${lines(body === "" ? 0 : body.split("\n").length)}`;
	},
};

/** A result's text as the terminal shows it: no colour codes or carriage returns, no surrounding blank lines. */
function outputOf(result: { content: { type: string; text?: string }[] }): string {
	const text = result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
	return stripAnsi(text).replace(/\r/g, "").trim();
}

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
function resultLines(result: { content: { type: string; text?: string }[] }, empty: string): string[] {
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

/** A match is `path:N: text`; a context line around it is `path-N- text`. */
const isMatch = (line: string) => /^.*?([:-])\d+\1 /.exec(line)?.[1] === ":";

const grep: CompactLook = {
	title: "Grep",
	arg: (args, cwd) => `${typeof args.pattern === "string" ? args.pattern : ""}${where(args.path, cwd)}`,
	summary: (result) =>
		`Found ${count(resultLines(result, "No matches found").filter(isMatch).length, "match", "matches")}`,
};

const find: CompactLook = {
	title: "Find",
	arg: (args, cwd) => `${typeof args.pattern === "string" ? args.pattern : ""}${where(args.path, cwd)}`,
	summary: (result) => count(resultLines(result, "No files found matching pattern").length, "file", "files"),
};

const ls: CompactLook = {
	title: "Ls",
	arg: (args, cwd) => belowCwd(args.path, cwd) || ".",
	summary: (result) => count(resultLines(result, "(empty directory)").length, "entry", "entries"),
};

// No summary: pi's diff, or the file written, stays under the call line.
const edit: CompactLook = { title: "Edit", arg: (args, cwd) => displayPath(args.path ?? args.file_path, cwd) };
const write: CompactLook = { title: "Write", arg: (args, cwd) => displayPath(args.path ?? args.file_path, cwd) };

const LOOKS: Record<string, CompactLook> = { read, bash, grep, find, ls, edit, write };

export default function transcript(pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const look = LOOKS[toolName];
		const base = next();
		return look && hasPiRenderers(base) ? compactTool(base, look) : base;
	});
}
