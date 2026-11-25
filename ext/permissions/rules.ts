import { spawnSync } from "node:child_process";
import { existsSync, globSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveDenyRulePath } from "../_shared/deny-rule-path.ts";
import { resolveToCwd } from "../_shared/path-resolve.ts";

const VERB: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Find",
	ls: "Ls",
	webfetch: "WebFetch",
	websearch: "WebSearch",
	subagent: "Subagent",
};

/** pi shortens an over-long or colliding MCP tool name to its first 55, `_` and 8 hex of a hash. */
const HASHED_MCP_TOOL_NAME = /^mcp__.{50}_[0-9a-f]{8}$/;

/** pi accepts an MCP tool with an empty name, so nothing is required after the server's `__`. */
function isMcpToolName(tool: string): boolean {
	return /^mcp__.+__/.test(tool) || HASHED_MCP_TOOL_NAME.test(tool);
}

const HASHED_NAME_KEPT_CHARS = 55;

/**
 * A server rule (`mcp__<server>__*` once spelled) as pi's hashed names. From a 50-character
 * server on, the kept 55 characters lose the `__` after it, so the glob alone misses them.
 */
function hashedMcpToolNamesByKeptPrefix(ruleSubject: string): RegExp[] {
	const prefix = ruleSubject.slice(0, -1);
	const kept = prefix.slice(0, HASHED_NAME_KEPT_CHARS);
	if (!ruleSubject.endsWith("__*") || kept.includes("*") || prefix.length <= HASHED_NAME_KEPT_CHARS) return [];
	return [new RegExp(`^${kept}_[0-9a-f]{8}$`)];
}

function verbFor(tool: string): string | undefined {
	if (isMcpToolName(tool)) return "Mcp";
	return VERB[tool];
}

const COVERING_VERBS: Record<string, string[]> = {
	Write: ["edit"],
	Grep: ["read"],
	Find: ["read"],
	Ls: ["read"],
};

function ruleVerbCovers(ruleVerb: string, verb: string): boolean {
	return ruleVerb === verb.toLowerCase() || (COVERING_VERBS[verb] ?? []).includes(ruleVerb);
}

/**
 * An MCP tool's name as pi spells it (`createMcpToolName`), where anything but a letter, digit or
 * `_` becomes `_`.
 */
export function mcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

function mcpRuleGlob(server: string, tool = "*"): string {
	return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_*]/g, "_");
}

/**
 * Every MCP spelling (`mcp__server`, `mcp__server__*`, `mcp__server__tool`, `Mcp(server:tool)`)
 * compiles to a glob over the tool name as pi spells it. The whole name is matched, not a
 * `server:tool` split, since spelling can create a new `__` (`a--b` becomes `a__b`).
 */
function ruleParts(rule: string): { verb: string; subject: string } | undefined {
	const mcp = /^mcp__(.+?)(?:__(.+))?$/.exec(rule);
	if (mcp) return { verb: "mcp", subject: mcpRuleGlob(mcp[1], mcp[2]) };
	const m = /^(\w+)(?:\((.*)\))?$/.exec(rule);
	if (!m) return undefined;
	const verb = m[1].toLowerCase();
	if (verb === "mcp" && m[2] !== undefined) {
		const colon = m[2].indexOf(":");
		if (colon === -1) return { verb, subject: mcpRuleGlob(m[2].trim()) };
		return { verb, subject: mcpRuleGlob(m[2].slice(0, colon).trim(), m[2].slice(colon + 1).trim()) };
	}
	return { verb, subject: m[2] ?? "**" };
}

const ANY_SERVER_PREFIX = "mcp__x";

function concreteServerPrefixes(ruleSubject: string): string[] {
	const atEachDoubleUnderscore = [...ruleSubject.matchAll(/(?=__)/g)].map((m) => ruleSubject.slice(0, m.index));
	return [ANY_SERVER_PREFIX, ...atEachDoubleUnderscore].map((prefix) => prefix.replace(/\*/g, "x"));
}

export function deniesResourceToolOnSomeServer(rule: string, resourceTool: string): boolean {
	const parts = ruleParts(rule);
	if (parts?.verb !== "mcp") return false;
	const pattern = globToRegExp(parts.subject);
	return concreteServerPrefixes(parts.subject).some((serverPrefix) =>
		pattern.test(`${serverPrefix}__${resourceTool}`),
	);
}

const REGEX_META = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\", "?"]);

export function searchQueries(input: Record<string, unknown>): string[] {
	const batch = Array.isArray(input.queries) ? input.queries.filter((q): q is string => typeof q === "string") : [];
	return typeof input.query === "string" && input.query !== "" ? [input.query, ...batch] : batch;
}

function subject(tool: string, input: Record<string, unknown>): string {
	if (isMcpToolName(tool)) return tool;
	if (tool === "subagent") return String(input.agent ?? "");
	if (tool === "websearch") return searchQueries(input)[0] ?? "";
	return tool === "bash" ? String(input.command ?? "") : String(input.path ?? input.url ?? input.query ?? "");
}

export function displayRule(rule: string): string {
	return rule.replace(/\\\*/g, "*");
}

function domainSpec(ruleSubject: string): string | undefined {
	const m = /^domain:\s*(.+)$/i.exec(ruleSubject.trim());
	return m ? m[1].trim().toLowerCase() : undefined;
}

function urlHost(url: string): string | undefined {
	try {
		const host = new URL(url).hostname.toLowerCase();
		if (!host) return undefined;
		return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	} catch {
		return undefined;
	}
}

function realpathAllowingMissingLeaf(absPath: string): string | undefined {
	try {
		return realpathSync(absPath);
	} catch {
		try {
			return join(realpathSync(dirname(absPath)), basename(absPath));
		} catch {
			return undefined;
		}
	}
}

const PATH_VERBS = new Set(["Read", "Write", "Edit", "Grep", "Find", "Ls"]);

const CWD_DEFAULTING_VERBS = new Set(["Grep", "Find", "Ls"]);

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export function pathRule(rule: string): { verb: "Read" | "Edit" | "Write"; path: string } | undefined {
	const parts = ruleParts(rule);
	if (!parts) return undefined;
	const verb = capitalize(parts.verb);
	return verb === "Read" || verb === "Edit" || verb === "Write" ? { verb, path: parts.subject } : undefined;
}

export function legacyAbsoluteDenyRule(rule: string): string | undefined {
	const parts = ruleParts(rule);
	if (!parts || !PATH_VERBS.has(capitalize(parts.verb))) return undefined;
	const path = parts.subject;
	if (!path.startsWith("/") || path.startsWith("//")) return undefined;
	const literal = path.endsWith("/**") ? path.slice(0, -3) || "/" : path;
	const absoluteRule = rule.replace("(/", "(//");
	if (existsSync(literal.replace(/\\\*/g, "*"))) return absoluteRule;
	if (!/(?<!\\)\*/.test(path)) return undefined;
	let entries = 0;
	return globSync(path, { exclude: () => ++entries > MAX_GLOB_ENTRIES }).length > 0 ? absoluteRule : undefined;
}

function homeExpand(s: string): string {
	return s.replace(/^~/, process.env.HOME ?? "~");
}

type GlobKind = "path" | "deny-path" | "command";

function globToRegExp(pat: string, kind: GlobKind = "path", flags = ""): RegExp {
	const dirPrefix = pat.slice(0, -3);
	if (kind !== "command" && pat.endsWith("/**") && !/^\/*$/.test(dirPrefix)) {
		return new RegExp(`^${globBody(dirPrefix, kind)}(?:/[\\s\\S]*)?$`, flags);
	}
	if (kind === "command" && (pat.endsWith(":*") || pat.endsWith(" *"))) return commandPrefixRegExp(pat.slice(0, -2));
	return new RegExp(`^${globBody(pat, kind)}$`, flags);
}

function commandPrefixRegExp(prefix: string): RegExp {
	return new RegExp(`^${globBody(prefix, "command")}(?:\\s[\\s\\S]*)?$`);
}

function absoluteRuleSpelling(pat: string): string {
	return pat.replace(/^\/\//, "/");
}

const pathCaseFlags = new Map<string, string>();

function pathRuleFlags(cwd: string): string {
	const cached = pathCaseFlags.get(cwd);
	if (cached !== undefined) return cached;
	try {
		let dir = realpathSync.native(cwd);
		const device = statSync(dir).dev;
		while (true) {
			const entries = readdirSync(dir);
			const entry = entries.find((name) => /[a-z]/i.test(name));
			if (entry !== undefined) {
				const alternate = entry.replace(/[a-z]/i, (letter) =>
					letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
				);
				const foldsCase =
					!entries.includes(alternate) && lstatSync(join(dir, alternate), { throwIfNoEntry: false }) !== undefined;
				const flags = foldsCase ? "iu" : "";
				pathCaseFlags.set(cwd, flags);
				return flags;
			}
			const parent = dirname(dir);
			if (parent === dir || statSync(parent).dev !== device) return "";
			dir = parent;
		}
	} catch {
		return "";
	}
}

function pathRulePatterns(ruleSubject: string, cwd: string): RegExp[] {
	const path = resolveDenyRulePath(ruleSubject, cwd, homedir());
	const flags = pathRuleFlags(cwd);
	const patterns = [globToRegExp(path, "deny-path", flags)];
	const starIdx = path.indexOf("*");
	const prefix = starIdx === -1 ? path : path.slice(0, path.lastIndexOf("/", starIdx));
	const realPrefix = prefix && realpathAllowingMissingLeaf(prefix);
	if (realPrefix && realPrefix !== prefix) {
		patterns.push(globToRegExp(`${realPrefix}${path.slice(prefix.length)}`, "deny-path", flags));
	}
	return patterns;
}

function globBody(pat: string, kind: GlobKind): string {
	const expanded = kind === "deny-path" ? pat : homeExpand(kind === "path" ? absoluteRuleSpelling(pat) : pat);
	let body = "";
	for (let i = 0; i < expanded.length; i++) {
		const c = expanded[i];
		if (c === "\\" && expanded[i + 1] === "*") {
			body += "\\*";
			i++;
		} else if (c === "*") {
			if (kind === "deny-path" && expanded[i - 1] === "/" && expanded.slice(i, i + 3) === "**/") {
				body += "(?:[^/]+/)*";
				i += 2;
			} else if (expanded[i + 1] === "*") {
				// `.*` would let a multiline command escape a `**` rule.
				body += "[\\s\\S]*";
				i++;
			} else {
				body += kind === "command" ? "[\\s\\S]*" : "[^/]*";
			}
		} else if (REGEX_META.has(c)) {
			body += `\\${c}`;
		} else {
			body += c;
		}
	}
	return body;
}

const ENV_ASSIGNMENTS = /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
const SHELL_INLINE = /^(?:\S*\/)?(?:ba|z|k|da|a)?sh\s+(?:-\S+\s+)*-\S*c\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;
const COMMAND_PREFIXES = new Set([
	"sudo",
	"doas",
	"timeout",
	"nice",
	"ionice",
	"time",
	"command",
	"builtin",
	"exec",
	"eval",
	"stdbuf",
	"strace",
	"ltrace",
	"nohup",
	"setsid",
	"watch",
	"xargs",
	"env",
	"chrt",
	"taskset",
	"caffeinate",
	"unbuffer",
	"if",
	"then",
	"else",
	"elif",
	"do",
	"while",
	"until",
	"!",
	"{",
]);
const PREFIX_ARG_LIMIT = 8;
/** `flock` takes a lockfile or file descriptor (and optional `-c`) before the command it wraps; `-w`/`-E` take a value. */
const FLOCK_WRAPPER = /^flock\s+(?:-[wE]\s+\S+\s+|-\S+\s+)*\S+\s+(?:-c\s+)?/;
const MAX_WRAPPER_NESTING = 3;

function bashSegmentsIgnoringQuotes(command: string): string[] {
	return command
		.split(/[;\n()`]+|(?<!>)[&|]+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function peelEnvAndFlock(segment: string): string {
	let peeled = segment;
	let previous = "";
	while (previous !== peeled) {
		previous = peeled;
		peeled = peeled.replace(ENV_ASSIGNMENTS, "").replace(FLOCK_WRAPPER, "").trim();
	}
	return peeled;
}

function withoutAliasEscape(segment: string): string {
	return segment.replace(/^\\/, "");
}

function withoutBinaryDir(form: string): string {
	const [, binary, rest] = /^(\S+)([\s\S]*)$/.exec(form) ?? [];
	return binary?.includes("/") ? `${binary.slice(binary.lastIndexOf("/") + 1)}${rest ?? ""}` : form;
}

function wrappedCommandCandidates(tokens: string[], depth: number): string[] {
	if (!COMMAND_PREFIXES.has(basename(tokens[0] ?? ""))) return [];
	const nested: string[] = [];
	for (let start = 1; start < Math.min(tokens.length, PREFIX_ARG_LIMIT + 2); start++) {
		if (REDIRECT.test(tokens[start - 1])) continue;
		for (const subject of bashRuleSubjects(tokens.slice(start).join(" "), depth + 1)) nested.push(subject);
	}
	return nested;
}

function bashRuleSubjects(command: string, depth = 0): string[] {
	const candidates = new Set<string>([command.trim()]);
	if (depth > MAX_WRAPPER_NESTING) return [...candidates].filter(Boolean);

	for (const rawSegment of bashSegmentsIgnoringQuotes(command)) {
		const segment = rawSegment.trim();
		if (!segment) continue;
		candidates.add(segment);

		const peeled = peelEnvAndFlock(segment);
		candidates.add(peeled);

		const unescaped = withoutAliasEscape(peeled);
		candidates.add(unescaped);

		const braceExpanded = dequote(unescaped).split(/\s+/).flatMap(expandBraces).join(" ");
		for (const form of new Set([unescaped, dequote(unescaped), braceExpanded])) {
			candidates.add(form);
			candidates.add(withoutBinaryDir(form));
			for (const nested of wrappedCommandCandidates(form.split(/\s+/), depth)) candidates.add(nested);
		}

		const inline = SHELL_INLINE.exec(unescaped);
		if (inline) {
			for (const nested of bashRuleSubjects(inline[1] ?? inline[2] ?? inline[3] ?? "", depth + 1)) {
				candidates.add(nested);
			}
		}
	}
	return [...candidates].filter(Boolean);
}

function dequote(s: string): string {
	return s
		.replace(/\$(?=['"])/g, "")
		.replace(/\\(.)/g, "$1")
		.replace(/['"]/g, "");
}

const MAX_BRACE_WORDS = 10_000;

function tooManyBraceWords(word: string): Error {
	return new Error(`brace expansion too large to check: ${word}`);
}

function braceSequence(inner: string): string[] | undefined {
	const m = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(inner);
	if (!m) return undefined;
	const [, from, to, by] = m;
	const numeric = /\d/.test(from);
	if (numeric !== /\d/.test(to)) return undefined;
	const start = numeric ? Number(from) : from.charCodeAt(0);
	const end = numeric ? Number(to) : to.charCodeAt(0);
	const step = Math.abs(Number(by ?? 1)) || 1;
	if (Math.abs(end - start) / step + 1 > MAX_BRACE_WORDS) throw tooManyBraceWords(inner);
	const zeroPadded = /^-?0\d/.test(from) || /^-?0\d/.test(to);
	const padded = numeric && zeroPadded ? Math.max(from.length, to.length) : 0;
	const words: string[] = [];
	for (let n = start; start <= end ? n <= end : n >= end; n += start <= end ? step : -step) {
		if (!numeric) words.push(String.fromCharCode(n));
		else words.push(n < 0 ? `-${String(-n).padStart(padded - 1, "0")}` : String(n).padStart(padded, "0"));
	}
	return words;
}

function expandBraces(word: string): string[] {
	for (let open = word.indexOf("{"); open !== -1; open = word.indexOf("{", open + 1)) {
		if (word[open - 1] === "$") continue;
		let depth = 0;
		let close = -1;
		const commas: number[] = [];
		for (let i = open; i < word.length && close === -1; i++) {
			if (word[i] === "{") depth++;
			else if (word[i] === "}" && --depth === 0) close = i;
			else if (word[i] === "," && depth === 1) commas.push(i);
		}
		if (close === -1) continue;
		const bounds = [open, ...commas, close];
		const parts = commas.length
			? bounds.slice(1).map((end, i) => word.slice(bounds[i] + 1, end))
			: braceSequence(word.slice(open + 1, close));
		if (!parts) continue;
		const words: string[] = [];
		for (const part of parts) {
			for (const expanded of expandBraces(word.slice(0, open) + part + word.slice(close + 1))) {
				words.push(expanded);
				if (words.length > MAX_BRACE_WORDS) throw tooManyBraceWords(word);
			}
		}
		return words;
	}
	return [word];
}

function expandVars(s: string): string {
	return s.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, braced, bare) => process.env[braced ?? bare] ?? m);
}

function shellWords(command: string): string[] {
	return command.match(/(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s'"\\<>;&|()])+|[<>]+&?/g) ?? [];
}

const GLOB_CHARS = /[*?[]/;
const MAX_GLOB_ENTRIES = 10_000;

function globSegmentRegExp(segment: string): RegExp {
	let body = "";
	for (let i = 0; i < segment.length; i++) {
		const c = segment[i];
		// A `]` right after `[` is part of the class, as in the shell.
		const end = c === "[" ? segment.indexOf("]", i + 2) : -1;
		if (c === "*") body += "[^/]*";
		else if (c === "?") body += "[^/]";
		else if (end !== -1) {
			const cls = segment
				.slice(i + 1, end)
				.replace(/^!/, "^")
				.replace(/\\/g, "\\\\");
			body += `[${cls}]`;
			i = end;
		} else body += REGEX_META.has(c) ? `\\${c}` : c;
	}
	return new RegExp(`^${body}$`);
}

function bashGlobMatcher(segment: string): (name: string) => boolean {
	const pattern = globSegmentRegExp(segment);
	const dotfilesToo = segment.startsWith(".");
	return (name) => (dotfilesToo || !name.startsWith(".")) && pattern.test(name);
}

export const GLOB_LEVEL_TIMEOUT_MS = 3000;
const GLOB_LISTING_MAX_BYTES = 16 * 1024 * 1024;

// A directory read can block indefinitely (a dead mount, a macOS privacy prompt), and this check is synchronous, so a
// `find` the timeout can kill reads each level. An unreadable directory is skipped, as the shell skips it.
function listDirectories(dirs: string[], absPath: string): string[] {
	const listed = spawnSync("find", ["-H", ...dirs, "-mindepth", "1", "-maxdepth", "1", "-print0"], {
		encoding: "utf8",
		timeout: GLOB_LEVEL_TIMEOUT_MS,
		killSignal: "SIGKILL",
		maxBuffer: GLOB_LISTING_MAX_BYTES,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (listed.error || listed.signal) throw new Error(`glob not checked in time: ${absPath}`);
	return listed.stdout.split("\0").filter(Boolean);
}

function expandGlob(absPath: string): string[] {
	let paths = ["/"];
	let scanned = 0;
	for (const segment of absPath.split("/").filter(Boolean)) {
		if (!GLOB_CHARS.test(segment)) {
			paths = paths.map((p) => join(p, segment));
			continue;
		}
		if (paths.length === 0) return [];
		const matches = bashGlobMatcher(segment);
		const entries = listDirectories(paths, absPath);
		scanned += entries.length;
		if (scanned > MAX_GLOB_ENTRIES) throw new Error(`glob too broad to check: ${absPath}`);
		paths = entries.filter((entry) => matches(basename(entry)));
	}
	return paths;
}

function bashPathCandidates(subjects: string[], cwd: string): Record<BashPathUse, string[]> {
	const words: Record<BashPathUse, Set<string>> = { read: new Set(), append: new Set(), truncate: new Set() };
	const redirects = new Set<string>();
	const bases = new Set([cwd]);
	for (const s of subjects) {
		const plain = expandVars(dequote(s));
		for (const m of plain.matchAll(/[<>]+&?\s*([^\s<>&|;]+)/g)) redirects.add(m[1]);
		const forms = [
			plain.replace(/(\d*[<>]+&?)/g, " $1 ").split(/\s+/),
			shellWords(s).map((word) => expandVars(dequote(word))),
		];
		for (const tokens of forms) {
			if (tokens[0] === "cd" && tokens[1]) bases.add(resolveToCwd(homeExpand(tokens[1]), cwd));
			for (const [i, token] of tokens.entries()) {
				if (REDIRECT.test(token)) {
					if (tokens[i + 1]) redirects.add(tokens[i + 1]);
					continue;
				}
				const use = redirectUse(tokens[i - 1]);
				const value = assignedValue(token);
				if (value) words[use].add(value);
				if (token && !token.startsWith("-")) words[use].add(token);
			}
		}
	}
	const resolve = (uses: Set<string>): string[] => {
		const out = new Set<string>();
		const addPath = (path: string) => {
			out.add(path);
			const real = realpathAllowingMissingLeaf(path);
			if (real !== undefined) out.add(real);
		};
		const addResolved = (word: string, base: string) => {
			const resolved = resolveToCwd(homeExpand(word), base);
			addPath(resolved);
			if (GLOB_CHARS.test(word)) for (const match of expandGlob(resolved)) addPath(match);
		};
		for (const word of uses) {
			const pathLike = /^[~./]/.test(word) || word.includes("/") || redirects.has(word) || GLOB_CHARS.test(word);
			for (const base of bases) {
				if (pathLike || existsSync(resolveToCwd(word, base))) {
					addResolved(word, base);
				}
			}
		}
		return [...out];
	};
	return { read: resolve(words.read), append: resolve(words.append), truncate: resolve(words.truncate) };
}

function assignedValue(token: string): string {
	return token.includes("=") ? token.slice(token.indexOf("=") + 1) : "";
}

type BashPathUse = "read" | "append" | "truncate";

const REDIRECT = /^\d*[<>]+&?$/;

function redirectUse(previous: string | undefined): BashPathUse {
	if (previous === undefined || !REDIRECT.test(previous) || previous.includes("<")) return "read";
	return /^\d*>>$/.test(previous) ? "append" : "truncate";
}

const BASH_USES_GUARDED: Record<string, BashPathUse[]> = {
	Write: ["read", "truncate"],
	Edit: ["read", "truncate", "append"],
};

function bashCommandTouchesRulePath(
	paths: Record<BashPathUse, string[]>,
	ruleVerb: string,
	ruleSubject: string,
	cwd: string,
): boolean {
	const patterns = pathRulePatterns(ruleSubject, cwd);
	return (BASH_USES_GUARDED[ruleVerb] ?? ["read"]).some((use) =>
		paths[use].some((candidate) => patterns.some((pattern) => pattern.test(candidate))),
	);
}

function failClosed(check: () => boolean): boolean {
	try {
		return check();
	} catch {
		return true;
	}
}

export function deniedBy(
	deny: string[],
	tool: string,
	input: Record<string, unknown>,
	cwd?: string,
): string | undefined {
	const verb = verbFor(tool);
	if (!verb || deny.length === 0) return undefined;
	const rawSubject = subject(tool, input);
	const pathSubject = rawSubject === "" && cwd && CWD_DEFAULTING_VERBS.has(verb) ? cwd : rawSubject;
	const subj = homeExpand(pathSubject);
	const isBash = verb === "Bash";
	let bashSubjects: string[] | undefined;
	const respellings = (): string[] => {
		bashSubjects ??= isBash ? bashRuleSubjects(subj) : [];
		return bashSubjects;
	};
	const pathCandidates: string[] = [];
	if (cwd && PATH_VERBS.has(verb) && pathSubject) {
		const resolved = resolveToCwd(pathSubject, cwd);
		pathCandidates.push(resolved);
		const real = realpathAllowingMissingLeaf(resolved);
		if (real !== undefined) pathCandidates.push(real);
	}

	let bashPaths: Record<BashPathUse, string[]> | undefined;

	const matches = (rule: string): boolean =>
		failClosed(() => {
			const parts = ruleParts(rule);
			if (parts === undefined) return false;
			const ruleVerb = capitalize(parts.verb);
			if (isBash && cwd && PATH_VERBS.has(ruleVerb)) {
				bashPaths ??= bashPathCandidates(respellings(), cwd);
				return bashCommandTouchesRulePath(bashPaths, ruleVerb, parts.subject, cwd);
			}
			if (!ruleVerbCovers(parts.verb, verb)) return false;
			if (verb === "WebFetch") {
				const domain = domainSpec(parts.subject);
				if (domain !== undefined) {
					const host = urlHost(subj);
					return host !== undefined && globToRegExp(domain).test(host);
				}
			}
			if (cwd && PATH_VERBS.has(verb)) {
				const patterns = pathRulePatterns(parts.subject, cwd);
				return pathCandidates.some((candidate) => patterns.some((pattern) => pattern.test(candidate)));
			}
			const patterns = [globToRegExp(parts.subject, isBash ? "command" : "path")];
			if (verb === "Mcp") patterns.push(...hashedMcpToolNamesByKeptPrefix(parts.subject));
			return [subj, ...respellings()].some((candidate) => patterns.some((pattern) => pattern.test(candidate)));
		});
	return deny.find(matches);
}

/** A grep match line's separator: `<file>:<n>: <text>`, or `<file>-<n>- <text>` for context. */
const GREP_LINE = /[:-]\d+[:-] /g;

export function grepOutputWithoutDenied(
	deny: string[],
	input: Record<string, unknown>,
	output: string,
	cwd: string,
): string | undefined {
	const dir = resolveToCwd(String(input.path ?? "") || ".", cwd);
	if (!isDirectory(dir)) return undefined;
	const anySplitNamesDeniedFile = (line: string) =>
		[...line.matchAll(GREP_LINE)].some(
			(m) => deniedBy(deny, "grep", { path: join(dir, line.slice(0, m.index)) }, cwd) !== undefined,
		);
	const lines = output.split("\n");
	const kept = lines.filter((line) => !anySplitNamesDeniedFile(line));
	if (kept.length === lines.length) return undefined;
	return kept.some((line) => new RegExp(GREP_LINE.source).test(line)) ? kept.join("\n") : "No matches found";
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
