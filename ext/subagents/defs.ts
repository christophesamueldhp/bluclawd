/**
 * Agent definitions, as Claude Code reads them.
 *
 * Markdown files with YAML frontmatter; the body is the child's system prompt.
 * Sources, and who wins a name collision (Claude Code's built-in < user < project):
 *   - built-in: `agents/*.md` shipped next to this module (general-purpose, Explore, Plan)
 *   - user:     `<agentDir>/agents/*.md`
 *   - project:  nearest ancestor `<cwd>/<CONFIG_DIR_NAME>/agents/*.md`, trusted projects only
 *
 * Frontmatter is Claude Code's: tool names are Claude Code's (`Read, Grep, Glob, WebFetch`,
 * `mcp__server`, `Agent(...)`) and are mapped onto this layer's tools when a child is
 * built (see {@link resolveChildTools}). An invalid field is dropped and the agent still
 * loads; a missing name or description, or a name Claude Code rejects, skips the file.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentMemoryScope = "user" | "project" | "local";
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentColor = "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan";
/** Claude Code's `permissionMode` values, as written in a definition. */
export type AgentPermissionMode = "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan";

const MEMORY_SCOPES: readonly AgentMemoryScope[] = ["user", "project", "local"];
const EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"];
const COLORS: readonly AgentColor[] = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];
/** This layer's own mode names are accepted beside Claude Code's. */
const PERMISSION_MODES: Record<string, AgentPermissionMode> = {
	default: "default",
	manual: "default",
	ask: "default",
	acceptEdits: "acceptEdits",
	edits: "acceptEdits",
	auto: "auto",
	dontAsk: "dontAsk",
	bypassPermissions: "bypassPermissions",
	plan: "plan",
};

export type AgentSource = "built-in" | "user" | "project";

export interface AgentDef {
	name: string;
	description: string;
	/** As written: Claude Code tool names. Absent or `*` = every tool a subagent may have. */
	tools?: string[];
	/** As written; applied before `tools`, as in Claude Code. */
	disallowedTools?: string[];
	model?: string;
	/** Stop the child after this many assistant turns; its output is then partial. */
	maxTurns?: number;
	/** Skills whose full content is preloaded into the child's context. */
	skills?: string[];
	/** The parent's MCP servers, by name, the child must have. */
	mcpServers?: string[];
	permissionMode?: AgentPermissionMode;
	memory?: AgentMemoryScope;
	/** Always run in the background. */
	background?: boolean;
	isolation?: "worktree";
	effort?: AgentEffort;
	color?: AgentColor;
	/** Skip the project's context files (CLAUDE.md, AGENTS.md) and the git status. */
	omitClaudeMd?: boolean;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

/** Claude Code's one-shot built-ins: no agent id comes back, so they cannot be continued. */
const ONE_SHOT = new Set(["Explore", "Plan"]);

export function isOneShot(def: Pick<AgentDef, "name">): boolean {
	return ONE_SHOT.has(def.name);
}

function oneOf<T extends string>(raw: unknown, set: readonly T[]): T | undefined {
	return typeof raw === "string" && (set as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/** Built-in defs, shipped next to this module (agents/*.md). */
export function bundledAgentsDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "agents");
}

/**
 * A tools list in either spelling Claude Code writes — `Read, Grep` or `[Read, Grep]` —
 * split on commas that are not inside a specifier's parentheses (`Agent(a, b)`).
 */
function toolList(raw: unknown): string[] | undefined {
	let parts: unknown[];
	if (Array.isArray(raw)) parts = raw;
	else if (typeof raw === "string") {
		parts = [];
		let depth = 0;
		let current = "";
		for (const ch of raw) {
			if (ch === "(") depth++;
			if (ch === ")") depth = Math.max(0, depth - 1);
			if (ch === "," && depth === 0) {
				parts.push(current);
				current = "";
			} else current += ch;
		}
		parts.push(current);
	} else return undefined;
	const list = parts
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

function nameList(raw: unknown): string[] | undefined {
	const parts = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
	const list = parts
		.filter((s): s is string => typeof s === "string")
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

/** A def file's loaded parts, before discovery attaches where it came from. */
export type ParsedDef = Omit<AgentDef, "source" | "filePath">;

/** Parse one def file: its parts, or the reason it would not load. */
export function parseDef(content: string): ParsedDef | { name?: string; problem: string } {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		return {
			problem: `the frontmatter is not valid YAML (${error instanceof Error ? error.message : String(error)})`,
		};
	}

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim().normalize("NFKC") : "";
	if (!name) return { problem: "the frontmatter declares no name:" };
	if (name.startsWith("-")) return { name, problem: "names must not start with '-'" };
	if (name.includes(":")) return { name, problem: "names must not contain ':' (reserved for plugin namespacing)" };
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!description.trim()) return { name, problem: "missing required 'description' in frontmatter" };

	const maxTurns =
		typeof frontmatter.maxTurns === "number" && Number.isInteger(frontmatter.maxTurns) && frontmatter.maxTurns > 0
			? frontmatter.maxTurns
			: undefined;
	const model =
		typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined;
	const background = frontmatter.background === true || frontmatter.background === "true" ? true : undefined;
	const omitClaudeMd = frontmatter.omitClaudeMd === true || frontmatter.omitClaudeMd === "true" ? true : undefined;
	const permissionMode =
		typeof frontmatter.permissionMode === "string" ? PERMISSION_MODES[frontmatter.permissionMode.trim()] : undefined;

	return compact({
		name,
		description: description.replace(/\\n/g, "\n"),
		tools: toolList(frontmatter.tools),
		disallowedTools: toolList(frontmatter.disallowedTools),
		model: model && model.toLowerCase() === "inherit" ? "inherit" : model,
		maxTurns,
		skills: nameList(frontmatter.skills),
		// Names of servers the parent has; an inline config would start a process no
		// `/mcp approve` covers, so object entries are dropped (Claude Code drops bad items).
		mcpServers: nameList(
			Array.isArray(frontmatter.mcpServers)
				? frontmatter.mcpServers.filter((s) => typeof s === "string")
				: frontmatter.mcpServers,
		),
		permissionMode,
		memory: oneOf(frontmatter.memory, MEMORY_SCOPES),
		background,
		isolation: frontmatter.isolation === "worktree" ? "worktree" : undefined,
		effort: oneOf(frontmatter.effort, EFFORTS),
		color: oneOf(frontmatter.color, COLORS),
		omitClaudeMd,
		systemPrompt: body.trim(),
	});
}

function compact<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function loadDefsFromDir(dir: string, source: AgentSource): AgentDef[] {
	const defs: AgentDef[] = [];
	if (!existsSync(dir)) return defs;
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return defs;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = join(dir, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const parsed = parseDef(content);
		if ("problem" in parsed) continue;
		defs.push({ ...parsed, source, filePath });
	}
	return defs;
}

function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Every def this session can delegate to, merged by name: built-in < user < project.
 * Project defs only for a trusted project — an untrusted repo's agents never reach the model.
 */
export function discoverDefs(cwd: string, trusted: boolean): AgentDef[] {
	const byName = new Map<string, AgentDef>();
	for (const def of loadDefsFromDir(bundledAgentsDir(), "built-in")) byName.set(def.name, def);
	for (const def of loadDefsFromDir(join(getAgentDir(), "agents"), "user")) byName.set(def.name, def);
	const projectDir = trusted ? findNearestProjectAgentsDir(cwd) : null;
	if (projectDir) for (const def of loadDefsFromDir(projectDir, "project")) byName.set(def.name, def);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Claude Code's `uie`: case- and separator-insensitive, so `Code Reviewer` is `code-reviewer`. */
function normalizeType(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
}

/** The def a `subagent_type` names: exact first, then normalised; an ambiguous name is an error. */
export function findDef(defs: AgentDef[], type: string): AgentDef | { error: string } {
	const exact = defs.find((d) => d.name === type);
	if (exact) return exact;
	const wanted = normalizeType(type);
	const matches = defs.filter((d) => normalizeType(d.name) === wanted);
	if (matches.length === 1) return matches[0];
	const available = defs.map((d) => d.name).join(", ") || "none";
	if (matches.length > 1) {
		return {
			error: `Agent type '${type}' is ambiguous — matches ${matches.map((d) => d.name).join(", ")}. Use the exact name: ${matches[0].name}`,
		};
	}
	return { error: `Agent type '${type}' not found. Available agents: ${available}` };
}

/** Claude Code's `(Tools: …)` label for the agent listing. */
export function toolsLabel(def: Pick<AgentDef, "tools" | "disallowedTools">): string {
	const tools = def.tools;
	const denied = def.disallowedTools;
	if (tools && !tools.includes("*")) {
		const remaining = denied ? tools.filter((t) => !denied.includes(t)) : tools;
		return remaining.length > 0 ? remaining.join(", ") : "None";
	}
	if (denied) return `All tools except ${denied.join(", ")}`;
	return tools ? tools.join(", ") : "All tools";
}

// ── Tool names ────────────────────────────────────────────────────────────────

/** Claude Code tool names → this layer's. An empty list: recognised, but no such tool here. */
const CC_TOOLS: Record<string, string[]> = {
	read: ["read"],
	write: ["write"],
	edit: ["edit"],
	multiedit: ["edit"],
	bash: ["bash"],
	grep: ["grep"],
	glob: ["find"],
	find: ["find"],
	ls: ["ls"],
	webfetch: ["webfetch"],
	websearch: ["websearch", "get_search_content", "source_check"],
	agent: ["agent", "send_message"],
	task: ["agent", "send_message"],
	sendmessage: ["send_message"],
	send_message: ["send_message"],
	monitor: ["monitor"],
	taskstop: ["task_stop"],
	task_stop: ["task_stop"],
	get_search_content: ["get_search_content"],
	source_check: ["source_check"],
	notebookedit: [],
	notebookread: [],
	todowrite: [],
	toolsearch: [],
	skill: [],
	lsp: [],
	powershell: [],
	enterworktree: [],
	exitworktree: [],
	artifact: [],
	exitplanmode: [],
	enterplanmode: [],
	askuserquestion: [],
};

export interface ChildTools {
	tools: string[];
	/** Entries that name no tool at all. */
	invalid: string[];
	/** Entries that name a tool, just not one this child can have. */
	unavailable: string[];
}

/** `Bash(git push *)` → `Bash`: a specifier still names the whole tool (Claude Code). */
function toolName(entry: string): string {
	const paren = entry.indexOf("(");
	return (paren > 0 ? entry.slice(0, paren) : entry).trim();
}

/** The tools one entry stands for, out of `pool`; undefined when it names nothing known. */
function expand(entry: string, pool: readonly string[]): string[] | undefined {
	const name = toolName(entry);
	if (name === "*") return [...pool];
	if (name === "mcp__*") return pool.filter((t) => t.startsWith("mcp__"));
	if (name.startsWith("mcp__")) {
		const server = /^mcp__(.+?)(?:__\*)?$/.exec(name)?.[1];
		if (pool.includes(name)) return [name];
		if (server && !server.includes("__")) return pool.filter((t) => t.startsWith(`mcp__${server}__`));
		return [];
	}
	const mapped = CC_TOOLS[name.toLowerCase()];
	if (mapped) return mapped.filter((t) => pool.includes(t));
	return pool.includes(name) ? [name] : undefined;
}

/**
 * The child's tools, Claude Code's way: `disallowedTools` first, then `tools` as an
 * allowlist over what is left (absent or `*`: everything left). `pool` is every tool a
 * subagent may have in this session.
 */
export function resolveChildTools(
	def: Pick<AgentDef, "tools" | "disallowedTools">,
	pool: readonly string[],
): ChildTools {
	const invalid: string[] = [];
	const unavailable: string[] = [];
	const denied = new Set((def.disallowedTools ?? []).flatMap((entry) => expand(entry, pool) ?? []));
	const remaining = pool.filter((t) => !denied.has(t));
	if (!def.tools || def.tools.some((t) => toolName(t) === "*")) return { tools: remaining, invalid, unavailable };
	const tools = new Set<string>();
	for (const entry of def.tools) {
		const found = expand(entry, pool);
		if (found === undefined) invalid.push(entry);
		else if (found.length === 0) unavailable.push(entry);
		for (const tool of found ?? []) if (!denied.has(tool)) tools.add(tool);
	}
	return { tools: [...tools], invalid, unavailable };
}

/** Claude Code's refusal for a def whose tools resolve to nothing. */
export function zeroToolsError(name: string, resolved: ChildTools): string {
	const parts: string[] = [];
	if (resolved.invalid.length > 0) parts.push(`unrecognized [${resolved.invalid.join(", ")}]`);
	if (resolved.unavailable.length > 0) parts.push(`not available to subagents [${resolved.unavailable.join(", ")}]`);
	const why = parts.length > 0 ? parts.join("; ") : "recognized but matched no tools in this session";
	return `Agent '${name}' would be spawned with zero tools — refusing. Its tools list resolved to nothing: ${why}. Fix the agent's tools frontmatter or pass a different subagent_type.`;
}
