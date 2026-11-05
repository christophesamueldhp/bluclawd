import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionUIContext,
	getPackageDir,
	type PromptTemplate,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { Editor } from "@earendil-works/pi-tui";
import { attachSkills } from "./editor.ts";

// Pi has no public expand-template-without-skills switch; reuse its exact argument semantics.
const { expandPromptTemplate } = (await import(
	pathToFileURL(join(getPackageDir(), "dist/core/prompt-templates.js")).href
)) as {
	expandPromptTemplate(text: string, templates: PromptTemplate[]): string;
};

export default function skills(pi: ExtensionAPI) {
	let editor: ReturnType<typeof attachSkills> | undefined;
	let installed: ReturnType<ExtensionUIContext["getEditorComponent"]>;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		if (installed && previous === installed) return;
		const factory: NonNullable<typeof previous> = (tui, theme, keybindings) => {
			const component = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			if (!("getCursor" in component) || !("isShowingAutocomplete" in component)) return component;
			editor = attachSkills(
				component as Editor,
				() => pi.getCommands(),
				(text) => ctx.ui.theme.fg("accent", text),
				(data) => keybindings.matches(data, "app.message.followUp"),
			);
			return component;
		};
		installed = factory;
		ctx.ui.setEditorComponent(factory);
	});

	pi.on("input", (event, ctx) => {
		if (ctx.mode !== "tui" || event.source !== "interactive") return;
		const submission = editor?.takeSubmission(event.text);
		if (!submission) return;
		const discovered = pi.getCommands();
		const blocks: string[] = [];
		const loaded = new Set<string>();
		try {
			for (const selection of submission.commands) {
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
			if (blocks.length > 0) {
				let request = event.text;
				const name = request.match(/^\/([^\s]+)(?:\s|$)/)?.[1];
				const template = discovered.find((command) => command.source === "prompt" && command.name === name);
				if (template) {
					request = expandPromptTemplate(request, [
						{
							name: template.name,
							description: template.description ?? "",
							content: stripFrontmatter(readFileSync(template.sourceInfo.path, "utf8")),
							filePath: template.sourceInfo.path,
							sourceInfo: template.sourceInfo,
						},
					]);
				}
				return { action: "transform", text: `${blocks.join("\n\n")}\n\n${request}` };
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return { action: "handled" };
		}
		// Only a real terminal submission suppresses Pi's legacy leading-skill parser.
		if (event.text.startsWith("/skill:")) return { action: "transform", text: `\n${event.text}` };
	});
}
