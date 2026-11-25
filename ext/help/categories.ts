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

	rewind: "Code & review",

	model: "Model & output",
	"scoped-models": "Model & output",
	llama: "Model & output",

	trust: "Permissions & safety",

	"agent-view": "Session",
	"remote-control": "Session",
	accounts: "Extensions & integrations",
	login: "Extensions & integrations",
	logout: "Extensions & integrations",

	status: "Info & diagnostics",
	context: "Info & diagnostics",
	tasks: "Info & diagnostics",
	changelog: "Info & diagnostics",
	keybindings: "Info & diagnostics",
	help: "Info & diagnostics",

	config: "App",
	reload: "App",
};

const OTHER_CATEGORY = "Other";

export interface HelpGroup {
	title: string;
	names: string[];
}

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
