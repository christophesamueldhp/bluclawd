/**
 * Deny-rule matching.
 *
 * Rules use a `Verb(glob)` syntax, e.g. `Bash(rm -rf *)`, `Read(~/.ssh/**)`.
 * `deniedBy()` returns the first rule that matches a tool call. A rule is widened to
 * every respelling of the call — bash wrappers peeled, paths resolved, symlinks
 * followed — since an extra candidate can only block more.
 *
 * Glob semantics:
 * - `*`  matches any run of characters EXCEPT `/`  → `[^/]*`
 * - `**` matches any characters INCLUDING `/` and newlines → `[\s\S]*`
 * - every other character — including spaces — is matched literally, so
 *   `Bash(npm *)` does not match `npmx`.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveToCwd } from "../_shared/path-resolve.ts";

/** Lowercase tool name → rule verb. MCP tools map to `Mcp(server:tool)` in `verbFor()`. */
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

function isMcpToolName(tool: string): boolean {
	return /^mcp__.+__.+$/.test(tool);
}

/** The rule verb for a tool name, or undefined when no rule can name it. */
function verbFor(tool: string): string | undefined {
	if (isMcpToolName(tool)) return "Mcp";
	return VERB[tool];
}

/** An `Edit` rule covers every file-editing tool, a `Read` rule every file-reading one. */
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
 * A rule string's verb and subject. A bare verb (`Bash`) covers every subject. The MCP
 * spellings `mcp__server`, `mcp__server__*` and `mcp__server__tool` read as
 * `Mcp(server:*)` / `Mcp(server:tool)`.
 */
function ruleParts(rule: string): { verb: string; subject: string } | undefined {
	const mcp = /^mcp__(.+?)(?:__(.+))?$/.exec(rule);
	if (mcp) return { verb: "mcp", subject: `${mcp[1]}:${mcp[2] ?? "*"}` };
	const m = /^(\w+)(?:\((.*)\))?$/.exec(rule);
	if (!m) return undefined;
	return { verb: m[1].toLowerCase(), subject: m[2] ?? "**" };
}

const REGEX_META = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\", "?"]);

/** Every query a websearch call runs: `query` and each of a batch's `queries`. */
export function searchQueries(input: Record<string, unknown>): string[] {
	const batch = Array.isArray(input.queries) ? input.queries.filter((q): q is string => typeof q === "string") : [];
	return typeof input.query === "string" && input.query !== "" ? [input.query, ...batch] : batch;
}

/**
 * The subject a rule matches: the command for bash, otherwise the path/url/query. For
 * grep/find/ls with no `path` this is ""; `deniedBy()` substitutes the cwd so omitting
 * the path cannot escape a rule.
 */
function subject(tool: string, input: Record<string, unknown>): string {
	if (isMcpToolName(tool)) {
		const m = /^mcp__(.+?)__(.+)$/.exec(tool);
		return m ? `${m[1]}:${m[2]}` : "";
	}
	if (tool === "subagent") return String(input.agent ?? "");
	if (tool === "websearch") return searchQueries(input)[0] ?? "";
	return tool === "bash" ? String(input.command ?? "") : String(input.path ?? input.url ?? input.query ?? "");
}

/** A rule as a person reads it: `\*` is a plain `*`. */
export function displayRule(rule: string): string {
	return rule.replace(/\\\*/g, "*");
}

/** The `<domain>` of a `domain:<domain>` rule subject, or undefined for a url-shaped one. */
function domainSpec(ruleSubject: string): string | undefined {
	const m = /^domain:\s*(.+)$/i.exec(ruleSubject.trim());
	return m ? m[1].trim().toLowerCase() : undefined;
}

/** Lowercase hostname of a url (IPv6 brackets stripped), or undefined when it does not parse. */
function urlHost(url: string): string | undefined {
	try {
		const host = new URL(url).hostname.toLowerCase();
		if (!host) return undefined;
		return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	} catch {
		return undefined;
	}
}

/**
 * Resolve symlinks in an absolute path, falling back to the parent directory's realpath
 * + basename when the leaf doesn't exist yet. `undefined` when even the parent can't be resolved.
 */
function realpathIfSymlink(absPath: string): string | undefined {
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

/** Rule verbs whose subject is a filesystem path. */
const PATH_VERBS = new Set(["Read", "Write", "Edit", "Grep", "Find", "Ls"]);

/** Verbs whose tool falls back to the working directory when `path` is omitted. */
const CWD_DEFAULTING_VERBS = new Set(["Grep", "Find", "Ls"]);

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A Read, Edit or Write rule's verb and path, the way the deny rules read it; undefined for any other rule. */
export function pathRule(rule: string): { verb: "Read" | "Edit" | "Write"; path: string } | undefined {
	const parts = ruleParts(rule);
	if (!parts) return undefined;
	const verb = capitalize(parts.verb);
	return verb === "Read" || verb === "Edit" || verb === "Write" ? { verb, path: parts.subject } : undefined;
}

function homeExpand(s: string): string {
	return s.replace(/^~/, process.env.HOME ?? "~");
}

/**
 * Compile a glob to an anchored RegExp. `pathLike: false` (bash) makes `*` cross `/`:
 * a command string is not a path, and `Bash(rm *)` must match `rm -rf /tmp/x`.
 */
function globToRegExp(pat: string, pathLike = true): RegExp {
	// `dir/**` also covers `dir` itself, so listing the directory is denied with its contents.
	const dirPrefix = pat.slice(0, -3);
	if (pathLike && pat.endsWith("/**") && !/^\/*$/.test(dirPrefix)) {
		return new RegExp(`^${globBody(dirPrefix, pathLike)}(?:/[\\s\\S]*)?$`);
	}
	// Prefix forms, bash only: `npm test:*` and `npm test *` are `npm test` alone or
	// followed by arguments — not `npm testx`.
	if (!pathLike && (pat.endsWith(":*") || pat.endsWith(" *"))) {
		return new RegExp(`^${globBody(pat.slice(0, -2), pathLike)}(?:\\s[\\s\\S]*)?$`);
	}
	return new RegExp(`^${globBody(pat, pathLike)}$`);
}

/** A path rule's patterns: a relative one (`.env`, `src/**`) also names its path under the cwd. */
function pathRulePatterns(ruleSubject: string, cwd: string): RegExp[] {
	const rawCandidates = [ruleSubject];
	if (!/^[/~*]/.test(ruleSubject)) rawCandidates.push(resolveToCwd(ruleSubject, cwd));
	const patterns: RegExp[] = [];
	for (const candidate of rawCandidates) {
		patterns.push(globToRegExp(candidate));
		const expanded = homeExpand(candidate.replace(/^\/\//, "/"));
		if (!expanded.startsWith("/")) continue;
		const starIdx = expanded.indexOf("*");
		const prefix = starIdx === -1 ? expanded : expanded.slice(0, expanded.lastIndexOf("/", starIdx));
		if (!prefix) continue;
		const realPrefix = realpathIfSymlink(prefix);
		if (realPrefix && realPrefix !== prefix) {
			const suffix = starIdx === -1 ? "" : expanded.slice(prefix.length);
			patterns.push(globToRegExp(`${realPrefix}${suffix}`));
		}
	}
	return patterns;
}

function globBody(pat: string, pathLike: boolean): string {
	// An absolute path rule may be spelled `//abs`; a single `/` is absolute too.
	const expanded = homeExpand(pathLike ? pat.replace(/^\/\//, "/") : pat);
	let body = "";
	for (let i = 0; i < expanded.length; i++) {
		const c = expanded[i];
		if (c === "\\" && expanded[i + 1] === "*") {
			body += "\\*";
			i++;
		} else if (c === "*") {
			if (expanded[i + 1] === "*") {
				// `.*` would let a multiline command escape a `**` rule.
				body += "[\\s\\S]*";
				i++;
			} else {
				body += pathLike ? "[^/]*" : "[\\s\\S]*";
			}
		} else if (REGEX_META.has(c)) {
			body += `\\${c}`;
		} else {
			body += c;
		}
	}
	return body;
}

/** Leading `VAR=value` assignments: `RM=1 rm x`. */
const ENV_ASSIGNMENTS = /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
/** A shell asked to run an inline command: `sh -c '…'`, `/bin/bash -lc "…"`. */
const SHELL_INLINE = /^(?:\S*\/)?(?:ba|z|k|da|a)?sh\s+(?:-\S+\s+)*-\S*c\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;
/**
 * Words that run the command after them: exec wrappers (`sudo -u root rm x`,
 * `timeout -s KILL 5 rm x`) and shell keywords (`if rm x`, `! rm x`). Their flags may
 * take a separate value, so every suffix after one is a candidate.
 */
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
/** How many tokens after a prefix word a command may start. */
const PREFIX_ARG_LIMIT = 8;
/** `flock` takes a lockfile/fd (and optional `-c`) before the command it wraps; `-w`/`-E` take a value. */
const FLOCK_WRAPPER = /^flock\s+(?:-[wE]\s+\S+\s+|-\S+\s+)*\S+\s+(?:-c\s+)?/;

/**
 * Split a bash command on `;`, `&`, `|`, newlines, subshell parens and backticks, so
 * `$(rm x)` is a segment too. Naive about quotes, which only blocks more.
 */
function bashSegments(command: string): string[] {
	return command
		.split(/[;\n()`]+|(?<!>)[&|]+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

/**
 * Every spelling of a bash command a rule is tested against: each segment, also with
 * env prefixes, wrappers, `\`, the binary's directory and `sh -c` peeled off.
 */
function bashRuleSubjects(command: string, depth = 0): string[] {
	const candidates = new Set<string>([command.trim()]);
	// A wrapper can nest; stop well before any input could make this expensive.
	if (depth > 3) return [...candidates].filter(Boolean);

	for (const rawSegment of bashSegments(command)) {
		let segment = rawSegment.trim();
		if (!segment) continue;
		candidates.add(segment);

		// Wrappers stack (`env FOO=1 watch -n5 rm -rf x`): peel until stable.
		let previous = "";
		while (previous !== segment) {
			previous = segment;
			segment = segment.replace(ENV_ASSIGNMENTS, "").replace(FLOCK_WRAPPER, "").trim();
		}
		candidates.add(segment);

		// `\rm` defeats an alias, not a rule.
		const unescaped = segment.replace(/^\\/, "");
		candidates.add(unescaped);

		// `{rm,-rf,x}` runs as `rm -rf x`.
		const braced = dequote(unescaped).split(/\s+/).flatMap(expandBraces).join(" ");
		for (const form of new Set([unescaped, dequote(unescaped), braced])) {
			candidates.add(form);
			// `/bin/rm x` is the same program as `rm x`.
			const [, binary, rest] = /^(\S+)([\s\S]*)$/.exec(form) ?? [];
			if (binary?.includes("/")) candidates.add(`${binary.slice(binary.lastIndexOf("/") + 1)}${rest ?? ""}`);

			const tokens = form.split(/\s+/);
			if (COMMAND_PREFIXES.has(basename(tokens[0] ?? ""))) {
				for (let i = 1; i < Math.min(tokens.length, PREFIX_ARG_LIMIT + 2); i++) {
					// A redirect target is not where a command starts.
					if (REDIRECT.test(tokens[i - 1])) continue;
					for (const nested of bashRuleSubjects(tokens.slice(i).join(" "), depth + 1)) candidates.add(nested);
				}
			}
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

/** The word the shell would see: quotes and backslashes removed (`'rm'`, `r""m`, `$'rm'`, `\rm`). */
function dequote(s: string): string {
	return s
		.replace(/\$(?=['"])/g, "")
		.replace(/\\(.)/g, "$1")
		.replace(/['"]/g, "");
}

/** Words one brace expansion may produce; past this it is denied rather than half-checked. */
const MAX_BRACE_WORDS = 10_000;

function tooManyBraceWords(word: string): Error {
	return new Error(`brace expansion too large to check: ${word}`);
}

/** The words of a `{x..y[..step]}` sequence (numbers, zero-padded as written, or letters); undefined when it is not one. */
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

/**
 * A word's brace expansion, as the shell does it before running the command:
 * `a{b,c}d`, nested groups, and `{1..5}` / `{a..e}` / `{01..10..2}`. `{x}`, `{}`, an
 * unclosed brace and `${VAR}` stay as written. Throws past `MAX_BRACE_WORDS`, which
 * `deniedBy` counts as a match.
 */
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

/** `$VAR` and `${VAR}` from this process's environment; unknown ones stay as written. */
function expandVars(s: string): string {
	return s.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, braced, bare) => process.env[braced ?? bare] ?? m);
}

/** Shell words retain quoted/escaped whitespace; operators stay separate for redirects. */
function shellWords(command: string): string[] {
	return command.match(/(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s'"\\<>;&|()])+|[<>]+&?/g) ?? [];
}

const GLOB_CHARS = /[*?[]/;
/** Directory entries one glob may scan; past this it is denied rather than half-checked. */
const MAX_GLOB_ENTRIES = 10_000;

/** One path segment of a shell glob as an anchored RegExp: `*`, `?` and `[...]` (`[!...]` negated). */
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

/**
 * The paths an absolute path's globs expand to on disk, as bash does without globstar:
 * per segment, and a leading dot only when the pattern writes one. Throws past
 * `MAX_GLOB_ENTRIES`, which `deniedBy` counts as a match.
 */
function expandGlob(absPath: string): string[] {
	let paths = ["/"];
	let scanned = 0;
	for (const segment of absPath.split("/").filter(Boolean)) {
		if (!GLOB_CHARS.test(segment)) {
			paths = paths.map((p) => join(p, segment));
			continue;
		}
		const pattern = globSegmentRegExp(segment);
		const next: string[] = [];
		for (const dir of paths) {
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			scanned += names.length;
			if (scanned > MAX_GLOB_ENTRIES) throw new Error(`glob too broad to check: ${absPath}`);
			for (const name of names) {
				if ((segment.startsWith(".") || !name.startsWith(".")) && pattern.test(name)) next.push(join(dir, name));
			}
		}
		paths = next;
	}
	return paths;
}

/**
 * Every path a bash command names, resolved like a tool path, so a Read/Edit rule
 * reaches `cat ~/.ssh/id_rsa`. Redirect targets always count; another word counts when
 * it looks like a path (`/`, `~`, `.`), is a glob, or exists, relative to the cwd or
 * any `cd` target. A glob also counts as every path it expands to, so `cat ~/.ss?/id_rsa`
 * is caught too. Which words the command really opens is unknown; testing them all only blocks more.
 *
 * Paths come back by how the command uses them: an output redirect target is written,
 * never read — `>>` appends (`append`), any other `>` truncates (`truncate`). Everything
 * else, `<` included, may be read (`plain`).
 */
function bashPathCandidates(subjects: string[], cwd: string): Record<BashPathUse, string[]> {
	const words: Record<BashPathUse, Set<string>> = { plain: new Set(), append: new Set(), truncate: new Set() };
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
				// `--file=x`, `if=/dev/sda`: the value is the path.
				const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : "";
				if (value) words[use].add(value);
				if (token && !token.startsWith("-")) words[use].add(token);
			}
		}
	}
	const resolve = (uses: Set<string>): string[] => {
		const out = new Set<string>();
		const addPath = (path: string) => {
			out.add(path);
			const real = realpathIfSymlink(path);
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
					out.add(homeExpand(word));
					addResolved(word, base);
				}
			}
		}
		return [...out];
	};
	return { plain: resolve(words.plain), append: resolve(words.append), truncate: resolve(words.truncate) };
}

type BashPathUse = "plain" | "append" | "truncate";

/** A redirect operator token: `<`, `>`, `>>`, `2>`, `>&`, `<<`. */
const REDIRECT = /^\d*[<>]+&?$/;

/** How the word after `previous` is used: written when `previous` is an output redirect. */
function redirectUse(previous: string | undefined): BashPathUse {
	if (previous === undefined || !REDIRECT.test(previous) || previous.includes("<")) return "plain";
	return /^\d*>>$/.test(previous) ? "append" : "truncate";
}

/**
 * The bash path uses a file rule guards: a Read-family rule what may be read, a Write
 * rule also what is overwritten, an Edit rule every change, appends included.
 */
const BASH_USES_GUARDED: Record<string, BashPathUse[]> = {
	Write: ["plain", "truncate"],
	Edit: ["plain", "truncate", "append"],
};

/**
 * The first rule in `deny` that matches this tool call, or undefined. A rule that fails
 * to compile counts as a match: a broken deny rule must not silently let a call through.
 */
export function deniedBy(
	deny: string[],
	tool: string,
	input: Record<string, unknown>,
	cwd?: string,
): string | undefined {
	const verb = verbFor(tool);
	if (!verb || deny.length === 0) return undefined;
	const rawSubject = subject(tool, input);
	const subj = homeExpand(rawSubject === "" && cwd && CWD_DEFAULTING_VERBS.has(verb) ? cwd : rawSubject);
	const isBash = verb === "Bash";
	// Computed inside `matches`, so a command too large to check is caught there and denied.
	let bashSubjects: string[] | undefined;
	const respellings = (): string[] => {
		bashSubjects ??= isBash ? bashRuleSubjects(subj) : [];
		return bashSubjects;
	};
	const pathCandidates: string[] = [];
	if (cwd && PATH_VERBS.has(verb) && subj) {
		const resolved = resolveToCwd(subj, cwd);
		pathCandidates.push(homeExpand(resolved));
		const real = realpathIfSymlink(resolved);
		if (real !== undefined) pathCandidates.push(real);
	}

	let bashPaths: Record<BashPathUse, string[]> | undefined;

	const matches = (rule: string): boolean => {
		try {
			const parts = ruleParts(rule);
			if (parts === undefined) return false;
			// A file rule also guards the paths a bash command names.
			const ruleVerb = capitalize(parts.verb);
			if (isBash && cwd && PATH_VERBS.has(ruleVerb)) {
				bashPaths ??= bashPathCandidates(respellings(), cwd);
				const paths = bashPaths;
				const patterns = pathRulePatterns(parts.subject, cwd);
				return (BASH_USES_GUARDED[ruleVerb] ?? ["plain"]).some((use) =>
					paths[use].some((candidate) => patterns.some((pattern) => pattern.test(candidate))),
				);
			}
			if (!ruleVerbCovers(parts.verb, verb)) return false;
			if (verb === "WebFetch") {
				const domain = domainSpec(parts.subject);
				if (domain !== undefined) {
					const host = urlHost(subj);
					return host !== undefined && globToRegExp(domain).test(host);
				}
			}
			const patterns =
				cwd && PATH_VERBS.has(verb) ? pathRulePatterns(parts.subject, cwd) : [globToRegExp(parts.subject, !isBash)];
			return [subj, ...respellings(), ...pathCandidates].some((candidate) =>
				patterns.some((pattern) => pattern.test(candidate)),
			);
		} catch {
			return true;
		}
	};
	return deny.find(matches);
}

/** A grep match line's separator: `<file>:<n>: <text>`, or `<file>-<n>- <text>` for context. */
const GREP_LINE = /[:-]\d+[:-] /g;

/**
 * A folder grep's output without the lines from files a rule denies, or undefined when it
 * has none. A file name can hold a separator too, so every split of a line is tried.
 */
export function grepOutputWithoutDenied(
	deny: string[],
	input: Record<string, unknown>,
	output: string,
	cwd: string,
): string | undefined {
	const dir = resolveToCwd(String(input.path ?? "") || ".", cwd);
	// A one-file grep was judged before it ran.
	if (!isDirectory(dir)) return undefined;
	const fromDenied = (line: string) =>
		[...line.matchAll(GREP_LINE)].some(
			(m) => deniedBy(deny, "grep", { path: join(dir, line.slice(0, m.index)) }, cwd) !== undefined,
		);
	const lines = output.split("\n");
	const kept = lines.filter((line) => !fromDenied(line));
	if (kept.length === lines.length) return undefined;
	return kept.some((line) => new RegExp(GREP_LINE.source).test(line)) ? kept.join("\n") : "No matches found";
}

/**
 * Filter denied paths out of `find` or `ls` output for a directory search.
 */
export function pathListOutputWithoutDenied(
	deny: string[],
	tool: "find" | "ls",
	input: Record<string, unknown>,
	output: string,
	cwd: string,
): string | undefined {
	if (deny.length === 0) return undefined;
	const dir = resolveToCwd(String(input.path ?? "") || ".", cwd);
	if (!isDirectory(dir)) return undefined;
	const emptyText = tool === "find" ? "No files found matching pattern" : "(empty directory)";
	if (output === emptyText) return undefined;

	const lines = output.split("\n");
	let changed = false;
	const keptLines: string[] = [];
	let keptEntries = 0;

	for (const line of lines) {
		if (line === "" || (line.startsWith("[") && line.endsWith("]"))) {
			keptLines.push(line);
			continue;
		}
		const normalizedEntry = line.endsWith("/") ? line.slice(0, -1) : line;
		const candidatePath = join(dir, normalizedEntry);
		if (deniedBy(deny, tool, { path: candidatePath }, cwd) !== undefined) {
			changed = true;
			continue;
		}
		keptEntries++;
		keptLines.push(line);
	}

	if (!changed) return undefined;
	if (keptEntries === 0) return emptyText;
	return keptLines.join("\n").replace(/^\n+/, "");
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
