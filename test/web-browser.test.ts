import { afterEach, describe, expect, it } from "vitest";
import { browseWeb } from "../ext/web/browser.ts";
import { clearContent, listContent, putContent } from "../ext/web/store.ts";

afterEach(() => clearContent());

function fakeCtx(choices: Array<string | ((options: string[]) => string | undefined)>) {
	const calls: Record<string, unknown[]> = { notify: [], editor: [], paste: [] };
	const ui = {
		select: async (_title: string, options: string[]) => {
			const next = choices.shift();
			return typeof next === "function" ? next(options) : next;
		},
		notify: (m: string) => calls.notify.push(m),
		editor: async (title: string, text: string) => {
			calls.editor.push([title, text]);
			return undefined;
		},
		pasteToEditor: (t: string) => calls.paste.push(t),
	};
	return { ctx: { ui } as never, calls };
}

describe("/web", () => {
	it("says so when nothing is stored", async () => {
		const { ctx, calls } = fakeCtx([]);
		await browseWeb("", ctx);
		expect(calls.notify[0]).toMatch(/Nothing fetched/);
	});

	it("lists entries newest first and views, references or pastes the chosen one", async () => {
		putContent("fetch", "https://a.example/", "page A");
		putContent("search", "vitest mocks", "results B");
		let offered: string[] = [];
		const view = fakeCtx([
			(options) => {
				offered = options;
				return options[1];
			},
			"View",
		]);
		await browseWeb("", view.ctx);
		expect(offered[0]).toMatch(/^s2\s+search vitest mocks/);
		expect(view.calls.editor[0]).toEqual(["f1 https://a.example/ (read only: edits are discarded)", "page A"]);

		const ref = fakeCtx([(o) => o[0], "Mention it in the prompt (id only)"]);
		await browseWeb("", ref.ctx);
		expect(ref.calls.paste[0]).toBe("(web content s2: vitest mocks) ");

		const paste = fakeCtx([(o) => o[1], "Paste its text into the prompt"]);
		await browseWeb("", paste.ctx);
		expect(paste.calls.paste[0]).toBe("page A");
	});

	it("clears the store", async () => {
		putContent("fetch", "https://a.example/", "x");
		const { ctx } = fakeCtx([]);
		await browseWeb("clear", ctx);
		expect(listContent()).toEqual([]);
	});
});
