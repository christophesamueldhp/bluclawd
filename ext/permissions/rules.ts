/**
 * Pure permission-rule engine (PLAN.md F2.1).
 *
 * Rules use a `Verb(glob)` syntax, e.g. `Bash(npm *)`, `Read(~/.ssh/**)`.
 * `decide()` resolves a tool call against a rule set with fixed
 * deny > ask > allow precedence and returns the winning kind, or `null` when
 * no rule governs the call. This module is fully unit-tested and safe to call
 * inline in the hot `tool_call` path. One deliberate, narrow exception to
 * "no I/O": a deny/ask path rule also widens to the subject's realpath (a
 * symlink resolved), so a rule can catch what it points at, not just its
 * literal spelling — see `getRealpathSubject` in `decide()`, and
 * `evaluate.ts`'s purity note for why this is scoped to deny/ask only.
 *
 * Glob semantics (see the tests for the exact assertions):
 * - `*`  matches any run of characters EXCEPT `/`  → `[^/]*`
 * - `**` matches any characters INCLUDING `/` and newlines → `[\s\S]*`
 * - every other character — including literal spaces — is matched literally.
 *
 * NB (Trap 1): the plan's reference impl converted every literal space to `.*`
 * via a space sentinel, which made `Bash(npm *)` match `npmx`. This char-by-char
 * scan has no sentinel, so spaces stay literal.
 */

export type Decision = "allow" | "ask" | "deny";
export type Rules = { allow?: string[]; ask?: string[]; deny?: string[] };

/**
 * Lowercase tool name → capitalized rule verb. Since audit B.5, MCP tools and
 * `task` are ALSO governed via the dynamic `verbFor()` mapping below:
 * `mcp__server__tool` → `Mcp(server:tool)` and `task` → `Task(agentname)`.
 * Subagent children additionally run a deny-only gate (subagent-gate.ts), so a
 * `deny: Bash(**)` is no longer circumventable by delegating to an agent def
 * that grants bash.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { resolveToCwd } from "../../../packages/coding-agent/src/core/tools/path-utils.ts";

const VERB: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Find",
	ls: "Ls",
	webfetch: "WebFetch", // Tier 4 tools opt in here
	websearch: "WebSearch",
};

/** True for namespaced MCP tool names of the form `mcp__server__tool`. */
export function isMcpToolName(tool: string): boolean {
	return /^mcp__.+__.+$/.test(tool);
}

/**
 * The governed rule verb for a tool name, or undefined when ungoverned.
 * MCP tools (audit B.5) map to `Mcp`, the task tool to `Task`.
 */
function verbFor(tool: string): string | undefined {
	if (tool === "task") return "Task";
	if (isMcpToolName(tool)) return "Mcp";
	return VERB[tool];
}

/** The rule verbs this engine actually governs. `decide()` returns null for anything outside this
 *  set, so callers that want to gate "every governable tool" (e.g. the FleetView ask-all posture)
 *  should build their rules from THIS list rather than a hand-kept copy that can drift out of sync. */
export function governedVerbs(): string[] {
	return [...Object.values(VERB), "Mcp", "Task"];
}

/**
 * Every agent name a `task` call targets, across all three invocation modes
 * (single `agent`, parallel `tasks[].agent`, chain `chain[].agent`). Used by
 * the permission gate to decide a task call PER TARGET AGENT: `Task(agent)`
 * rules would otherwise be bypassable by wrapping the agent in parallel/chain
 * mode. Unknown shapes yield [] (the call stays decidable as "no rule").
 */
export function taskAgents(input: Record<string, unknown>): string[] {
	const names: string[] = [];
	if (typeof input.agent === "string" && input.agent) names.push(input.agent);
	for (const key of ["tasks", "chain"] as const) {
		const list = input[key];
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			const agent = (entry as Record<string, unknown> | null)?.agent;
			if (typeof agent === "string" && agent) names.push(agent);
		}
	}
	return [...new Set(names)];
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
 * so a rule spec can be run through the very same engine that governs live calls.
 *
 * Derived from the VERB table above rather than a hand-kept second mapping — a third
 * spelling of "which field is this verb's subject" is exactly how these drift.
 * Returns undefined for a malformed spec or an ungoverned verb.
 */
export function parseRuleSpec(spec: string): { tool: string; input: Record<string, unknown> } | undefined {
	const m = /^(\w+)\((.*)\)$/.exec(stripWrappingQuotes(spec));
	if (!m) return undefined;
	const verb = m[1].toLowerCase();
	const subj = m[2];

	if (verb === "task") return { tool: "task", input: { agent: subj } };
	if (verb === "mcp") {
		const [server, ...rest] = subj.split(":");
		if (!server || rest.length === 0) return undefined;
		return { tool: `mcp__${server}__${rest.join(":")}`, input: {} };
	}
	const tool = Object.keys(VERB).find((t) => VERB[t].toLowerCase() === verb);
	if (!tool) return undefined;
	if (tool === "bash") return { tool, input: { command: subj } };
	if (tool === "webfetch") return { tool, input: { url: subj } };
	if (tool === "websearch") return { tool, input: { query: subj } };
	return { tool, input: { path: subj } };
}

/** Characters that are regex metacharacters and must be escaped to match literally. */
const REGEX_META = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\", "?"]);

/**
 * The governed subject for a tool call: the command for bash, otherwise the
 * path/url/query. `query` is read so `websearch {query}` calls are governable by
 * `WebSearch(<query>)` rules; existing tools have no `query` field, so this is
 * backward-compatible.
 *
 * For grep/find/ls the `path` field is OPTIONAL and the tool falls back to the
 * working directory. This function still returns "" for those, because it has no
 * cwd; `decide()` substitutes the cwd instead (see CWD_DEFAULTING_VERBS) so that
 * omitting the argument no longer escapes a path rule.
 */
export function subject(tool: string, input: Record<string, unknown>): string {
	if (tool === "task") {
		// Single-mode target; multi-agent calls are decided per agent via
		// taskAgents() in the gate — this covers the common single case.
		return String(input.agent ?? "");
	}
	if (isMcpToolName(tool)) {
		const m = /^mcp__(.+?)__(.+)$/.exec(tool);
		return m ? `${m[1]}:${m[2]}` : "";
	}
	return tool === "bash" ? String(input.command ?? "") : String(input.path ?? input.url ?? input.query ?? "");
}

/**
 * Build the exact-match allow rule string for a tool call subject, e.g.
 * `Bash(npm install)`. Returns null for ungoverned tools. Used by "Always allow".
 */
export function exactRule(tool: string, subj: string): string | null {
	const verb = verbFor(tool);
	return verb ? `${verb}(${subj})` : null;
}

/**
 * Is `rawPath` inside territory that configures the agent itself? Claude Code
 * parity ("protected paths"): such paths are never auto-approved. Covers any
 * `.git` or `<configDirName>` (e.g. `.bluclawd`) path segment, plus the whole
 * global agent dir (settings.json, hooks.json, mcp.json, keybindings.json, …).
 * Pure — agentDir/configDirName are injected; path resolution mirrors the edit
 * and write tools (resolveToCwd handles ~ and absolute paths identically).
 */
/**
 * Directory names that configure the agent, the repo, or the toolchain — Claude
 * Code's protected set, adopted wholesale.
 *
 * Every entry can lead to code execution: husky hooks run on commit, VS Code
 * tasks and devcontainer lifecycle commands run shell, `.cargo/config.toml` can
 * name a custom linker or runner, `.config/git/config` can repoint
 * `core.hooksPath`, and `.yarn/releases` holds the yarn binary itself.
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
 * directory) — same fallback `isProtectedPath` above uses. Returns `undefined` when even
 * the parent can't be resolved.
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
				// `.claude/worktrees` holds working copies, not configuration — Claude
				// Code carves it out, and gating it would prompt on ordinary edits.
				// The carve-out applies ONLY to the `.claude` segment: a worktree still
				// contains a real `.git` and a real project config dir, and this
				// project's own EnterWorktree puts whole sessions under that path, so
				// exempting the entire predicate disarmed protection for the session.
				if (eq(segment, ".claude")) return !eq(segments[i + 1] ?? "", "worktrees");
				if (PROTECTED_SEGMENTS.some((protectedSeg) => eq(segment, protectedSeg))) return true;
				// `.config/git` is the only two-segment entry in the set.
				return eq(segment, ".config") && eq(segments[i + 1] ?? "", "git");
			})
		) {
			return true;
		}
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
 * Agent files whose CONTENTS are secrets or grant execution: server credentials
 * in mcp.json, provider tokens in auth.json, the apiKeyEnv indirection in
 * settings.json, shell commands in hooks.json.
 *
 * isProtectedPath governs writes to the whole agent-config tree. Reads need a
 * far narrower rule: gating every read under `.git` or `.bluclawd` would prompt
 * for HEAD, refs, and installed package sources, none of which hold secrets, and
 * a gate that fires constantly trains people to approve without reading it.
 */
const READ_PROTECTED_FILES = ["auth.json", "mcp.json", "settings.json", "hooks.json", "trust.json"];

/** Is reading `rawPath` a read of agent credentials or executable config? */
export function isReadProtectedPath(rawPath: string, cwd: string, agentDir: string, configDirName: string): boolean {
	const abs = resolveToCwd(rawPath, cwd);
	const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
	const eq = (a: string, b: string): boolean => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
	// Match the filename the same way the filesystem does. On darwin/win32 `Auth.json`
	// opens auth.json, so a case-sensitive compare here read credentials unprompted
	// while the directory comparisons below were already case-insensitive.
	if (!READ_PROTECTED_FILES.some((name) => eq(name, basename(abs)))) return false;
	const parent = dirname(abs);
	const agentAbs = resolveToCwd(agentDir, cwd);
	return eq(parent, agentAbs) || eq(basename(parent), configDirName);
}

/** Rule verbs whose subject is a filesystem path (so it can also be resolved). */
const PATH_VERBS = new Set(["Read", "Write", "Edit", "Grep", "Find", "Ls"]);

/**
 * Verbs whose tool takes an OPTIONAL path and falls back to the working
 * directory (grep.ts:178, ls.ts:124 both resolve `path || "."`).
 *
 * Their subject came out empty when the argument was omitted, and no glob
 * matches an empty string — so `deny: Grep(**​/secrets/**)` was defeated by
 * leaving the path off and letting the tool default to cwd. read/write/edit are
 * NOT here: their path is required, so an empty subject is a malformed call and
 * substituting cwd would invent a target the call never named.
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
	const expanded = homeExpand(pat);
	let body = "";
	for (let i = 0; i < expanded.length; i++) {
		const c = expanded[i];
		if (c === "*") {
			if (expanded[i + 1] === "*") {
				// ** crosses / AND newlines: `.` never matches \n (no dotAll), so `.*`
				// let any multiline command escape `**` deny rules (2026-07-10 review I1).
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
	return new RegExp(`^${body}$`);
}

/**
 * Resolve a tool call against the rule set. Returns the winning decision kind, or
 * null when no rule matches (or the tool is ungoverned). Precedence: deny > ask > allow.
 */
/** Leading `VAR=value` assignments: `RM=1 rm x`. */
const ENV_ASSIGNMENTS = /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
/** An `env` wrapper with its own flags/assignments: `env -i FOO=bar rm x`. */
const ENV_WRAPPER = /^env\s+(?:-\S+\s+|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/;
/** A shell asked to run an inline command: `sh -c '…'`, `/bin/bash -lc "…"`. */
const SHELL_INLINE = /^(?:\S*\/)?(?:ba|z|k|da|a)?sh\s+(?:-\S+\s+)*-\S*c\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;
/**
 * Exec wrappers that take a full command as trailing arguments: `watch rm -rf x`,
 * `nohup rm -rf x`, `echo x | xargs rm -rf`. Claude Code documents these as "always
 * prompt, can't be auto-approved by a prefix rule" on the allow side; bluclawd's gap
 * is symmetric on the deny side — `deny: Bash(rm *)` must see through them too.
 * Same conservative single-token-flag peel as ENV_WRAPPER above: a flag whose value
 * is a separate token (`watch -n 5 …`) is not fully stripped, which leaves noise in
 * the candidate rather than mis-identifying the wrapped command — the tradeoff
 * already accepted there.
 */
const EXEC_WRAPPER = /^(?:watch|setsid|ionice|nohup|xargs)\s+(?:-\S+\s+)*/;
/** `flock` additionally takes a lockfile/fd positional (and optional `-c`) before the
 *  command it wraps: `flock file.lock rm -rf x`, `flock file.lock -c "rm -rf x"`. `-w`
 *  (wait timeout) and `-E` (exit code) are common enough two-token flags to special-case —
 *  without it, the lockfile positional this peel exists to skip past is misidentified as
 *  the flag's value instead. */
const FLOCK_WRAPPER = /^flock\s+(?:-[wE]\s+\S+\s+|-\S+\s+)*\S+\s+(?:-c\s+)?/;

/**
 * Every spelling of a bash command a deny rule should be tested against.
 *
 * `deny: Bash(rm *)` used to match the raw command string and nothing else, so
 * a leading space, an `env` prefix, `\rm`, `/bin/rm`, `sh -c '…'`, or anything
 * after `&&`/`;`/`|` walked straight past it. Each segment is therefore also
 * offered in normalized form, with the original spelling always kept so a rule
 * naming a full path still matches.
 *
 * Splitting is naive about quotes, which over-splits `echo "a; rm b"` into a
 * candidate that a deny rule may match. That direction is deliberate: for deny
 * and ask, an extra candidate can only ever block or prompt more.
 */
export function bashSegments(command: string): string[] {
	return command
		.split(/[;\n]+|(?<!>)[&|]+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

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

export function decide(rules: Rules, tool: string, input: Record<string, unknown>, cwd?: string): Decision | null {
	const verb = verbFor(tool);
	if (!verb) return null; // unknown/extension tools: not governed
	const rawSubject = subject(tool, input);
	const subj = homeExpand(rawSubject === "" && cwd && CWD_DEFAULTING_VERBS.has(verb) ? cwd : rawSubject);
	// A rule that fails to compile/test must never crash the awaited tool_call gate.
	// Fail closed: a broken `deny` counts as a match (block); a broken `allow`/`ask` is
	// ignored, so a malformed permissive rule can't silently grant access. (Currently
	// unreachable — REGEX_META is exhaustive — but cheap insurance for future glob syntax.)
	// Respellings of a bash command (see bashRuleSubjects). Computed once, and only
	// for the rule kinds that may safely widen — see `expand` below.
	const isBash = verb === "Bash";
	const bashSubjects = isBash ? bashRuleSubjects(subj) : undefined;
	const segments = isBash ? bashSegments(subj) : undefined;
	// Path subjects arrive as the tool was called — `.env`, `./x`, `../../y` — so a
	// rule written against a resolved shape (`**/.env`, an absolute prefix) missed
	// them. Offer the resolved path as an extra candidate, alongside the original
	// so rules written against the literal spelling keep matching.
	const resolvedSubject = cwd && PATH_VERBS.has(verb) && subj ? homeExpand(resolveToCwd(subj, cwd)) : undefined;
	// A rule the user wrote against `deny: Read(/home/me/secrets/**)` should also catch a
	// repo-local symlink pointing there (`./s -> /home/me/secrets`) — isProtectedPath already
	// resolves symlinks for its own hardcoded set; user-written rules did not. This is real
	// filesystem I/O, unlike `resolvedSubject` above, so it stays lazy (computed only if a
	// deny/ask rule actually needs it, never for allow — same asymmetry as bashSubjects and
	// resolvedSubject) and memoized (computed at most once per `decide()` call).
	let realpathSubjectComputed = false;
	let realpathSubject: string | undefined;
	const getRealpathSubject = (): string | undefined => {
		if (!realpathSubjectComputed) {
			realpathSubjectComputed = true;
			realpathSubject = cwd && PATH_VERBS.has(verb) && subj ? realpathIfSymlink(resolveToCwd(subj, cwd)) : undefined;
		}
		return realpathSubject;
	};
	const matches = (r: string, failClosed: boolean, kind: Decision): boolean => {
		try {
			const m = /^(\w+)\((.*)\)$/.exec(r);
			// Verb comparison is case-insensitive: `/permissions add` accepts any
			// casing (RULE_SHAPE is [A-Za-z]+), so `bash(**)` would otherwise be
			// stored, listed, and silently never enforced.
			if (m === null || m[1].toLowerCase() !== verb.toLowerCase()) return false;
			// Bash subjects are command strings, not paths.
			const pattern = globToRegExp(m[2], !isBash);
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
	// A compound bash command's segments may each be covered by a DIFFERENT allow rule
	// (IMPROVEMENT-PLAN.md §2.4: "Always allow" on `git status && npm test` persists one
	// rule per segment, CC-style). No single rule needs to span the whole line — every
	// segment just needs SOME allow rule to cover it. Deny/ask are unaffected: a single
	// rule already covers those (with the widening `matches()` already does), and "any one
	// dangerous segment blocks/prompts" is the correct, unchanged behavior for both.
	if (isBash && segments && segments.length > 1) {
		for (const kind of ["deny", "ask"] as const) {
			if ((rules[kind] ?? []).some((r) => matches(r, kind === "deny", kind))) return kind;
		}
		const allowRules = rules.allow ?? [];
		const segmentAllowed = (segment: string): boolean =>
			allowRules.some((r) => {
				try {
					const m = /^(\w+)\((.*)\)$/.exec(r);
					if (m === null || m[1].toLowerCase() !== verb.toLowerCase()) return false;
					return globToRegExp(m[2], false).test(segment);
				} catch {
					return false; // a broken allow rule is ignored, same fail-open-for-allow as matches()
				}
			});
		return segments.every(segmentAllowed) ? "allow" : null;
	}
	for (const kind of ["deny", "ask", "allow"] as const) {
		if ((rules[kind] ?? []).some((r) => matches(r, kind === "deny", kind))) return kind;
	}
	return null;
}
