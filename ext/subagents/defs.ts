/**
 * Agent-definition discovery for in-process subagents (PLAN.md F3.1).
 *
 * Definitions are markdown files with `name` / `description` / optional
 * `tools` (comma-separated) / optional `model` frontmatter; the body is the
 * child's system prompt. Sources, and who wins a name collision:
 *   - bundled: `agents/*.md` shipped next to this module (lowest)
 *   - user:    `<agentDir>/agents/*.md`
 *   - project: nearest ancestor `<cwd>/<CONFIG_DIR_NAME>/agents/*.md` (highest)
 *
 * Adapted from the donor `examples/extensions/subagent/agents.ts`, plus the
 * bundled seeds (the donor had none).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentDef {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	defs: AgentDef[];
	projectAgentsDir: string | null;
}

/** Bundled seed defs, shipped next to this module (agents/*.md). */
export function bundledAgentsDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "agents");
}

/**
 * Render discovered agents for `/agents`, one per line.
 *
 * Origin is derived from the FILE PATH, not from `source`: bundledDefs() tags
 * the shipped seeds as `source: "user"`, so that field cannot tell "ships with
 * bluclawd" from "you wrote this" — and that is the distinction someone reading
 * this list actually wants.
 *
 * An agent with no `tools` frontmatter inherits every tool, which is worth
 * stating outright rather than leaving as a blank column.
 */
/** One `/agents` row, as plain data — the renderer owns padding and colour. */
export interface AgentListRow {
	name: string;
	origin: "project" | "bundled" | "user";
	description: string;
	notes: string;
}

export function agentListRows(defs: AgentDef[], bundledDir: string): AgentListRow[] {
	return defs.map((def) => {
		const notes = [def.tools?.length ? `tools: ${def.tools.join(", ")}` : "all tools"];
		if (def.model) notes.push(`model: ${def.model}`);
		return {
			name: def.name,
			origin: def.source === "project" ? "project" : def.filePath.startsWith(bundledDir) ? "bundled" : "user",
			description: def.description,
			notes: notes.join(" · "),
		};
	});
}

/**
 * Frontmatter `tools` in either spelling Claude Code writes, lowercased.
 *
 * A comma-separated string (`tools: Read, Grep`) and YAML list syntax
 * (`tools: [Read, Grep]`) are both standard; the latter parses to an array.
 * Any other shape returns undefined — "no restriction" — rather than throwing.
 */
function normalizeTools(raw: unknown): string[] | undefined {
	const parts = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : undefined;
	if (!parts) return undefined;
	return parts
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
}

/** A def file's loaded parts, before discovery attaches where it came from. */
export type ParsedDef = Omit<AgentDef, "source" | "filePath">;

/**
 * Parse one def file: its parts, or the reason it would not load.
 *
 * Discovery skips a bad file silently, which is right there and useless to
 * someone who has just saved one — so both paths go through here and the rule
 * cannot drift: what this rejects is exactly what `/agents` will not list.
 */
export function parseDef(content: string): ParsedDef | { name?: string; problem: string } {
	// yaml.parse throws on malformed frontmatter, and with the parse outside a
	// guard one bad file took down the whole directory — every other agent
	// vanished from /agents and from the task tool, behind an error naming no
	// filename.
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

	// A def MUST declare both name and description. The name is trimmed because it
	// is an identity — a map key, a task-tool argument, and the file it is saved as.
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!name) return { problem: "the frontmatter declares no name:" };
	// The name comes back even though the def will not load: it is still what the
	// author called this agent, so a save can file it under that name rather than
	// leaving the very desync between file and identity `name` exists to prevent.
	if (!description.trim()) return { name, problem: "the frontmatter declares no description:" };

	// Lowercase: canonical tool names are lowercase, but Claude Code defs (this
	// fork's migration premise) capitalize them (`tools: Read, Grep, Bash`) —
	// without normalization such a def silently activates ZERO tools (review I3).
	// Accept BOTH spellings Claude Code uses: a comma-separated string and YAML
	// list syntax (`tools: [Read, Grep]`), which parses to an array — calling
	// .split on that threw. Anything else yields no restriction rather than a crash.
	const tools = normalizeTools(frontmatter.tools);

	return {
		name,
		description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		systemPrompt: body,
	};
}

function loadDefsFromDir(dir: string, source: "user" | "project"): AgentDef[] {
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

function findNearestProjectAgentsDir(cwd: string): string | null {
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
 * Discover agent defs for the given scope, merged by name: bundled < user <
 * project, each source overriding the one before it.
 *
 * The bundled seeds used to be an all-or-nothing FALLBACK, loaded only while the
 * user had no defs of their own — so writing a single agent (or customising one
 * shipped agent, which `/agents edit` saves to the user directory) silently
 * dropped every other bundled agent from `/agents` and from the task tool.
 * Overriding a shipped agent by name is the point; deleting its siblings was not.
 */
export function discoverDefs(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const projectDefs = scope === "user" || !projectAgentsDir ? [] : loadDefsFromDir(projectAgentsDir, "project");

	const byName = new Map<string, AgentDef>();
	if (scope !== "project") {
		for (const def of loadDefsFromDir(bundledAgentsDir(), "user")) byName.set(def.name, def);
		for (const def of loadDefsFromDir(userDir, "user")) byName.set(def.name, def);
	}
	for (const def of projectDefs) byName.set(def.name, def);

	return { defs: Array.from(byName.values()), projectAgentsDir };
}
