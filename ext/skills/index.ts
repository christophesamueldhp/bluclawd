import { CustomEditor, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Editor } from "@earendil-works/pi-tui";
import { attachSkills } from "./editor.ts";
import { skillPrompt } from "./prompt.ts";

export default function skills(pi: ExtensionAPI) {
	let editor: ReturnType<typeof attachSkills> | undefined;
	let installed: ReturnType<ExtensionUIContext["getEditorComponent"]>;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		if (installed && previous === installed) return;
		const factory: NonNullable<typeof previous> = (tui, theme, keybindings) => {
			const component =
				previous?.(tui, theme, keybindings) ??
				new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
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
		try {
			const text = skillPrompt(event.text, submission.commands, pi.getCommands());
			if (text !== event.text) return { action: "transform", text };
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return { action: "handled" };
		}
	});
}
