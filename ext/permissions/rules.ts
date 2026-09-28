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

import { realpathSync } from "node:fs";
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
};

export function isMcpToolName(tool: string): boolean {
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
export function subject(tool: string, input: Record<string, unknown>): string {
	if (isMcpToolName(tool)) {
		const m = /^mcp__(.+?)__(.+)$/.exec(tool);
		return m ? `${m[1]}:${m[2]}` : "";
	}
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

function homeExpand(s: string): string {
	return s.replace(/^~/, process.env.HOME ?? "~");
}

/**
 * Compile a glob to an anchored RegExp. `pathLike: false` (bash) makes `*` cross `/`:
 * a command string is not a path, and `Bash(rm *)` must match `rm -rf /tmp/x`.
 */
function globToRegExp(pat: string, pathLike = true): RegExp {
	// Prefix forms, bash only: `npm test:*` and `npm test *` are `npm test` alone or
	// followed by arguments — not `npm testx`.
	if (!pathLike && (pat.endsWith(":*") || pat.endsWith(" *"))) {
		return new RegExp(`^${globBody(pat.slice(0, -2), pathLike)}(?:\\s[\\s\\S]*)?$`);
	}
	return new RegExp(`^${globBody(pat, pathLike)}$`);
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
/** An `env` wrapper with its own flags/assignments: `env -i FOO=bar rm x`. */
const ENV_WRAPPER = /^env\s+(?:-\S+\s+|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/;
/** A shell asked to run an inline command: `sh -c '…'`, `/bin/bash -lc "…"`. */
const SHELL_INLINE = /^(?:\S*\/)?(?:ba|z|k|da|a)?sh\s+(?:-\S+\s+)*-\S*c\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;
/**
 * Exec wrappers that take a full command as trailing arguments: `watch rm -rf x`,
 * `nohup rm -rf x`, `echo x | xargs rm -rf`. A flag whose value is a separate token
 * (`watch -n 5 …`) is not fully stripped, which only leaves noise in the candidate.
 */
const EXEC_WRAPPER = /^(?:watch|setsid|ionice|nohup|xargs)\s+(?:-\S+\s+)*/;
/** `flock` takes a lockfile/fd (and optional `-c`) before the command it wraps; `-w`/`-E` take a value. */
const FLOCK_WRAPPER = /^flock\s+(?:-[wE]\s+\S+\s+|-\S+\s+)*\S+\s+(?:-c\s+)?/;

/** Split a bash command on `;`, `&`, `|` and newlines. Naive about quotes, which only blocks more. */
function bashSegments(command: string): string[] {
	return command
		.split(/[;\n]+|(?<!>)[&|]+/)
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
			segment = segment
				.replace(ENV_ASSIGNMENTS, "")
				.replace(ENV_WRAPPER, "")
				.replace(EXEC_WRAPPER, "")
				.replace(FLOCK_WRAPPER, "")
				.trim();
		}
		candidates.add(segment);

		// `\rm` defeats an alias, not a rule.
		const unescaped = segment.replace(/^\\/, "");
		candidates.add(unescaped);

		// `/bin/rm x` is the same program as `rm x`.
		const [, binary, rest] = /^(\S+)([\s\S]*)$/.exec(unescaped) ?? [];
		if (binary?.includes("/")) candidates.add(`${binary.slice(binary.lastIndexOf("/") + 1)}${rest ?? ""}`);

		const inline = SHELL_INLINE.exec(unescaped);
		if (inline) {
			for (const nested of bashRuleSubjects(inline[1] ?? inline[2] ?? inline[3] ?? "", depth + 1)) {
				candidates.add(nested);
			}
		}
	}
	return [...candidates].filter(Boolean);
}

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
	const bashSubjects = isBash ? bashRuleSubjects(subj) : [];
	const pathCandidates: string[] = [];
	if (cwd && PATH_VERBS.has(verb) && subj) {
		const resolved = resolveToCwd(subj, cwd);
		pathCandidates.push(homeExpand(resolved));
		const real = realpathIfSymlink(resolved);
		if (real !== undefined) pathCandidates.push(real);
	}

	const matches = (rule: string): boolean => {
		try {
			const parts = ruleParts(rule);
			if (parts === undefined || !ruleVerbCovers(parts.verb, verb)) return false;
			if (verb === "WebFetch") {
				const domain = domainSpec(parts.subject);
				if (domain !== undefined) {
					const host = urlHost(subj);
					return host !== undefined && globToRegExp(domain).test(host);
				}
			}
			const pattern = globToRegExp(parts.subject, !isBash);
			return [subj, ...bashSubjects, ...pathCandidates].some((candidate) => pattern.test(candidate));
		} catch {
			return true;
		}
	};
	return deny.find(matches);
}
