import {
	CURSOR_MARKER,
	type Editor,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export function attachSuggestions(
	editor: Editor,
	generate: (draft: string, signal: AbortSignal) => Promise<string>,
	isIdle: () => boolean,
	render: () => void,
	dim: (text: string) => string,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let request: AbortController | undefined;
	let suggestion = "";
	let draft = "";
	let revision = 0;

	const atEnd = () => {
		const lines = editor.getLines();
		const cursor = editor.getCursor();
		return cursor.line === lines.length - 1 && cursor.col === lines[cursor.line].length;
	};
	const canSuggest = () => atEnd() && !editor.isShowingAutocomplete() && !/^\s*[!/]/.test(editor.getText());
	const eligible = () => isIdle() && canSuggest();
	const visible = () => suggestion && draft === editor.getText() && eligible();
	const clear = () => {
		revision++;
		clearTimeout(timer);
		request?.abort();
		request = undefined;
		suggestion = "";
		render();
	};
	const schedule = () => {
		clear();
		if (!canSuggest()) return;
		const text = editor.getText();
		if (text.length > 2000 || /\[(?:Pasted text|Image) #/.test(text)) return;
		const version = revision;
		timer = setTimeout(async () => {
			if (!eligible()) return;
			const controller = new AbortController();
			request = controller;
			try {
				const value = await generate(text, controller.signal);
				if (controller.signal.aborted || version !== revision || text !== editor.getText() || !eligible()) return;
				draft = text;
				suggestion = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 240);
				render();
			} catch {
				// Suggestions are optional and must never interrupt editing.
			}
		}, 700);
	};

	const baseInput = editor.handleInput.bind(editor);
	editor.handleInput = (data) => {
		if (visible() && matchesKey(data, "tab")) {
			const suffix = suggestion;
			clear();
			editor.insertTextAtCursor(suffix);
			clear();
			return;
		}
		if (visible() && matchesKey(data, "escape")) {
			clear();
			return;
		}
		const before = editor.getText();
		clear();
		baseInput(data);
		if (editor.getText() !== before && editor.getText()) schedule();
	};
	const baseSet = editor.setText.bind(editor);
	editor.setText = (text) => {
		clear();
		baseSet(text);
	};
	const baseInsert = editor.insertTextAtCursor.bind(editor);
	editor.insertTextAtCursor = (text) => {
		clear();
		baseInsert(text);
	};
	const baseRender = editor.render.bind(editor);
	editor.render = (width) => {
		const lines = baseRender(width);
		if (!editor.focused || !visible()) return lines;
		const row = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		if (row < 0) return lines;
		const before = lines[row].split(CURSOR_MARKER)[0];
		const remaining = Math.max(0, width - visibleWidth(before) - editor.getPaddingX());
		const ghost = stripTerminalSequences(truncateToWidth(suggestion, remaining, ""));
		if (!ghost) return lines;
		const first = [...new Intl.Segmenter().segment(ghost)][0].segment;
		lines[row] = before + CURSOR_MARKER + dim(`\x1b[7m${first}\x1b[27m${ghost.slice(first.length)}`);
		lines[row] += " ".repeat(Math.max(0, width - visibleWidth(lines[row])));
		return lines;
	};
	return { clear, schedule };
}
