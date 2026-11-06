/**
 * The transcript's tool look: a collapsed tool call is one `⏺ Name(arg)` line
 * with a short `⎿` summary. Expanded views, and every tool without a look here,
 * are pi's own rendering (ADR 0007).
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { type CompactLook, compactTool, hasPiRenderers } from "../_shared/tool-line.ts";

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

const lines = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;

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

const LOOKS: Record<string, CompactLook> = { read };

export default function transcript(pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const look = LOOKS[toolName];
		const base = next();
		return look && hasPiRenderers(base) ? compactTool(base, look) : base;
	});
}
