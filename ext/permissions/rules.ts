/**
 * Permission-rule engine.
 *
 * Rules use a `Verb(glob)` syntax, e.g. `Bash(npm *)`, `Read(~/.ssh/**)`.
 * `decide()` resolves a tool call against a rule set with fixed
 * deny > ask > allow precedence and returns the winning kind, or `null` when
 * no rule governs the call. The one I/O exception: a deny/ask path rule also
 * matches the subject's realpath, so a symlink cannot dodge it.
 *
 * Glob semantics:
 * - `*`  matches any run of characters EXCEPT `/`  → `[^/]*`
 * - `**` matches any characters INCLUDING `/` and newlines → `[\s\S]*`
 * - every other character — including spaces — is matched literally, so
 *   `Bash(npm *)` does not match `npmx`.
 */

export type Decision = "allow" | "ask" | "deny";
export type Rules = { allow?: string[]; ask?: string[]; deny?: string[] };

import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { resolveToCwd } from "../_shared/path-resolve.ts";
import { COMMAND_SUBSTITUTION } from "./safe-command.ts";

/**
 * Lowercase tool name → capitalized rule verb. MCP tools are governed via
 * `verbFor()`: `mcp__server__tool` → `Mcp(server:tool)`.
 */
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

/** The governed rule verb for a tool name, or undefined when ungoverned. */
function verbFor(tool: string): string | undefined {
	if (isMcpToolName(tool)) return "Mcp";
	return VERB[tool];
}

/** The rule verbs this engine governs. Build "every governable tool" rules from this, not a copy. */
export function governedVerbs(): string[] {
	return [...Object.values(VERB), "Mcp"];
}

/**
 * Rule verbs that reach more tools than their own: an `Edit` rule covers every
 * file-editing tool, a `Read` rule every file-reading one. Keyed by the tool's verb.
 */
const COVERING_VERBS: Record<string, string[]> = {
	Write: ["edit"],
	Grep: ["read"],
	Find: ["read"],
	Ls: ["read"],
};

/** Does a rule written with `ruleVerb` govern a tool whose own verb is `verb`? */
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

/**
 * Drop one layer of wrapping quotes: a rule spec almost always needs shell-style quoting
 * to survive the command line (`add deny "Bash(curl **)"`), and the quotes are not part of
 * the rule. Unbalanced or absent quotes are left alone.
 */
export function stripWrappingQuotes(raw: string): string {
	const s = raw.trim();
	const q = s[0];
	if ((q === '"' || q === "'") && s.length >= 2 && s.at(-1) === q) return s.slice(1, -1).trim();
	return s;
}

/**
 * Invert a `Verb(subject)` string back into the `{tool, input}` a tool call would carry,
 * so a rule spec can be run through the same engine that governs live calls. Returns
 * undefined for a malformed spec or an ungoverned verb.
 */
export function parseRuleSpec(spec: string): { tool: string; input: Record<string, unknown> } | undefined {
	const parts = ruleParts(stripWrappingQuotes(spec));
	if (!parts) return undefined;
	const { verb } = parts;
	const subj = unescapeGlob(parts.subject);

	if (verb === "mcp") {
		const [server, ...rest] = subj.split(":");
		if (!server || rest.length === 0) return undefined;
		return { tool: `mcp__${server}__${rest.join(":")}`, input: {} };
	}
	const tool = Object.keys(VERB).find((t) => VERB[t].toLowerCase() === verb);
	if (!tool) return undefined;
	if (tool === "bash") return { tool, input: { command: subj } };
	if (tool === "webfetch") {
		// `WebFetch(domain:example.com)` names a host, not a url; hand back a url on
		// that host so the spec goes through the same matcher as live calls.
		const domain = domainSpec(subj);
		return { tool, input: { url: domain !== undefined ? `https://${domain}/` : subj } };
	}
	if (tool === "websearch") return { tool, input: { query: subj } };
	return { tool, input: { path: subj.replace(/^\/\//, "/") } };
}

const REGEX_META = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\", "?"]);

/** Every query a websearch call runs: `query` and each of a batch's `queries`. */
export function searchQueries(input: Record<string, unknown>): string[] {
	const batch = Array.isArray(input.queries) ? input.queries.filter((q): q is string => typeof q === "string") : [];
	return typeof input.query === "string" && input.query !== "" ? [input.query, ...batch] : batch;
}

/**
 * The governed subject for a tool call: the command for bash, otherwise the
 * path/url/query. For grep/find/ls with no `path` this returns ""; `decide()`
 * substitutes the cwd (see CWD_DEFAULTING_VERBS) so omitting it cannot escape a rule.
 */
export function subject(tool: string, input: Record<string, unknown>): string {
	if (isMcpToolName(tool)) {
		const m = /^mcp__(.+?)__(.+)$/.exec(tool);
		return m ? `${m[1]}:${m[2]}` : "";
	}
	if (tool === "websearch") return searchQueries(input)[0] ?? "";
	return tool === "bash" ? String(input.command ?? "") : String(input.path ?? input.url ?? input.query ?? "");
}

/**
 * Build the exact-match allow rule string for a tool call subject, e.g.
 * `Bash(npm install)`. Returns null for ungoverned tools. Used by "don't ask again".
 */
export function exactRule(tool: string, subj: string): string | null {
	const verb = verbFor(tool);
	if (!verb) return null;
	// "don't ask again" on a fetch persists the HOST: a rule pinned to a full url
	// would never fire again.
	if (tool === "webfetch") {
		const host = urlHost(subj);
		if (host !== undefined) return `${verb}(domain:${host})`;
	}
	return `${verb}(${escapeGlob(subj)})`;
}

/** Most rules saved for a single compound command. */
export const MAX_COMPOUND_ALLOW_RULES = 5;

/** Tools whose second word names what runs: `git push`, not `git`. */
const SUBCOMMAND_TOOLS = new Set([
	"git",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"npx",
	"bunx",
	"uv",
	"uvx",
	"pip",
	"pip3",
	"cargo",
	"go",
	"docker",
	"kubectl",
	"gh",
	"brew",
	"make",
	"just",
	"deno",
	"dotnet",
	"mvn",
	"gradle",
	"terraform",
]);

/**
 * Commands that run whatever their arguments say — a shell, an interpreter, a wrapper.
 * A prefix rule for one would grant arbitrary code, so they only ever get an exact rule.
 */
const NO_PREFIX = new Set([
	"sh",
	"bash",
	"zsh",
	"fish",
	"dash",
	"ksh",
	"python",
	"python3",
	"node",
	"ruby",
	"perl",
	"php",
	"env",
	"sudo",
	"su",
	"doas",
	"xargs",
	"eval",
	"exec",
	"nohup",
	"watch",
	"time",
	"timeout",
	"nice",
	"command",
	"builtin",
	"source",
	".",
	"ssh",
	"osascript",
]);

/**
 * The command prefix "don't ask again" offers for one bash segment — `npm test` for
 * `npm test -- --watch`, `npm run build` for `npm run build --prod`, `ls` for `ls -la` —
 * or undefined when only the exact command is safe to grant.
 */
export function commandPrefix(segment: string): string | undefined {
	// A prefix rule never allows a substitution (see `allowsSubstitution`), so offering
	// one would ask again next time.
	if (COMMAND_SUBSTITUTION.test(segment)) return undefined;
	const words = segment.trim().split(/\s+/);
	const [head, second, third] = words;
	if (!head || !/^[\w.+-]+$/.test(head) || NO_PREFIX.has(head)) return undefined;
	const word = (w: string | undefined): w is string => w !== undefined && /^[a-z][\w:.-]*$/i.test(w);
	if (!SUBCOMMAND_TOOLS.has(head)) return head;
	// `git --no-pager log` would widen to all of git: only the exact command is safe.
	if (!word(second)) return undefined;
	return second === "run" && word(third) ? `${head} run ${third}` : `${head} ${second}`;
}

/**
 * The allow rules "Yes, and don't ask again" persists for a call: a `Bash(<prefix>:*)`
 * per segment of a bash command (up to {@link MAX_COMPOUND_ALLOW_RULES}; past that, the
 * exact line), the host for a fetch, the exact subject for everything else. Empty for a
 * tool no rule verb governs.
 */
export function standingRules(tool: string, subj: string): string[] {
	const exact = exactRule(tool, subj);
	if (exact === null) return [];
	if (tool !== "bash") return [exact];
	const segments = bashSegments(subj);
	if (segments.length > MAX_COMPOUND_ALLOW_RULES) return [exact];
	const rules = segments.map((segment) => {
		const prefix = commandPrefix(segment);
		return prefix ? `Bash(${prefix}:*)` : `Bash(${escapeGlob(segment)})`;
	});
	return [...new Set(rules)];
}

/**
 * `\*` is a literal `*` in a rule. An exact rule escapes every `*` of its subject, or
 * "don't ask again" on `ls *.ts` would persist a live glob that also grants
 * `ls $(rm -rf ~).ts`.
 */
function escapeGlob(subj: string): string {
	return subj.replace(/\*/g, "\\*");
}

/** A rule as a person reads it: the `\*` an exact rule stores is a plain `*`. */
export function displayRule(rule: string): string {
	return unescapeGlob(rule);
}

function unescapeGlob(subj: string): string {
	return subj.replace(/\\\*/g, "*");
}

/** A rule subject with no live wildcard, as the literal string it matches; undefined otherwise. */
function literalSubject(pattern: string): string | undefined {
	return /(?:^|[^\\])\*/.test(pattern) ? undefined : homeExpand(unescapeGlob(pattern));
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
 * Agent-config files identified by name alone. `.mcp.json` sits at the project root and
 * names a `command` spawned at session start, before any `Mcp()` rule applies, so
 * gating its writes is the only place a gate can sit.
 */
const PROTECTED_FILENAMES = [".mcp.json"];

/**
 * Directory names that configure the agent, the repo, or the toolchain. Every entry
 * can lead to code execution: husky hooks run on commit, VS Code tasks and devcontainer
 * lifecycle commands run shell, `.cargo/config.toml` can name a custom linker, and
 * `.yarn/releases` holds the yarn binary itself.
 */
const PROTECTED_SEGMENTS = [
	".git",
	".claude",
	".vscode",
	".idea",
	".husky",
	".cargo",
	".devcontainer",
	".yarn",
	".mvn",
];

/**
 * Resolve symlinks in an absolute path, falling back to the parent directory's realpath
 * + basename when the leaf doesn't exist yet (a write creating it through a symlinked
 * directory). Returns `undefined` when even the parent can't be resolved.
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

/**
 * Is `rawPath` inside territory that configures the agent, the repo or the toolchain?
 * Such paths are never auto-approved.
 */
export function isProtectedPath(rawPath: string, cwd: string, agentDir: string, configDirName: string): boolean {
	const abs = resolveToCwd(rawPath, cwd);
	// Compare BOTH the literal path and its realpath: a repo-supplied symlink
	// (`ln -s .git gitdir` → `gitdir/hooks/pre-commit`) resolves to protected
	// territory while its literal segments do not.
	const candidates = new Set([abs]);
	try {
		candidates.add(realpathSync(abs));
	} catch {
		// Target may not exist yet (a write creating it) — check the parent so
		// a symlinked DIRECTORY still resolves.
		try {
			const parent = dirname(abs);
			candidates.add(join(realpathSync(parent), basename(abs)));
		} catch {
			// Neither exists; the literal check below still applies.
		}
	}

	// macOS and Windows filesystems are case-insensitive by default, so `.GIT`
	// and `.BLUCLAWD` reach the same files as the lowercase names.
	const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
	const eq = (a: string, b: string): boolean => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);

	const agentAbs = resolveToCwd(agentDir, cwd);
	const agentPrefix = agentAbs.endsWith(sep) ? agentAbs : agentAbs + sep;
	for (const candidate of candidates) {
		const segments = candidate.split(sep);
		if (
			segments.some((segment, i) => {
				if (eq(segment, configDirName)) return true;
				// `.claude/worktrees` holds working copies, not configuration. The
				// carve-out applies ONLY to the `.claude` segment: a worktree still
				// contains a real `.git` and project config dir that stay protected.
				if (eq(segment, ".claude")) return !eq(segments[i + 1] ?? "", "worktrees");
				if (PROTECTED_SEGMENTS.some((protectedSeg) => eq(segment, protectedSeg))) return true;
				// `.config/git` is the only two-segment entry in the set.
				return eq(segment, ".config") && eq(segments[i + 1] ?? "", "git");
			})
		) {
			return true;
		}
		if (PROTECTED_FILENAMES.some((name) => eq(name, basename(candidate)))) return true;
		if (eq(candidate, agentAbs)) return true;
		if (
			caseInsensitive
				? candidate.toLowerCase().startsWith(agentPrefix.toLowerCase())
				: candidate.startsWith(agentPrefix)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Agent files whose CONTENTS are secrets or grant execution. Reads get this narrower
 * set than writes: gating every read under `.git` would prompt constantly and train
 * people to approve without reading.
 */
const READ_PROTECTED_FILES = ["auth.json", "mcp.json", "settings.json", "hooks.json", "trust.json"];

/** Is reading `rawPath` a read of agent credentials or executable config? */
export function isReadProtectedPath(rawPath: string, cwd: string, agentDir: string, configDirName: string): boolean {
	const abs = resolveToCwd(rawPath, cwd);
	const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
	const eq = (a: string, b: string): boolean => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
	// Match the filename the way the filesystem does: on darwin/win32 `Auth.json`
	// opens auth.json. `.mcp.json` is protected wherever it sits — its server
	// headers routinely carry a bearer token.
	if (PROTECTED_FILENAMES.some((name) => eq(name, basename(abs)))) return true;
	if (!READ_PROTECTED_FILES.some((name) => eq(name, basename(abs)))) return false;
	const parent = dirname(abs);
	const agentAbs = resolveToCwd(agentDir, cwd);
	return eq(parent, agentAbs) || eq(basename(parent), configDirName);
}

/**
 * {@link isReadProtectedPath} for a shell word whose basename may be a wildcard:
 * `~/.pi/agent/*.json` expands to auth.json before the command ever sees it.
 */
export function isReadProtectedPattern(word: string, cwd: string, agentDir: string, configDirName: string): boolean {
	if (isReadProtectedPath(word, cwd, agentDir, configDirName)) return true;
	const name = basename(word);
	if (!/[*?[]/.test(name)) return false;
	// `[…]` stays a character class; over-matching here only prompts more.
	const glob = name
		.replace(/[.+^${}()|\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	let re: RegExp;
	try {
		re = new RegExp(`^${glob}$`, "i");
	} catch {
		return false; // an unbalanced `[` is no glob the shell would expand either
	}
	return [...PROTECTED_FILENAMES, ...READ_PROTECTED_FILES].some(
		(file) => re.test(file) && isReadProtectedPath(join(dirname(word), file), cwd, agentDir, configDirName),
	);
}

/**
 * Does a recursive search rooted at `rawPath` reach credential-bearing config? pi's
 * grep runs with `--hidden`, so searching the agent dir, a config dir, or any ancestor
 * of the agent dir (`~`, `/`) reads auth.json and mcp.json.
 */
export function searchReachesProtectedFiles(
	rawPath: string,
	cwd: string,
	agentDir: string,
	configDirName: string,
): boolean {
	const abs = resolveToCwd(rawPath, cwd);
	const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
	const norm = (s: string): string => (caseInsensitive ? s.toLowerCase() : s);
	const agentAbs = norm(resolveToCwd(agentDir, cwd));
	const a = norm(abs);
	const withSep = (s: string): string => (s.endsWith(sep) ? s : s + sep);
	if (a === agentAbs || a.startsWith(withSep(agentAbs)) || agentAbs.startsWith(withSep(a))) return true;
	return a.split(sep).some((segment) => segment === norm(configDirName));
}

/** Rule verbs whose subject is a filesystem path (so it can also be resolved). */
const PATH_VERBS = new Set(["Read", "Write", "Edit", "Grep", "Find", "Ls"]);

/**
 * Verbs whose tool takes an OPTIONAL path and falls back to the working directory.
 * An omitted path would give an empty subject that no deny glob matches, so the cwd
 * is substituted. read/write/edit are NOT here: their path is required.
 */
const CWD_DEFAULTING_VERBS = new Set(["Grep", "Find", "Ls"]);

function homeExpand(s: string): string {
	return s.replace(/^~/, process.env.HOME ?? "~");
}

/**
 * Compile a glob pattern to an anchored RegExp per the semantics documented
 * above. `pathLike: false` (Bash subjects) makes `*` cross `/` — a command
 * string is not a path, and `deny: Bash(rm *)` must match `rm -rf /tmp/x`.
 */
function globToRegExp(pat: string, pathLike = true): RegExp {
	// Prefix forms, bash only: `npm test:*` and `npm test *` are `npm test` alone or
	// followed by arguments — not `npm testx`, which `npm test*` would also grant.
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
				// ** crosses / AND newlines: `.*` would let a multiline command escape
				// a `**` deny rule.
				body += "[\\s\\S]*";
				i++;
			} else {
				body += pathLike ? "[^/]*" : "[\\s\\S]*"; // * stops at / only for paths
			}
		} else if (REGEX_META.has(c)) {
			body += `\\${c}`; // escape metachar (space stays literal — it is not in REGEX_META)
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
 * `nohup rm -rf x`, `echo x | xargs rm -rf`. `deny: Bash(rm *)` must see through them.
 * A flag whose value is a separate token (`watch -n 5 …`) is not fully stripped, which
 * leaves noise in the candidate rather than mis-identifying the wrapped command.
 */
const EXEC_WRAPPER = /^(?:watch|setsid|ionice|nohup|xargs)\s+(?:-\S+\s+)*/;
/** `flock` also takes a lockfile/fd positional (and optional `-c`) before the command it
 *  wraps. `-w` and `-E` take a value, so they are special-cased or the value would be
 *  mistaken for the lockfile. */
const FLOCK_WRAPPER = /^flock\s+(?:-[wE]\s+\S+\s+|-\S+\s+)*\S+\s+(?:-c\s+)?/;

/**
 * Split a bash command on `;`, `&`, `|` and newlines. Naive about quotes, which
 * over-splits `echo "a; rm b"`; for deny and ask an extra candidate can only block or
 * prompt more.
 */
export function bashSegments(command: string): string[] {
	return command
		.split(/[;\n]+|(?<!>)[&|]+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

/**
 * Every spelling of a bash command a deny rule should be tested against: each segment,
 * also with env prefixes, wrappers, `\`, the binary's directory and `sh -c` peeled off.
 * The original spelling is always kept so a rule naming a full path still matches.
 */
export function bashRuleSubjects(command: string, depth = 0): string[] {
	const candidates = new Set<string>([command.trim()]);
	// A wrapper can nest; stop well before any input could make this expensive.
	if (depth > 3) return [...candidates].filter(Boolean);

	for (const rawSegment of bashSegments(command)) {
		let segment = rawSegment.trim();
		if (!segment) continue;
		candidates.add(segment);

		// Peel env assignments, `env`, and exec wrappers until none applies — a wrapper
		// can stack (`env FOO=1 watch -n5 rm -rf x`), so this repeats until stable.
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
 * `$(…)`, backticks and `<(…)` run arbitrary code before the command a glob names, so
 * `Bash(git *)` must not grant `git $(rm -rf ~)`. Only a rule with no wildcard — the
 * exact one "don't ask again" persists — can allow such a command.
 */
function allowsSubstitution(ruleSubject: string, command: string): boolean {
	return literalSubject(ruleSubject) === command;
}

/**
 * Resolve a tool call against the rule set. Returns the winning decision kind, or
 * null when no rule matches (or the tool is ungoverned). Precedence: deny > ask > allow.
 */
export function decide(rules: Rules, tool: string, input: Record<string, unknown>, cwd?: string): Decision | null {
	const verb = verbFor(tool);
	if (!verb) return null; // unknown/extension tools: not governed
	const rawSubject = subject(tool, input);
	const subj = homeExpand(rawSubject === "" && cwd && CWD_DEFAULTING_VERBS.has(verb) ? cwd : rawSubject);
	const isBash = verb === "Bash";
	const bashSubjects = isBash ? bashRuleSubjects(subj) : undefined;
	const segments = isBash ? bashSegments(subj) : undefined;
	// Path subjects arrive as the tool was called (`./x`, `../y`); the resolved path is an
	// extra candidate so rules written against a resolved shape still match.
	const resolvedSubject = cwd && PATH_VERBS.has(verb) && subj ? homeExpand(resolveToCwd(subj, cwd)) : undefined;
	// A deny/ask path rule also catches a symlink pointing into its territory. This is
	// filesystem I/O, so it is lazy (deny/ask only, never allow) and memoized.
	let realpathSubjectComputed = false;
	let realpathSubject: string | undefined;
	const getRealpathSubject = (): string | undefined => {
		if (!realpathSubjectComputed) {
			realpathSubjectComputed = true;
			realpathSubject = cwd && PATH_VERBS.has(verb) && subj ? realpathIfSymlink(resolveToCwd(subj, cwd)) : undefined;
		}
		return realpathSubject;
	};
	// A rule that fails to compile/test must never crash the tool_call gate. Fail closed:
	// a broken `deny` counts as a match; a broken `allow`/`ask` is ignored.
	const matches = (r: string, failClosed: boolean, kind: Decision): boolean => {
		try {
			const parts = ruleParts(r);
			// Case-insensitive: `bash(**)` would otherwise be stored and never enforced.
			if (parts === undefined || !ruleVerbCovers(parts.verb, verb)) return false;
			const ruleSubject = parts.subject;
			// A `domain:` fetch rule is matched against the url's HOST alone, so it
			// covers every path and port there — the only shape worth persisting.
			if (verb === "WebFetch") {
				const domain = domainSpec(ruleSubject);
				if (domain !== undefined) {
					const host = urlHost(subj);
					return host !== undefined && globToRegExp(domain).test(host);
				}
			}
			if (kind === "allow" && isBash && COMMAND_SUBSTITUTION.test(subj))
				return allowsSubstitution(ruleSubject, subj);
			// Bash subjects are command strings, not paths.
			const pattern = globToRegExp(ruleSubject, !isBash);
			if (pattern.test(subj)) {
				// A whole-line match is enough for deny/ask. For allow it is not: the
				// bash glob does not stop at `/`, so `Bash(ls *)` spans the entire line
				// and would grant `ls -la; rm -rf /`. Every segment must be permitted.
				if (kind !== "allow" || !segments) return true;
				return segments.every((segment) => pattern.test(segment));
			}
			// deny/ask additionally widen to every respelling of the command; an extra
			// candidate can only ever block or prompt more.
			if (kind !== "allow" && bashSubjects) return bashSubjects.some((candidate) => pattern.test(candidate));
			// Same asymmetry for paths: widening deny/ask can only block or prompt
			// more, while widening allow would grant paths the rule never named.
			if (kind !== "allow" && resolvedSubject !== undefined && pattern.test(resolvedSubject)) return true;
			// A symlink into (or out of) the rule's territory — same widen-deny/ask-only
			// asymmetry, checked last since it is the only candidate that touches disk.
			if (kind !== "allow") {
				const symlinkTarget = getRealpathSubject();
				if (symlinkTarget !== undefined) return pattern.test(symlinkTarget);
			}
			return false;
		} catch {
			return failClosed;
		}
	};
	// Each segment of a compound bash command may be allowed by a DIFFERENT rule ("don't
	// ask again" persists one per segment). Deny/ask still match on any one segment.
	if (isBash && segments && segments.length > 1) {
		for (const kind of ["deny", "ask"] as const) {
			if ((rules[kind] ?? []).some((r) => matches(r, kind === "deny", kind))) return kind;
		}
		const allowRules = rules.allow ?? [];
		// An exact rule for the whole line is the user's answer to exactly this command:
		// "don't ask again" persists one past the per-segment cap.
		const wholeLineAllowed = allowRules.some((r) => {
			const m = /^(\w+)\((.*)\)$/.exec(r);
			return m !== null && m[1].toLowerCase() === verb.toLowerCase() && literalSubject(m[2]) === subj;
		});
		if (wholeLineAllowed) return "allow";
		const segmentAllowed = (segment: string): boolean =>
			allowRules.some((r) => {
				try {
					const parts = ruleParts(r);
					if (parts === undefined || parts.verb !== verb.toLowerCase()) return false;
					if (COMMAND_SUBSTITUTION.test(segment)) return allowsSubstitution(parts.subject, segment);
					return globToRegExp(parts.subject, false).test(segment);
				} catch {
					return false; // a broken allow rule is ignored, as in matches()
				}
			});
		return segments.every(segmentAllowed) ? "allow" : null;
	}
	for (const kind of ["deny", "ask", "allow"] as const) {
		if ((rules[kind] ?? []).some((r) => matches(r, kind === "deny", kind))) return kind;
	}
	return null;
}
