import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ExtensionAPI,
	getPackageDir,
	type PromptTemplate,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

type Command = ReturnType<ExtensionAPI["getCommands"]>[number];
const { expandPromptTemplate } = (await import(
	pathToFileURL(join(getPackageDir(), "dist/core/prompt-templates.js")).href
)) as {
	expandPromptTemplate(text: string, templates: PromptTemplate[]): string;
};

/** A discovery identity, never a client-authoritative filesystem path. */
export function skillId(command: Command): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				command.name,
				command.sourceInfo.path,
				command.sourceInfo.scope,
				command.sourceInfo.origin,
				command.sourceInfo.source,
			]),
		)
		.digest("hex");
}

/** Resolve selections before loading any instructions; a stale choice cancels the whole prompt. */
export function remoteSkillPrompt(text: string, ids: string[], discovered: Command[]): string {
	const selections = ids.map((id) => {
		const command = discovered.find((command) => command.source === "skill" && skillId(command) === id);
		if (!command) throw new Error("Selected skill is no longer available. Select it again.");
		return command;
	});
	return skillPrompt(text, selections, discovered);
}

/** Shared terminal/phone instruction and reference-directory semantics. */
export function skillPrompt(text: string, selections: Command[], discovered: Command[]): string {
	const blocks: string[] = [];
	const loaded = new Set<string>();
	for (const selection of selections) {
		const command = discovered.find(
			(candidate) =>
				candidate.source === "skill" &&
				candidate.name === selection.name &&
				candidate.sourceInfo.path === selection.sourceInfo.path,
		);
		if (!command)
			throw new Error(
				`Selected skill ${selection.name} is no longer available at ${selection.sourceInfo.path}. Select it again.`,
			);
		const path = command.sourceInfo.path;
		if (loaded.has(path)) continue;
		let body: string;
		try {
			body = stripFrontmatter(readFileSync(path, "utf8")).trim();
		} catch {
			throw new Error(`Cannot load selected skill ${command.name} at ${path}. Submission cancelled.`);
		}
		blocks.push(
			`<skill name="${command.name.slice("skill:".length)}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`,
		);
		loaded.add(path);
	}
	if (!blocks.length) return text.startsWith("/skill:") ? `\n${text}` : text;
	let request = text;
	const name = request.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
	const template = discovered.find((command) => command.source === "prompt" && command.name === name);
	if (template)
		request = expandPromptTemplate(request, [
			{
				name: template.name,
				description: template.description ?? "",
				content: stripFrontmatter(readFileSync(template.sourceInfo.path, "utf8")),
				filePath: template.sourceInfo.path,
				sourceInfo: template.sourceInfo,
			},
		]);
	return `${blocks.join("\n\n")}\n\n${request}`;
}
