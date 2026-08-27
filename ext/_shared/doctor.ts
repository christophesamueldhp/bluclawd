/**
 * /doctor — environment diagnostics (CC-PARITY-AUDIT B.7).
 *
 * Pure-ish check functions over injected paths so every check is unit-testable
 * with temp dirs. The interactive /doctor command renders the results.
 *
 * Checks are deliberately bounded: the duplicate-artifact walk caps how many
 * directories it visits so /doctor stays fast on huge repos.
 */

import { accessSync, constants, type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KEYBINDINGS, migrateKeybindingsConfig } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { spawnProcessSync } from "../../../packages/coding-agent/src/utils/child-process.ts";
import { toKeybindingsConfig } from "./keybindings-config.ts";

export interface DoctorCheck {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

/** Minimum supported Node major.minor (package.json engines). */
const MIN_NODE = { major: 22, minor: 19 };

/** Caps for the duplicate-artifact walk. */
const WALK_MAX_DIRS = 400;
const WALK_SKIP = new Set([".git", "node_modules", "dist", ".cache"]);

/** iCloud-style duplicate suffix: "name 2.ts", "foo 11.json", or a bare "dir 2". */
const DUPE_PATTERN = / \d+(\.\w+)?$/;

export function checkNodeVersion(version = process.versions.node): DoctorCheck {
	const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
	const supported = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
	return {
		name: "Node version",
		status: supported ? "ok" : "warn",
		detail: supported
			? `v${version}`
			: `v${version} — below the supported minimum v${MIN_NODE.major}.${MIN_NODE.minor}`,
	};
}

/** Warn when the project lives in an iCloud-synced location (known corruption source). */
export function checkICloudLocation(cwd: string, home = homedir()): DoctorCheck {
	const synced =
		cwd.includes("Mobile Documents") ||
		cwd.includes("com~apple~CloudDocs") ||
		cwd.startsWith(join(home, "Desktop")) ||
		cwd.startsWith(join(home, "Documents"));
	return {
		name: "iCloud sync",
		status: synced ? "warn" : "ok",
		detail: synced
			? "Project is in an iCloud-synced location — iCloud is known to corrupt node_modules and create ' 2' duplicate files. Consider moving the repo."
			: "Project is outside iCloud-synced locations.",
	};
}

/** Bounded walk counting iCloud-style " N" duplicate files/dirs. */
export function checkDuplicateArtifacts(cwd: string): DoctorCheck {
	let dupes = 0;
	let dirsVisited = 0;
	let capped = false;
	const stack = [cwd];
	while (stack.length > 0) {
		if (dirsVisited >= WALK_MAX_DIRS) {
			capped = true;
			break;
		}
		const dir = stack.pop();
		if (!dir) break;
		dirsVisited += 1;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = entry.name;
			if (entry.isDirectory()) {
				if (WALK_SKIP.has(name)) continue;
				if (DUPE_PATTERN.test(name)) {
					dupes += 1;
					continue; // don't descend into a duplicate dir
				}
				stack.push(join(dir, name));
			} else if (DUPE_PATTERN.test(name)) {
				dupes += 1;
			}
		}
	}
	if (dupes === 0) {
		return {
			name: "Duplicate artifacts",
			status: "ok",
			detail: `No ' N' duplicates found${capped ? " (scan capped)" : ""}.`,
		};
	}
	return {
		name: "Duplicate artifacts",
		status: "warn",
		detail: `${dupes}${capped ? "+" : ""} iCloud-style ' N' duplicate files/dirs found. Verify they are untracked, then remove them (e.g. find . -name '* [0-9].*' -not -path '*/node_modules/*').`,
	};
}

/**
 * Config-file shape validation (IMPROVEMENT-PLAN.md §4.6).
 *
 * `checkJsonFile` on its own only proves a file parses as a JSON object — a
 * valid-JSON but wrong-shaped `mcp.json` server entry, or a mistyped `hooks.json`
 * event name, passes it cleanly and then fails silently at runtime (each loader
 * defensively drops what it cannot use rather than throwing). These checks report
 * that drop AT `/doctor` time instead, as a "warn" (the file still loads — the bad
 * value is just ignored, same as today), never a "fail".
 *
 * `keybindings.json` reuses its real loader's own drop logic (`toKeybindingsConfig`,
 * `migrateKeybindingsConfig`) directly, so that check can never drift from what the
 * loader actually does. `hooks.json` and `mcp.json` cannot do the same: their loaders
 * live in `core-extensions/`, which this file (`core/`) must not import from — every
 * other core-extensions module imports FROM core/, never the reverse. Their schemas
 * below are therefore a small, deliberately duplicated mirror of `HookEntry`
 * (`core-extensions/hooks/index.ts`) and `ServerConfig`
 * (`core-extensions/mcp/schema.ts`) — a handful of fields each, low churn, worth the
 * duplication risk for a diagnostic that only ever downgrades to a warning if it
 * drifts. `settings.json`'s schema is deliberately shallow (depth 1, plus three
 * internally-defined nested enums): the `Settings` interface
 * (`core/settings-manager.ts`) has 45+ fields, most of them optional strings/
 * booleans/objects that don't need enum-level checking; the fields that DO gain
 * real value from an enum check are exactly the ones checked below.
 */

type FieldKind = "string" | "number" | "boolean" | "array" | "object";

function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check one known field's kind (and, if given, that its value is one of `enumValues`). */
function checkField(
	problems: string[],
	obj: Record<string, unknown>,
	key: string,
	kind: FieldKind,
	enumValues?: readonly (string | number)[],
	path = key,
): void {
	const value = obj[key];
	if (value === undefined) return;
	if (kindOf(value) !== kind) {
		problems.push(`"${path}" should be ${kind}, got ${kindOf(value)}`);
		return;
	}
	if (enumValues && !enumValues.includes(value as string | number)) {
		problems.push(
			`"${path}": ${JSON.stringify(value)} is not one of ${enumValues.map((v) => JSON.stringify(v)).join(", ")}`,
		);
	}
}

/** Report every key of `obj` not present in `schema`, and type/enum-check the rest. */
function checkKnownFields(
	obj: Record<string, unknown>,
	schema: Record<string, { kind: FieldKind; enum?: readonly (string | number)[] }>,
): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(obj)) {
		const spec = schema[key];
		if (!spec) {
			problems.push(`unknown key "${key}"`);
			continue;
		}
		checkField(problems, obj, key, spec.kind, spec.enum);
	}
	return problems;
}

// Mirrors the `Settings` interface (core/settings-manager.ts) at depth 1. A field
// added there and not here just shows up as "unknown key" — a safe, non-fatal drift.
const SETTINGS_SCHEMA: Record<string, { kind: FieldKind; enum?: readonly (string | number)[] }> = {
	lastChangelogVersion: { kind: "string" },
	defaultProvider: { kind: "string" },
	defaultModel: { kind: "string" },
	defaultThinkingLevel: { kind: "string" }, // external enum (pi-agent-core) — not re-validated here
	transport: { kind: "string" }, // external enum (pi-ai) — not re-validated here
	steeringMode: { kind: "string", enum: ["all", "one-at-a-time"] },
	followUpMode: { kind: "string", enum: ["all", "one-at-a-time"] },
	theme: { kind: "string" },
	compaction: { kind: "object" },
	branchSummary: { kind: "object" },
	retry: { kind: "object" },
	hideThinkingBlock: { kind: "boolean" },
	showCacheMissNotices: { kind: "boolean" },
	externalEditor: { kind: "string" },
	shellPath: { kind: "string" },
	quietStartup: { kind: "boolean" },
	defaultProjectTrust: { kind: "string", enum: ["ask", "always", "never"] },
	shellCommandPrefix: { kind: "string" },
	npmCommand: { kind: "array" },
	collapseChangelog: { kind: "boolean" },
	enableInstallTelemetry: { kind: "boolean" },
	enableAnalytics: { kind: "boolean" },
	trackingId: { kind: "string" },
	packages: { kind: "array" },
	extensions: { kind: "array" },
	coreExtensions: { kind: "array" },
	fastModel: { kind: "string" },
	statusline: { kind: "object" },
	permissions: { kind: "object" },
	websearch: { kind: "object" },
	sandbox: { kind: "object" },
	skills: { kind: "array" },
	prompts: { kind: "array" },
	themes: { kind: "array" },
	enableSkillCommands: { kind: "boolean" },
	terminal: { kind: "object" },
	images: { kind: "object" },
	enabledModels: { kind: "array" },
	doubleEscapeAction: { kind: "string", enum: ["fork", "tree", "none"] },
	treeFilterMode: { kind: "string", enum: ["default", "no-tools", "user-only", "labeled-only", "all"] },
	thinkingBudgets: { kind: "object" },
	editorPaddingX: { kind: "number" },
	outputPad: { kind: "number", enum: [0, 1] },
	autocompleteMaxVisible: { kind: "number" },
	showHardwareCursor: { kind: "boolean" },
	markdown: { kind: "object" },
	warnings: { kind: "object" },
	sessionDir: { kind: "string" },
	httpProxy: { kind: "string" },
	httpIdleTimeoutMs: { kind: "number" },
	websocketConnectTimeoutMs: { kind: "number" },
	tuiMode: { kind: "string" }, // external enum (pi-tui) — not re-validated here
	fullscreenExitOutput: { kind: "string", enum: ["transcript", "resume-hint"] },
	fullscreenScrollbar: { kind: "string" }, // external enum (pi-tui) — not re-validated here
};

/** `Settings["permissions"]["defaultMode"]` — mirrors PERMISSION_MODES
 *  (core-extensions/permissions/modes.ts); duplicated for the same layering reason
 *  documented at the top of this section. */
const PERMISSION_MODE_VALUES = ["default", "acceptEdits", "auto", "bypass", "dontAsk"] as const;

export function checkSettingsShape(settings: Record<string, unknown>): string[] {
	const problems = checkKnownFields(settings, SETTINGS_SCHEMA);
	if (isPlainObject(settings.permissions)) {
		checkField(
			problems,
			settings.permissions,
			"defaultMode",
			"string",
			PERMISSION_MODE_VALUES,
			"permissions.defaultMode",
		);
	}
	if (isPlainObject(settings.websearch)) {
		checkField(problems, settings.websearch, "provider", "string", ["exa", "brave", "tavily"], "websearch.provider");
	}
	if (isPlainObject(settings.markdown)) {
		checkField(problems, settings.markdown, "mermaid", "string", ["off", "final", "streaming"], "markdown.mermaid");
	}
	return problems;
}

// Mirrors CC_EVENT_KEYS (core-extensions/hooks/index.ts).
const HOOKS_EVENT_KEYS = new Set([
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"SubagentStart",
	"SubagentStop",
	"UserPromptSubmit",
	"Notification",
	"Stop",
	"SessionStart",
	"SessionEnd",
	"PreCompact",
	"PostCompact",
]);

export function checkHooksShape(config: Record<string, unknown>): string[] {
	const problems: string[] = [];
	for (const [key, entries] of Object.entries(config)) {
		if (!HOOKS_EVENT_KEYS.has(key)) {
			problems.push(`unknown/mistyped event key "${key}" (ignored by the loader)`);
			continue;
		}
		if (!Array.isArray(entries)) {
			problems.push(`"${key}" should be an array of hook entries, got ${kindOf(entries)}`);
			continue;
		}
		entries.forEach((entry, i) => {
			if (!isPlainObject(entry)) {
				problems.push(`${key}[${i}] should be an object`);
				return;
			}
			if (typeof entry.command !== "string") {
				problems.push(`${key}[${i}].command should be a string (this entry is dropped by the loader)`);
			}
			if (entry.matcher !== undefined && typeof entry.matcher !== "string") {
				problems.push(`${key}[${i}].matcher should be a string`);
			}
		});
	}
	return problems;
}

export function checkMcpShape(config: Record<string, unknown>): string[] {
	const problems: string[] = [];
	for (const key of Object.keys(config)) {
		if (key !== "mcpServers") problems.push(`unknown key "${key}"`);
	}
	const servers = config.mcpServers;
	if (servers === undefined) return problems;
	if (!isPlainObject(servers)) {
		problems.push(`"mcpServers" should be an object, got ${kindOf(servers)}`);
		return problems;
	}
	for (const [name, value] of Object.entries(servers)) {
		if (name.includes("__")) {
			problems.push(`server "${name}" contains "__", which is ambiguous with mcp tool naming and is rejected`);
		}
		if (!isPlainObject(value)) {
			problems.push(`server "${name}" should be an object`);
			continue;
		}
		if (value.command === undefined && value.url === undefined) {
			problems.push(`server "${name}" has neither "command" nor "url" — it will not connect`);
		}
		checkField(problems, value, "command", "string", undefined, `${name}.command`);
		checkField(problems, value, "url", "string", undefined, `${name}.url`);
		checkField(problems, value, "disabled", "boolean", undefined, `${name}.disabled`);
		checkField(problems, value, "deferTools", "boolean", undefined, `${name}.deferTools`);
		if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((a) => typeof a === "string"))) {
			problems.push(`server "${name}".args should be an array of strings`);
		}
		for (const objKey of ["env", "headers"] as const) {
			if (value[objKey] !== undefined && !isPlainObject(value[objKey])) {
				problems.push(`server "${name}".${objKey} should be an object`);
			}
		}
	}
	return problems;
}

export function checkKeybindingsShape(raw: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const { config: migrated } = migrateKeybindingsConfig(raw);
	const knownKeys = new Set(Object.keys(KEYBINDINGS));
	for (const key of Object.keys(migrated)) {
		if (!knownKeys.has(key)) problems.push(`unknown keybinding action "${key}" (ignored by the loader)`);
	}
	const survivors = toKeybindingsConfig(migrated);
	for (const key of Object.keys(migrated)) {
		if (knownKeys.has(key) && !(key in survivors)) {
			problems.push(`"${key}": value should be a key string or an array of key strings (dropped by the loader)`);
		}
	}
	return problems;
}

/** Cap how many shape problems a single check reports, so one badly-shaped file
 *  cannot flood /doctor's output. */
const MAX_SHAPE_PROBLEMS_SHOWN = 5;

/** Validate a JSON config file: absent is fine; unreadable/malformed is a failure;
 *  a well-formed-but-wrong-shaped file (per `validateShape`) is a warning. */
export function checkJsonFile(
	path: string,
	label: string,
	validateShape?: (parsed: Record<string, unknown>) => string[],
): DoctorCheck {
	if (!existsSync(path)) {
		return { name: label, status: "ok", detail: "Not present (defaults apply)." };
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isPlainObject(parsed)) {
			return { name: label, status: "fail", detail: `${path} parses but is not a JSON object.` };
		}
		const problems = validateShape?.(parsed) ?? [];
		if (problems.length > 0) {
			const shown = problems.slice(0, MAX_SHAPE_PROBLEMS_SHOWN);
			const more = problems.length > shown.length ? ` (+${problems.length - shown.length} more)` : "";
			return { name: label, status: "warn", detail: `${path}: ${shown.join("; ")}${more}` };
		}
		return { name: label, status: "ok", detail: path };
	} catch (err) {
		return { name: label, status: "fail", detail: `${path} is not valid JSON: ${String(err)}` };
	}
}

export function checkAgentDirWritable(agentDir: string): DoctorCheck {
	try {
		accessSync(agentDir, constants.W_OK);
		return { name: "Agent dir", status: "ok", detail: agentDir };
	} catch {
		return {
			name: "Agent dir",
			status: existsSync(agentDir) ? "fail" : "warn",
			detail: existsSync(agentDir)
				? `${agentDir} is not writable.`
				: `${agentDir} does not exist yet (created on first write).`,
		};
	}
}

/** Is a global `bluclawd`-style binary on PATH, and does its symlink resolve? */
export function checkGlobalBinary(appName: string): DoctorCheck {
	const result = spawnProcessSync("which", [appName], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	const found = result.status === 0 ? result.stdout.trim() : "";
	if (!found) {
		return { name: "Global binary", status: "warn", detail: `${appName} is not on PATH.` };
	}
	try {
		accessSync(found, constants.X_OK);
		return { name: "Global binary", status: "ok", detail: found };
	} catch {
		return {
			name: "Global binary",
			status: "fail",
			detail: `${found} exists on PATH but is not executable (broken symlink?).`,
		};
	}
}

/** Run the full check set for /doctor. */
/**
 * Minimal shape `runDoctorChecks` needs from FleetView's daemon client (IMPROVEMENT-PLAN.md
 * §4.5/§5.3). Injected rather than importing `OrchestratorClient` directly: that class lives
 * in `modes/interactive/fleet/`, spawns processes and opens sockets, which would work
 * against this module's own "pure-ish check functions" design — the one real caller
 * (`interactive-mode.ts`, which already owns an `OrchestratorClient`) supplies it.
 */
export interface DaemonProbe {
	getDaemonInfo(): Promise<{ running: boolean; version?: string; buildId?: string }>;
	currentBuildId(): string;
}

export async function checkDaemonVersion(probe: DaemonProbe): Promise<DoctorCheck> {
	const info = await probe.getDaemonInfo();
	if (!info.running) {
		return { name: "FleetView daemon", status: "ok", detail: "Not running." };
	}
	const current = probe.currentBuildId();
	if (!info.buildId) {
		return {
			name: "FleetView daemon",
			status: "warn",
			detail:
				"Running daemon predates the version-echo handshake — restart it (kill the `server` process; FleetView respawns it fresh) to enable staleness checks.",
		};
	}
	if (info.buildId !== current) {
		return {
			name: "FleetView daemon",
			status: "warn",
			detail: `Running an older build (${info.version ?? "?"}, ${info.buildId}) than what's installed now (${current}) — restart it: kill the \`server\` process, FleetView respawns it fresh.`,
		};
	}
	return { name: "FleetView daemon", status: "ok", detail: `Up to date (${info.version ?? current}).` };
}

export async function runDoctorChecks(options: {
	cwd: string;
	agentDir: string;
	appName: string;
	home?: string;
	daemonProbe?: DaemonProbe;
}): Promise<DoctorCheck[]> {
	const { cwd, agentDir, appName, daemonProbe } = options;
	const home = options.home ?? homedir();
	const checks: DoctorCheck[] = [
		checkNodeVersion(),
		checkICloudLocation(cwd, home),
		checkDuplicateArtifacts(cwd),
		checkJsonFile(join(agentDir, "settings.json"), "Global settings.json", checkSettingsShape),
		checkJsonFile(join(cwd, ".bluclawd", "settings.json"), "Project settings.json", checkSettingsShape),
		checkJsonFile(join(agentDir, "hooks.json"), "Global hooks.json", checkHooksShape),
		checkJsonFile(join(cwd, ".bluclawd", "hooks.json"), "Project hooks.json", checkHooksShape),
		checkJsonFile(join(agentDir, "mcp.json"), "Global mcp.json", checkMcpShape),
		checkJsonFile(join(cwd, ".bluclawd", "mcp.json"), "Project mcp.json", checkMcpShape),
		checkJsonFile(join(agentDir, "keybindings.json"), "keybindings.json", checkKeybindingsShape),
		checkAgentDirWritable(agentDir),
		checkGlobalBinary(appName),
	];
	if (daemonProbe) checks.push(await checkDaemonVersion(daemonProbe));
	return checks;
}
