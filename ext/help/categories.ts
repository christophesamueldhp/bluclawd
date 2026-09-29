/**
 * Grouping for `/help`, by what you are trying to DO rather than where a
 * command is implemented: built-ins and extension commands share one namespace.
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

const CATEGORY_OF: Record<string, CategoryTitle> = {
	// Session
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
	compact: "Session",
	export: "Session",
	import: "Session",
	share: "Session",
	copy: "Session",
	theme: "App",

	// Code & review
	rewind: "Code & review",

	// Model & output
	model: "Model & output",
	"scoped-models": "Model & output",
	llama: "Model & output",

	// Permissions & safety
	trust: "Permissions & safety",

	// Extensions & integrations
	agents: "Extensions & integrations",
	login: "Extensions & integrations",
	logout: "Extensions & integrations",

	// Info & diagnostics
	status: "Info & diagnostics",
	context: "Info & diagnostics",
	tasks: "Info & diagnostics",
	changelog: "Info & diagnostics",
	keybindings: "Info & diagnostics",
	help: "Info & diagnostics",

	// App
	config: "App",
	reload: "App",
};

/** The bucket for anything not in the table above. Rendered last. */
const OTHER_CATEGORY = "Other";

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
