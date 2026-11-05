import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PasteEditor } from "../ext/paste/index.ts";
import { attachSuggestions } from "../ext/prompt-assist/editor.ts";
import { attachSkills } from "../ext/skills/editor.ts";
import { waitFor } from "./helpers/wait-for.ts";

const skill: ReturnType<ExtensionAPI["getCommands"]>[number] = {
	name: "skill:review",
	description: "Review the request",
	source: "skill",
	sourceInfo: {
		path: "/project/skills/review/SKILL.md",
		source: "npm:review-pack",
		scope: "project",
		origin: "package",
	},
};

function composer(commands = [skill]) {
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 120 } };
	const theme = {
		borderColor: (s: string) => s,
		selectList: {
			selectedPrefix: (s: string) => s,
			selectedText: (s: string) => s,
			description: (s: string) => s,
			scrollInfo: (s: string) => s,
			noMatch: (s: string) => s,
		},
	};
	const keys = { matches: () => false, getKeys: () => [] };
	const editor = new PasteEditor(tui as never, theme as never, keys as never);
	attachSkills(
		editor,
		() => commands,
		(s) => s,
	);
	editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider([...commands.map(({ name }) => ({ name })), { name: "help" }], "/project"),
	);
	let submitted = "";
	editor.onSubmit = (text) => {
		submitted = text;
	};
	return { editor, submitted: () => submitted };
}

async function choose(editor: PasteEditor) {
	editor.handleInput("/skill:rev");
	await waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
	editor.handleInput("\t");
}

const rendered = (editor: PasteEditor, width = 120) => stripTerminalSequences(editor.render(width).join("\n"));

describe("terminal skill selection", () => {
	it("selects from the existing leading slash menu without submitting, while non-skill commands still submit on Enter", async () => {
		const { editor, submitted } = composer();
		editor.handleInput("/");
		await waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		expect(rendered(editor, 240)).toContain(skill.sourceInfo.path);
		editor.handleInput("\r");
		expect(editor.getText()).toBe("[Skill #1: review]");
		expect(submitted()).toBe("");
		editor.setText("");
		editor.handleInput("/hel");
		editor.handleInput("\t");
		await waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		editor.handleInput("\r");
		expect(submitted()).toBe("/help");
	});

	it("opens the skill menu for a slash in the middle of a request", async () => {
		const { editor } = composer();
		editor.handleInput("please /");
		await waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		expect(rendered(editor, 240)).toContain("/skill:review");
		editor.handleInput("\r");
		expect(editor.getText()).toBe("please [Skill #1: review]");
	});

	it("keeps Tab completion for an inline absolute directory path", async () => {
		const { editor } = composer();
		const directory = `/${tmpdir().split("/")[1]}/`;
		const draft = `read ${directory.slice(0, -1)}`;
		editor.setText(draft);
		editor.handleInput("\t");
		await waitFor(() => expect(editor.getText() !== draft || editor.isShowingAutocomplete()).toBe(true));
		if (editor.isShowingAutocomplete()) {
			expect(rendered(editor, 240)).toContain(directory);
			editor.handleInput("\t");
		}
		expect(editor.getText()).toBe(`read ${directory}`);
		expect(rendered(editor)).not.toContain("Selected skill");
	});

	it("selects in a later line without replacing surrounding text and shows discovered provenance", async () => {
		const { editor } = composer();
		editor.setText("first line\nplease /skill:re after");
		for (let i = 0; i < 6; i++) editor.handleInput("\x1b[D");
		editor.handleInput("v");
		await waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		expect(rendered(editor, 240)).toContain("Project");
		expect(rendered(editor, 240)).toContain("npm:review-pack");
		expect(rendered(editor, 240)).toContain(skill.sourceInfo.path);
		editor.handleInput("\t");
		expect(editor.getText()).toMatch(/^first line\nplease \[Skill #1: review\] after$/);
		expect(rendered(editor, 240)).toContain("Selected skill #1");
		expect(rendered(editor, 240)).toContain(skill.sourceInfo.path);
		for (const width of [12, 40, 120])
			expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("shows each selection's discovered origin and removes only the deleted selection's provenance", async () => {
		const plan: typeof skill = {
			...skill,
			name: "skill:plan",
			sourceInfo: { path: "/user/skills/plan/SKILL.md", source: "local", scope: "user", origin: "top-level" },
		};
		const { editor, submitted } = composer([skill, plan]);
		await choose(editor);
		editor.handleInput("\n");
		editor.handleInput("then /skill:pla");
		await waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
		expect(rendered(editor, 240)).toContain(`User · ${plan.sourceInfo.path}`);
		editor.handleInput("\t");
		const display = rendered(editor, 240);
		expect(display).toContain(`[Skill #1: review]`);
		expect(display).toContain(`[Skill #2: plan]`);
		expect(display).toContain(`Selected skill #1: review · Project · npm:review-pack · ${skill.sourceInfo.path}`);
		expect(display).toContain(`Selected skill #2: plan · User · ${plan.sourceInfo.path}`);
		for (const width of [12, 40, 120])
			expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		editor.handleInput("\x7f");
		expect(rendered(editor, 240)).toContain(skill.sourceInfo.path);
		expect(rendered(editor, 240)).not.toContain(plan.sourceInfo.path);
		editor.handleInput("\r");
		expect(submitted()).toBe("/skill:review\nthen");
	});

	it("preserves a selection while editing surrounding text, but deletion and pasted marker spelling cannot reactivate it", async () => {
		const { editor } = composer();
		editor.handleInput("please ");
		await choose(editor);
		const marker = editor.getText().slice("please ".length);
		editor.handleInput(" after");
		editor.handleInput("\x01");
		editor.handleInput("Now ");
		expect(rendered(editor)).toContain("Selected skill #1");
		editor.handleInput("\x05");
		for (let i = 0; i < 6; i++) editor.handleInput("\x1b[D");
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("Now please  after");
		expect(rendered(editor)).not.toContain("Selected skill");
		editor.handleInput(`\x1b[200~${marker}\x1b[201~`);
		expect(rendered(editor)).not.toContain("Selected skill");
	});

	it("submits selected references, expanded paste, and image markers through the prompt-assist wrapper", async () => {
		const { editor, submitted } = composer();
		const assist = attachSuggestions(
			editor,
			async () => "",
			() => true,
			() => {},
			(s) => s,
		);
		await choose(editor);
		editor.handleInput(" inspect ");
		const paste = "one\ntwo\nthree\nfour";
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		const image = join(mkdtempSync(join(tmpdir(), "skill-editor-")), "pi-clipboard-test.png");
		writeFileSync(image, "image bytes");
		editor.insertTextAtCursor(image);
		expect(editor.getText()).toContain("[Pasted text");
		expect(editor.getText()).toContain("[Image");
		editor.handleInput("\r");
		expect(submitted()).toBe(`/skill:review inspect ${paste}[Image #2]`);
		expect(editor.submittedImages).toEqual([image]);
		expect(rendered(editor)).not.toContain("Selected skill");
		assist.clear();
	});
});
