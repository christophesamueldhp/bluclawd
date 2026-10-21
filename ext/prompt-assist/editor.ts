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
	getSessionName: () => string | undefined = () => undefined,
	isEnabled: () => boolean = () => true,
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
	const canSuggest = () =>
		isEnabled() && atEnd() && !editor.isShowingAutocomplete() && !/^\s*[!/]/.test(editor.getText());
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
	const schedule = (delay = 700) => {
		clear();
		if (!canSuggest()) return;
		const text = editor.getText();
		if (/\[(?:Pasted text|Image) #/.test(text)) return;
		const version = revision;
		timer = setTimeout(async () => {
			if (!eligible()) return;
			const controller = new AbortController();
			request = controller;
			try {
				const value = await generate(text, controller.signal);
				if (controller.signal.aborted || version !== revision || text !== editor.getText() || !eligible()) return;
				draft = text;
				suggestion = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
				render();
			} catch {
				// Suggestions are optional and must never interrupt editing.
			}
		}, delay);
	};

	const baseInput = editor.handleInput.bind(editor);
	editor.handleInput = (data) => {
		if (visible() && (matchesKey(data, "right") || matchesKey(data, "tab"))) {
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
		const name = getSessionName();
		if (name && isIdle() && width >= 12) {
			const title = stripTerminalSequences(name).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
			const label = ` ${truncateToWidth(title, Math.min(60, width - 8), "…")} ─`;
			lines[0] = truncateToWidth(lines[0], width - visibleWidth(label), "") + dim(label);
		}
		if (!editor.focused || !visible()) return lines;
		const row = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		if (row < 0) return lines;
		const cursorIndex = lines[row].indexOf(CURSOR_MARKER);
		const before = lines[row].slice(0, cursorIndex);
		const remaining = Math.max(0, width - visibleWidth(before) - editor.getPaddingX());
		const ghost = stripTerminalSequences(truncateToWidth(suggestion, remaining, ""));
		if (!ghost) return lines;
		const first = [...new Intl.Segmenter().segment(ghost)][0].segment;
		const cursorCell = lines[row].slice(cursorIndex + CURSOR_MARKER.length).trimEnd();
		lines[row] = before + CURSOR_MARKER + cursorCell.replace(" ", dim(first)) + dim(ghost.slice(first.length));
		lines[row] += " ".repeat(Math.max(0, width - visibleWidth(lines[row])));
		return lines;
	};
	return { clear, schedule, refresh: render };
}
