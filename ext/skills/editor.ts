import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type Editor,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type Command = ReturnType<ExtensionAPI["getCommands"]>[number];

interface Selection {
	command: Command;
	marker: string;
	start: number;
}

interface Segment {
	segment: string;
	index: number;
	input: string;
}

/** These are the same editor hooks used by the paste extension. */
interface SkillEditorInternals {
	segment(text: string, mode: "grapheme" | "word"): Iterable<Segment>;
	expandPasteMarkers(text: string): string;
	submitValue(): void;
	autocompletePrefix: string;
	tryTriggerAutocomplete(): void;
}

function provenance(command: Command): string {
	const info = command.sourceInfo;
	const scope = info.scope[0].toUpperCase() + info.scope.slice(1);
	return `${scope}${info.origin === "package" ? ` · ${info.source}` : ""} · ${info.path}`;
}

export function attachSkills(
	editor: Editor,
	getCommands: () => Command[],
	accent: (text: string) => string,
	isFollowUp: (data: string) => boolean = () => false,
) {
	const self = editor as unknown as SkillEditorInternals;
	let selections: Selection[] = [];
	let previous = editor.getText();
	let next = 1;
	let pending: Selection | undefined;
	let changed = editor.onChange;
	const submitted: { text: string; commands: Command[] }[] = [];
	let submitting = false;
	const items = new WeakMap<AutocompleteItem, Command>();
	let editCursor: number | undefined;
	const cursorOffset = () => {
		const cursor = editor.getCursor();
		return (
			editor
				.getLines()
				.slice(0, cursor.line)
				.reduce((sum, line) => sum + line.length + 1, 0) + cursor.col
		);
	};
	const edit = (change: () => void) => {
		const before = editCursor;
		editCursor = cursorOffset();
		try {
			change();
		} finally {
			editCursor = before;
		}
	};

	// Preserve identities only outside the edited range, never by recognizing typed marker text.
	Object.defineProperty(editor, "onChange", {
		configurable: true,
		get: () => (text: string) => {
			const afterCursor = editCursor === undefined ? undefined : cursorOffset();
			const prefixEnd =
				editCursor === undefined || afterCursor === undefined ? Infinity : Math.min(editCursor, afterCursor);
			let start = 0;
			while (start < prefixEnd && start < previous.length && start < text.length && previous[start] === text[start])
				start++;
			let oldEnd = previous.length;
			let newEnd = text.length;
			while (
				oldEnd > start &&
				newEnd > start &&
				(editCursor === undefined || oldEnd > editCursor) &&
				(afterCursor === undefined || newEnd > afterCursor) &&
				previous[oldEnd - 1] === text[newEnd - 1]
			) {
				oldEnd--;
				newEnd--;
			}
			selections = selections.filter((selection) => {
				if (selection.start + selection.marker.length <= start) return true;
				if (selection.start >= oldEnd) {
					selection.start += newEnd - oldEnd;
					return true;
				}
				return false;
			});
			if (pending) {
				selections.push(pending);
				pending = undefined;
			}
			previous = text;
			editCursor = undefined;
			changed?.(text);
		},
		set: (callback: typeof editor.onChange) => {
			changed = callback;
		},
	});

	const baseSegment = self.segment.bind(editor);
	self.segment = (text, mode) => {
		const ranges = selections.flatMap(({ marker }) => {
			const start = text.indexOf(marker);
			return start < 0 ? [] : [{ start, end: start + marker.length }];
		});
		const segments: Segment[] = [];
		for (const segment of baseSegment(text, mode)) {
			const range = ranges.find((range) => segment.index >= range.start && segment.index < range.end);
			if (!range) segments.push(segment);
			else if (segment.index === range.start)
				segments.push({ segment: text.slice(range.start, range.end), index: range.start, input: text });
		}
		return segments;
	};

	const baseExpand = self.expandPasteMarkers.bind(editor);
	self.expandPasteMarkers = (text) => {
		let expanded = text;
		for (const selection of [...selections].sort((a, b) => b.start - a.start)) {
			expanded =
				expanded.slice(0, selection.start) +
				`/${selection.command.name}` +
				expanded.slice(selection.start + selection.marker.length);
		}
		expanded = baseExpand(expanded);
		if (submitting)
			submitted.push({
				text: expanded.trim(),
				commands: [...new Map(selections.map(({ command }) => [command.sourceInfo.path, command])).values()],
			});
		return expanded;
	};
	const captureSubmission = (submit: () => void) => {
		submitting = true;
		try {
			submit();
		} finally {
			submitting = false;
		}
	};
	const baseSubmit = self.submitValue.bind(editor);
	self.submitValue = () => captureSubmission(baseSubmit);

	const baseSet = editor.setText.bind(editor);
	editor.setText = (text) => {
		selections = [];
		pending = undefined;
		editCursor = undefined;
		baseSet(text);
	};

	const baseInsert = editor.insertTextAtCursor.bind(editor);
	editor.insertTextAtCursor = (text) => edit(() => baseInsert(text));

	const baseInput = editor.handleInput.bind(editor);
	editor.handleInput = (data) => {
		const before = editor.getText();
		edit(() => {
			if (isFollowUp(data)) captureSubmission(() => baseInput(data));
			else baseInput(data);
		});
		const cursor = editor.getCursor();
		if (
			before !== editor.getText() &&
			!editor.isShowingAutocomplete() &&
			/(?:^|\s)\/[^\s/]*$/.test(editor.getLines()[cursor.line].slice(0, cursor.col))
		)
			self.tryTriggerAutocomplete();
	};

	const baseProvider = editor.setAutocompleteProvider.bind(editor);
	editor.setAutocompleteProvider = (current: AutocompleteProvider) =>
		baseProvider({
			triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "/"])],
			async getSuggestions(lines, line, col, options) {
				const before = lines[line].slice(0, col);
				const match = before.match(/(?:^|\s)(\/[^\s/]*)$/);
				const inline = line > 0 || (match && before.slice(0, before.length - match[1].length).trim().length > 0);
				const commands = getCommands().filter((command) => command.source === "skill");
				const decorate = (item: AutocompleteItem, command: Command) => {
					const decorated = {
						...item,
						description: `${provenance(command)}${command.description ? ` · ${command.description}` : ""}`,
					};
					items.set(decorated, command);
					return decorated;
				};
				if (match && (inline || match[1].startsWith("/skill:"))) {
					const query = match[1].replace(/^\/(?:skill:)?/, "");
					return {
						prefix: match[1],
						items: commands
							.filter((command) => command.name.slice(6).startsWith(query))
							.map((command) => decorate({ value: `/${command.name}`, label: `/${command.name}` }, command)),
					};
				}
				const result = await current.getSuggestions(lines, line, col, options);
				if (!result) return result;
				return {
					...result,
					items: result.items.map((item) => {
						const command = /^\/[^/\s]*$/.test(result.prefix)
							? commands.find((command) => command.name === item.value || `/${command.name}` === item.value)
							: undefined;
						return command ? decorate(item, command) : item;
					}),
				};
			},
			applyCompletion(lines, line, col, item, prefix) {
				editCursor = lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0) + col;
				const command = items.get(item);
				if (!command) return current.applyCompletion(lines, line, col, item, prefix);
				const marker = `[Skill #${next++}: ${command.name.slice("skill:".length)}]`;
				const start = col - prefix.length;
				pending = {
					command,
					marker,
					start: lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0) + start,
				};
				const result = [...lines];
				result[line] = lines[line].slice(0, start) + marker + lines[line].slice(col);
				// Enter chooses a skill without pi's slash-command confirm-and-submit behavior.
				self.autocompletePrefix = "";
				return { lines: result, cursorLine: line, cursorCol: start + marker.length };
			},
			shouldTriggerFileCompletion: (lines, line, col) =>
				current.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
		});

	const baseRender = editor.render.bind(editor);
	editor.render = (width) => {
		const lines = baseRender(width);
		for (const selection of selections) {
			const id = selection.marker.match(/#\d+/)?.[0];
			lines.push(
				...wrapTextWithAnsi(
					accent(`Selected skill ${id}: ${selection.command.name.slice(6)} · ${provenance(selection.command)}`),
					width,
				),
			);
		}
		return lines;
	};

	return {
		takeSubmission(text: string) {
			const index = submitted.findIndex((submission) => submission.text === text);
			return index < 0 ? undefined : submitted.splice(index, 1)[0];
		},
	};
}
