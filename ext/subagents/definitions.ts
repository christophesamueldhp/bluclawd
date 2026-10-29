import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_THINKING_LEVELS = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[]);

export function isSubagentThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

export type SubagentModelSpec = "inherit" | `${string}/${string}`;

export function parseSubagentModelSpec(value: string): SubagentModelSpec | undefined {
	const trimmed = value.trim();
	if (trimmed === "inherit") return "inherit";
	return MODEL_SPEC_RE.test(trimmed) ? (trimmed as `${string}/${string}`) : undefined;
}

export type AgentDefinitionSource = "bundled" | "user" | "project" | "inline";

export interface AgentDefinition {
	readonly name: string;
	readonly description: string;
	/** Narrows the orchestrator's tools for this role; omitted means all of them. */
	readonly tools?: readonly string[];
	readonly model: SubagentModelSpec;
	readonly thinkingLevel?: ThinkingLevel;
	readonly instructions: string;
	readonly source: AgentDefinitionSource;
	readonly filePath?: string;
}

export interface InlineAgentRole {
	readonly name: string;
	readonly description: string;
	readonly instructions: string;
	readonly tools?: readonly string[];
	readonly model?: string;
	readonly thinkingLevel?: string;
}

export interface AgentDefinitionCatalog {
	readonly definitions: readonly AgentDefinition[];
	readonly byName: ReadonlyMap<string, AgentDefinition>;
	readonly invalidByName: ReadonlyMap<string, string>;
	readonly diagnostics: readonly string[];
}

export interface DiscoverAgentDefinitionsOptions {
	cwd: string;
	agentDir?: string;
	projectTrusted?: boolean;
}

export type ResolveAgentDefinitionResult =
	| { readonly ok: true; readonly definition: AgentDefinition }
	| { readonly ok: false; readonly error: string };

const SUPPORTED_FRONTMATTER_KEYS = new Set(["name", "description", "tools", "model", "thinkingLevel"]);
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_NAME_PREFIXES = ["sub_", "bg_", "mon_", "agent_", "task_"];
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MODEL_SPEC_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const BUNDLED_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agents");

function deepFreezeDefinition(def: AgentDefinition): AgentDefinition {
	if (def.tools) Object.freeze(def.tools);
	return Object.freeze(def);
}

function hasUnclosedFrontmatter(raw: string): boolean {
	const normalized = raw
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return false;
	return normalized.indexOf("\n---", 3) === -1;
}

function extractHeuristicName(raw: string, filePath: string): string {
	const stem = basename(filePath, ".md").trim().toLowerCase();
	const match = raw.match(/^\s*name\s*:\s*([A-Za-z0-9_-]+)\s*$/m);
	return match?.[1]?.trim() || stem;
}

function parseToolsField(rawTools: unknown): {
	ok: boolean;
	tools?: string[];
	error?: string;
} {
	if (rawTools === undefined) {
		return { ok: true };
	}
	let items: unknown[];
	if (Array.isArray(rawTools)) {
		items = rawTools;
	} else if (typeof rawTools === "string") {
		items = rawTools
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	} else {
		return { ok: false, error: 'field "tools" must be a list of tool names' };
	}
	if (items.length === 0) {
		return { ok: false, error: 'field "tools" must not be empty' };
	}
	const deduped: string[] = [];
	for (const item of items) {
		if (typeof item !== "string" || !TOOL_NAME_RE.test(item)) {
			return { ok: false, error: `invalid tool name "${String(item)}" in "tools"` };
		}
		if (!deduped.includes(item)) {
			deduped.push(item);
		}
	}
	return { ok: true, tools: deduped };
}

type RoleFields = Pick<AgentDefinition, "name" | "description" | "tools" | "model" | "thinkingLevel">;

function validateRoleFields(
	fields: Record<string, unknown>,
	where: string,
): { ok: true; value: RoleFields } | { ok: false; error: string } {
	const rawName = typeof fields.name === "string" ? fields.name.trim() : "";
	if (!rawName) {
		return { ok: false, error: `Missing required "name" ${where}` };
	}
	if (!AGENT_NAME_RE.test(rawName) || RESERVED_NAME_PREFIXES.some((prefix) => rawName.startsWith(prefix))) {
		return {
			ok: false,
			error: `Invalid agent name "${rawName}" ${where}; must match ${AGENT_NAME_RE.source} and not start with reserved task prefixes (${RESERVED_NAME_PREFIXES.join(", ")})`,
		};
	}

	const rawDescription = typeof fields.description === "string" ? fields.description.trim() : "";
	if (!rawDescription) {
		return { ok: false, error: `Missing required "description" ${where}` };
	}
	if (CONTROL_CHAR_RE.test(rawDescription)) {
		return { ok: false, error: `Invalid "description" ${where}: must not contain control characters` };
	}

	const toolsResult = parseToolsField(fields.tools);
	if (!toolsResult.ok) {
		return { ok: false, error: `Invalid tools ${where}: ${toolsResult.error ?? "invalid tools"}` };
	}

	let model: SubagentModelSpec = "inherit";
	if (fields.model !== undefined) {
		if (typeof fields.model !== "string") {
			return { ok: false, error: `Invalid "model" ${where}: must be "inherit" or "provider/model"` };
		}
		const parsedModel = parseSubagentModelSpec(fields.model);
		if (!parsedModel) {
			return {
				ok: false,
				error: `Invalid "model" value "${fields.model.trim()}" ${where}: must be "inherit" or explicit "provider/model" (model aliases are not supported)`,
			};
		}
		model = parsedModel;
	}

	let thinkingLevel: ThinkingLevel | undefined;
	if (fields.thinkingLevel !== undefined) {
		if (!isSubagentThinkingLevel(fields.thinkingLevel)) {
			return {
				ok: false,
				error: `Invalid "thinkingLevel" value "${String(fields.thinkingLevel)}" ${where}: must be one of ${SUBAGENT_THINKING_LEVELS.join(", ")}`,
			};
		}
		thinkingLevel = fields.thinkingLevel;
	}

	return {
		ok: true,
		value: {
			name: rawName,
			description: rawDescription,
			tools: toolsResult.tools,
			model,
			thinkingLevel,
		},
	};
}

function parseSingleDefinitionFile(
	filePath: string,
	scopeDirReal: string,
	source: AgentDefinitionSource,
): {
	ok: boolean;
	definition?: AgentDefinition;
	candidateNames?: string[];
	error?: string;
} {
	const fallbackStem = basename(filePath, ".md");
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(filePath);
	} catch (err) {
		return {
			ok: false,
			candidateNames: [fallbackStem],
			error: `Cannot stat definition "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	let resolvedPath = filePath;
	if (stat.isSymbolicLink()) {
		try {
			resolvedPath = realpathSync(filePath);
		} catch {
			return {
				ok: false,
				candidateNames: [fallbackStem],
				error: `Broken symlink for agent definition "${filePath}"`,
			};
		}
		const rel = relative(scopeDirReal, resolvedPath);
		if (rel.startsWith("..") || rel.includes(`..${sep}`) || resolve(scopeDirReal, rel) !== resolvedPath) {
			return {
				ok: false,
				candidateNames: [fallbackStem],
				error: `Agent definition symlink "${filePath}" escapes scope directory "${scopeDirReal}"`,
			};
		}
		try {
			stat = lstatSync(resolvedPath);
		} catch {
			return {
				ok: false,
				candidateNames: [fallbackStem],
				error: `Cannot stat resolved agent definition "${resolvedPath}"`,
			};
		}
	}

	if (!stat.isFile()) {
		return {
			ok: false,
			candidateNames: [fallbackStem],
			error: `Agent definition "${filePath}" is not a regular file`,
		};
	}

	let raw: string;
	try {
		raw = readFileSync(resolvedPath, "utf8");
	} catch (err) {
		return {
			ok: false,
			candidateNames: [fallbackStem],
			error: `Failed to read agent definition "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (hasUnclosedFrontmatter(raw)) {
		return {
			ok: false,
			candidateNames: [extractHeuristicName(raw, filePath), fallbackStem],
			error: `Agent definition "${filePath}" has unclosed YAML frontmatter`,
		};
	}

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(raw);
	} catch (err) {
		return {
			ok: false,
			candidateNames: [extractHeuristicName(raw, filePath), fallbackStem],
			error: `Invalid YAML frontmatter in "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const fm = parsed.frontmatter;
	if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
		return {
			ok: false,
			candidateNames: [fallbackStem],
			error: `Frontmatter in "${filePath}" must be a YAML mapping`,
		};
	}

	const rawName = typeof fm.name === "string" ? fm.name.trim() : "";
	const candidateNames = Array.from(new Set([rawName, fallbackStem].filter((n) => n.length > 0)));

	for (const key of Object.keys(fm)) {
		if (key === "maxTurns") {
			return {
				ok: false,
				candidateNames,
				error: `Obsolete field "maxTurns" in "${filePath}": per-role turn limits are no longer supported; remove this field.`,
			};
		}
		if (!SUPPORTED_FRONTMATTER_KEYS.has(key)) {
			return {
				ok: false,
				candidateNames,
				error: `Unsupported capability field "${key}" in "${filePath}"; allowed fields are: ${Array.from(SUPPORTED_FRONTMATTER_KEYS).join(", ")}`,
			};
		}
	}

	const fields = validateRoleFields(fm, `in "${filePath}"`);
	if (!fields.ok) {
		return { ok: false, candidateNames, error: fields.error };
	}

	const instructions = parsed.body.trim();
	if (!instructions) {
		return {
			ok: false,
			candidateNames,
			error: `Agent definition "${filePath}" must have a non-empty Markdown instruction body`,
		};
	}

	return {
		ok: true,
		definition: deepFreezeDefinition({
			...fields.value,
			instructions,
			source,
			filePath: resolvedPath,
		}),
	};
}

function listMarkdownFiles(dirPath: string): { files: string[]; realDir: string } | undefined {
	if (!existsSync(dirPath)) return undefined;
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(dirPath);
	} catch {
		return undefined;
	}
	if (!stat.isDirectory()) return undefined;
	let realDir: string;
	try {
		realDir = realpathSync(dirPath);
	} catch {
		return undefined;
	}
	const entries = readdirSync(realDir, { withFileTypes: true })
		.filter((entry) => entry.name.endsWith(".md") && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
	return {
		realDir,
		files: entries.map((name) => join(realDir, name)),
	};
}

interface ScopeLoadResult {
	valid: Map<string, AgentDefinition>;
	invalid: Map<string, string>;
	diagnostics: string[];
}

function loadScopeDirectory(dirPath: string, source: AgentDefinitionSource): ScopeLoadResult {
	const valid = new Map<string, AgentDefinition>();
	const invalid = new Map<string, string>();
	const diagnostics: string[] = [];

	const listed = listMarkdownFiles(dirPath);
	if (!listed) {
		return { valid, invalid, diagnostics };
	}

	for (const filePath of listed.files) {
		const parsed = parseSingleDefinitionFile(filePath, listed.realDir, source);
		if (!parsed.ok || !parsed.definition) {
			const errorMsg = parsed.error ?? `Invalid agent definition "${filePath}"`;
			diagnostics.push(errorMsg);
			for (const name of parsed.candidateNames ?? []) {
				if (!invalid.has(name)) {
					invalid.set(name, errorMsg);
				}
				valid.delete(name);
			}
			continue;
		}

		const { definition } = parsed;
		if (invalid.has(definition.name)) {
			continue;
		}
		const existing = valid.get(definition.name);
		if (existing) {
			const dupError = `Duplicate agent definition "${definition.name}" in ${source} scope ("${existing.filePath}" and "${definition.filePath}")`;
			diagnostics.push(dupError);
			valid.delete(definition.name);
			invalid.set(definition.name, dupError);
			continue;
		}
		valid.set(definition.name, definition);
	}

	return { valid, invalid, diagnostics };
}

export function discoverAgentDefinitions(options: DiscoverAgentDefinitionsOptions): AgentDefinitionCatalog {
	const agentDir = options.agentDir ?? getAgentDir();
	const projectTrusted = options.projectTrusted ?? true;
	const diagnostics: string[] = [];

	const bundledScope = loadScopeDirectory(BUNDLED_AGENTS_DIR, "bundled");
	diagnostics.push(...bundledScope.diagnostics);

	const userAgentsDir = join(agentDir, "agents");
	const projectAgentsDir = join(options.cwd, ".pi", "agents");

	const userScope = loadScopeDirectory(userAgentsDir, "user");
	let projectScope: ScopeLoadResult = {
		valid: new Map(),
		invalid: new Map(),
		diagnostics: [],
	};

	if (projectTrusted) {
		projectScope = loadScopeDirectory(projectAgentsDir, "project");
	} else {
		const untrustedFiles = listMarkdownFiles(projectAgentsDir);
		if (untrustedFiles && untrustedFiles.files.length > 0) {
			diagnostics.push(
				`Ignored ${untrustedFiles.files.length} agent definition(s) in "${projectAgentsDir}" from untrusted project.`,
			);
		}
	}

	diagnostics.push(...userScope.diagnostics, ...projectScope.diagnostics);

	const effectiveValid = new Map<string, AgentDefinition>(bundledScope.valid);
	const effectiveInvalid = new Map<string, string>(bundledScope.invalid);

	// Apply user scope over bundled: invalid user definition blocks lower-precedence bundled fallback
	for (const [name, err] of userScope.invalid) {
		effectiveValid.delete(name);
		effectiveInvalid.set(name, err);
	}
	for (const [name, def] of userScope.valid) {
		effectiveInvalid.delete(name);
		effectiveValid.set(name, def);
	}

	// Apply trusted project scope over user + bundled: invalid project definition blocks lower-precedence fallback
	for (const [name, err] of projectScope.invalid) {
		effectiveValid.delete(name);
		effectiveInvalid.set(name, err);
	}
	for (const [name, def] of projectScope.valid) {
		effectiveInvalid.delete(name);
		effectiveValid.set(name, def);
	}

	const sortedDefinitions = Array.from(effectiveValid.values()).sort((a, b) => a.name.localeCompare(b.name));

	return Object.freeze({
		definitions: Object.freeze(sortedDefinitions),
		byName: new Map(effectiveValid),
		invalidByName: new Map(effectiveInvalid),
		diagnostics: Object.freeze(diagnostics),
	});
}

export function createInlineAgentDefinition(role: InlineAgentRole): ResolveAgentDefinitionResult {
	const fields = validateRoleFields({ ...role }, "in inline role");
	if (!fields.ok) {
		return { ok: false, error: fields.error };
	}
	const instructions = role.instructions.trim();
	if (!instructions) {
		return { ok: false, error: `Inline role "${fields.value.name}" must have non-empty instructions` };
	}
	return { ok: true, definition: deepFreezeDefinition({ ...fields.value, instructions, source: "inline" }) };
}

export function resolveAgentDefinition(
	catalog: AgentDefinitionCatalog,
	agentName: string,
): ResolveAgentDefinitionResult {
	const normalized = agentName.trim();
	const invalidReason = catalog.invalidByName.get(normalized);
	if (invalidReason) {
		return {
			ok: false,
			error: `Agent "${normalized}" is invalid and cannot be launched: ${invalidReason}`,
		};
	}
	const definition = catalog.byName.get(normalized);
	if (!definition) {
		const available = catalog.definitions.map((d) => d.name).join(", ") || "none";
		return {
			ok: false,
			error: `Unknown subagent "${normalized}". Available subagents: ${available}`,
		};
	}
	return { ok: true, definition };
}

export function formatAgentRoutingDescriptions(catalog: AgentDefinitionCatalog): string {
	if (catalog.definitions.length === 0) {
		return "No valid subagents available.";
	}
	return catalog.definitions
		.map((def) => {
			const sourceTag = def.source === "bundled" ? "" : ` [${def.source} override]`;
			return `- \`${def.name}\`${sourceTag}${def.tools ? ` (tools: ${def.tools.join(", ")})` : ""}: ${def.description}`;
		})
		.join("\n");
}
