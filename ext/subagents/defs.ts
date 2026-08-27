/**
 * Agent-definition discovery for in-process subagents (PLAN.md F3.1).
 *
 * Definitions are markdown files with `name` / `description` / optional
 * `tools` (comma-separated) / optional `model` frontmatter; the body is the
 * child's system prompt. Discovery order:
 *   - user:    `<agentDir>/agents/*.md`
 *   - project: nearest ancestor `<cwd>/<CONFIG_DIR_NAME>/agents/*.md`
 *   - bundled: `agents/*.md` shipped next to this module — the fallback used
 *              (in user/both scope) only when the user has no defs of their own.
 *
 * Adapted from the donor `examples/extensions/subagent/agents.ts`, plus the
 * bundled-seed fallback (the donor had none).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../packages/coding-agent/src/config.ts";
import { parseFrontmatter } from "../../../packages/coding-agent/src/utils/frontmatter.ts";

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
export function formatAgentList(defs: AgentDef[], bundledDir: string): string[] {
	const nameWidth = Math.max(0, ...defs.map((def) => def.name.length));
	return defs.map((def) => {
		const origin = def.source === "project" ? "project" : def.filePath.startsWith(bundledDir) ? "bundled" : "user";
		const notes = [def.tools?.length ? `tools: ${def.tools.join(", ")}` : "all tools"];
		if (def.model) notes.push(`model: ${def.model}`);
		return `${def.name.padEnd(nameWidth)}  ${origin.padEnd(7)}  ${def.description}  [${notes.join(" · ")}]`;
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
		// Read AND parse under one guard. yaml.parse throws on malformed
		// frontmatter, and with it outside the try one bad file took down the whole
		// directory — every other agent vanished from /agents and from the task
		// tool, behind an error naming no filename.
		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			const content = readFileSync(filePath, "utf-8");
			const parsed = parseFrontmatter<Record<string, unknown>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch {
			continue;
		}

		// A def MUST declare both name and description; skip anything that doesn't.
		const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
		if (!name || !description) continue;

		// Lowercase: canonical tool names are lowercase, but Claude Code defs (this
		// fork's migration premise) capitalize them (`tools: Read, Grep, Bash`) —
		// without normalization such a def silently activates ZERO tools (review I3).
		// Accept BOTH spellings Claude Code uses: a comma-separated string and YAML
		// list syntax (`tools: [Read, Grep]`), which parses to an array — calling
		// .split on that threw. Anything else yields no restriction rather than a crash.
		const tools = normalizeTools(frontmatter.tools);

		defs.push({
			name,
			description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
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
 * Discover agent defs for the given scope. When the user has no defs of their
 * own (user/both scope), the bundled seeds are loaded as the user set.
 */
export function discoverDefs(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	let userDefs: AgentDef[] = [];
	if (scope !== "project") {
		userDefs = loadDefsFromDir(userDir, "user");
		if (userDefs.length === 0) {
			// Fallback to the bundled seeds when the user has none.
			userDefs = loadDefsFromDir(bundledAgentsDir(), "user");
		}
	}

	const projectDefs = scope === "user" || !projectAgentsDir ? [] : loadDefsFromDir(projectAgentsDir, "project");

	const byName = new Map<string, AgentDef>();
	if (scope === "project") {
		for (const def of projectDefs) byName.set(def.name, def);
	} else {
		for (const def of userDefs) byName.set(def.name, def);
		// Project defs override user defs of the same name in "both" scope.
		for (const def of projectDefs) byName.set(def.name, def);
	}

	return { defs: Array.from(byName.values()), projectAgentsDir };
}
