/**
 * The set of valid keybinding action names, and the legacy-name migration
 * pi's own loader applies before validating a `keybindings.json`.
 *
 * Vendored from pi's core/keybindings.ts — not part of pi's public package
 * export. Used only by `/doctor`'s `checkKeybindingsShape`, a passive
 * diagnostic: if pi adds a new action name upstream, `/doctor` just won't
 * recognize it as valid until this list is refreshed (a spurious "unknown
 * keybinding action" warning, not a functional break — the real loader,
 * which this doesn't touch, still accepts it). `KEYBINDING_NAME_MIGRATIONS`
 * is append-only history and essentially never changes retroactively.
 *
 * Re-sync against `packages/coding-agent/src/core/keybindings.ts` if
 * `/doctor` starts flagging keybindings that actually work.
 */

/** `Object.keys(KEYBINDINGS)` from pi's core/keybindings.ts. */
export const KNOWN_KEYBINDING_ACTIONS: ReadonlySet<string> = new Set([
	"tui.editor.cursorUp",
	"tui.editor.cursorDown",
	"tui.editor.historyPrevious",
	"tui.editor.historyNext",
	"tui.editor.cursorLeft",
	"tui.editor.cursorRight",
	"tui.editor.cursorWordLeft",
	"tui.editor.cursorWordRight",
	"tui.editor.cursorLineStart",
	"tui.editor.cursorLineEnd",
	"tui.editor.jumpForward",
	"tui.editor.jumpBackward",
	"tui.editor.pageUp",
	"tui.editor.pageDown",
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
	"tui.editor.yank",
	"tui.editor.yankPop",
	"tui.editor.undo",
	"tui.editor.historySearch",
	"tui.input.newLine",
	"tui.input.submit",
	"tui.input.tab",
	"tui.input.copy",
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.altScreen.pageUp",
	"tui.altScreen.pageDown",
	"tui.altScreen.halfPageUp",
	"tui.altScreen.halfPageDown",
	"tui.altScreen.lineUp",
	"tui.altScreen.lineDown",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
	"tui.altScreen.search",
	"tui.altScreen.searchNext",
	"tui.altScreen.searchPrevious",
	"tui.altScreen.searchClose",
	"tui.altScreen.top",
	"tui.altScreen.bottom",
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.session.toggleNamedFilter",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"app.message.dequeue",
	"app.clipboard.pasteImage",
	"app.session.new",
	"app.session.tree",
	"app.session.fork",
	"app.session.resume",
	"app.tree.foldOrUp",
	"app.tree.unfoldOrDown",
	"app.tree.editLabel",
	"app.tree.toggleLabelTimestamp",
	"app.session.togglePath",
	"app.session.toggleSort",
	"app.session.rename",
	"app.session.delete",
	"app.session.deleteNoninvasive",
	"app.models.save",
	"app.models.enableAll",
	"app.models.clearAll",
	"app.models.toggleProvider",
	"app.models.reorderUp",
	"app.models.reorderDown",
	"app.tree.filter.default",
	"app.tree.filter.noTools",
	"app.tree.filter.userOnly",
	"app.tree.filter.labeledOnly",
	"app.tree.filter.all",
	"app.tree.filter.cycleForward",
	"app.tree.filter.cycleBackward",
]);

/** Old key -> current key, for a `keybindings.json` written before a rename. */
const KEYBINDING_NAME_MIGRATIONS: Record<string, string> = {
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	toggleSessionNamedFilter: "app.session.toggleNamedFilter",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	treeFoldOrUp: "app.tree.foldOrUp",
	treeUnfoldOrDown: "app.tree.unfoldOrDown",
	treeEditLabel: "app.tree.editLabel",
	treeToggleLabelTimestamp: "app.tree.toggleLabelTimestamp",
	toggleSessionPath: "app.session.togglePath",
	toggleSessionSort: "app.session.toggleSort",
	renameSession: "app.session.rename",
	deleteSession: "app.session.delete",
	deleteSessionNoninvasive: "app.session.deleteNoninvasive",
};

function orderKeybindingsConfig(config: Record<string, unknown>): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	for (const keybinding of KNOWN_KEYBINDING_ACTIONS) {
		if (Object.hasOwn(config, keybinding)) {
			ordered[keybinding] = config[keybinding];
		}
	}
	const extras = Object.keys(config)
		.filter((key) => !Object.hasOwn(ordered, key))
		.sort();
	for (const key of extras) {
		ordered[key] = config[key];
	}
	return ordered;
}

export function migrateKeybindingsConfig(rawConfig: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: boolean;
} {
	const config: Record<string, unknown> = {};
	let migrated = false;

	for (const [key, value] of Object.entries(rawConfig)) {
		const nextKey = Object.hasOwn(KEYBINDING_NAME_MIGRATIONS, key) ? KEYBINDING_NAME_MIGRATIONS[key] : key;
		if (nextKey !== key) {
			migrated = true;
		}
		if (key !== nextKey && Object.hasOwn(rawConfig, nextKey)) {
			migrated = true;
			continue;
		}
		config[nextKey] = value;
	}

	return { config: orderKeybindingsConfig(config), migrated };
}
