/**
 * Grouping for `/help` (REVIEW-2026-07 §4.4).
 *
 * ~47 commands in one flat list is a wall, not a surface you can discover
 * anything from. This groups them by what you are trying to DO, not by where
 * they are implemented — a user looking for `/rewind` does not know or care
 * that it comes from an extension while `/fork` is a built-in, so the two
 * appear side by side under Session.
 *
 * Kept as a pure function over names so it can be unit-tested without a TUI,
 * and kept in its own fork-owned file so `slash-commands.ts` needs no category
 * field (it is an upstream file; adding one would be a modifying hunk there).
 *
 * Unknown names are NOT dropped — they fall into "Other", so a command added
 * later still shows up in `/help` before anyone remembers to categorise it.
 */

/** Category titles in display order. */
const CATEGORY_ORDER = [
	"Session",
	"Code & review",
	"Model & output",
	"Permissions & safety",
	"Extensions & integrations",
	"Info & diagnostics",
	"App",
] as const;

type CategoryTitle = (typeof CATEGORY_ORDER)[number];

/**
 * name → category. Built-ins and extension commands share one namespace here
 * on purpose; see the file header.
 */
const CATEGORY_OF: Record<string, CategoryTitle> = {
	// Session
	clear: "Session",
	// pi's own command names. The fork branch renamed these to their Claude Code
	// equivalents by editing pi's built-in table; this branch does not, so the
	// names pi actually ships are the ones that need a category.
	new: "Session",
	session: "Info & diagnostics",
	name: "Session",
	thinking: "Model & output",
	hotkeys: "Info & diagnostics",
	settings: "App",
	quit: "App",
	resume: "Session",
	fork: "Session",
	clone: "Session",
	tree: "Session",
	rename: "Session",
	compact: "Session",
	export: "Session",
	import: "Session",
	share: "Session",
	copy: "Session",
	recap: "Session",
	cost: "Info & diagnostics",

	// Code & review
	rewind: "Code & review",

	// Model & output
	model: "Model & output",
	"scoped-models": "Model & output",
	llama: "Model & output",

	// Permissions & safety
	mode: "Permissions & safety",
	permissions: "Permissions & safety",
	sandbox: "Permissions & safety",
	trust: "Permissions & safety",

	// Extensions & integrations
	mcp: "Extensions & integrations",
	agents: "Extensions & integrations",
	memory: "Extensions & integrations",
	statusline: "Extensions & integrations",
	plugin: "Extensions & integrations",
	login: "Extensions & integrations",
	logout: "Extensions & integrations",

	// Info & diagnostics
	status: "Info & diagnostics",
	usage: "Info & diagnostics",
	context: "Info & diagnostics",
	tasks: "Info & diagnostics",
	changelog: "Info & diagnostics",
	keybindings: "Info & diagnostics",
	help: "Info & diagnostics",

	// App
	config: "App",
	reload: "App",
	exit: "App",
};

/** The bucket for anything not in the table above. Rendered last. */
export const OTHER_CATEGORY = "Other";

export interface HelpGroup {
	title: string;
	/** Command names, in the order they were supplied. */
	names: string[];
}

/**
 * Group command names into display sections.
 *
 * Every input name appears in exactly one output group, and duplicates are
 * collapsed — the caller merges built-ins with extension commands, and an
 * extension may legitimately register a name that shadows a built-in.
 * Empty categories are omitted.
 */
export function categorizeCommands(names: readonly string[]): HelpGroup[] {
	const buckets = new Map<string, string[]>();
	const seen = new Set<string>();

	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		const title = CATEGORY_OF[name] ?? OTHER_CATEGORY;
		const bucket = buckets.get(title);
		if (bucket) bucket.push(name);
		else buckets.set(title, [name]);
	}

	const groups: HelpGroup[] = [];
	for (const title of CATEGORY_ORDER) {
		const names = buckets.get(title);
		if (names?.length) groups.push({ title, names });
	}
	const other = buckets.get(OTHER_CATEGORY);
	if (other?.length) groups.push({ title: OTHER_CATEGORY, names: other });
	return groups;
}
