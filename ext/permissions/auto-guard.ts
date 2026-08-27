/**
 * Deterministic safety guardrail, shared by every permission mode that screens a call.
 *
 * `autoGuard()` screens ONE pending tool call and returns `"allow"` or `{ reason }`
 * (refuse). It is the deterministic analogue of Claude Code's auto-mode classifier:
 * allow most actions, refuse only unambiguously dangerous ones. Pure and
 * side-effect-free — safe to call inline in the hot `tool_call` path.
 *
 * Contrast with `isSafeCommand()` (safe-command.ts), which allows ONLY read-only
 * commands (too strict here). Here the default is ALLOW; we refuse a curated denylist modeled
 * on the categories Claude Code's classifier blocks by default. Command splitting
 * mirrors `isSafeCommand`: fail closed — ANY dangerous segment refuses.
 *
 * `reason` is a bare noun phrase ("recursive force delete (rm -rf)") and deliberately
 * carries no mode name or advice: `auto` turns a refusal into a block, the manual modes
 * turn the same refusal into a prompt, and a hook-allow into a two-option confirmation.
 * The caller that knows which of those it is owns the wording — see `evaluate.ts`.
 */

import { isAbsolute, relative, resolve } from "node:path";

/** A refusal carries a short bare reason; the caller frames it for the mode it is in. */
export type AutoVerdict = "allow" | { reason: string };

/**
 * Path segments never auto-written in auto mode: Claude Code's protected set,
 * plus bluclawd's own config dir and `.ssh`.
 *
 * Kept in step with isProtectedPath's list in rules.ts — the two gates screen
 * different things (auto-mode policy vs the protected-path prompt), but a
 * directory that can execute code should not be writable through either.
 */
const PROTECTED_SEGMENTS = [
	".git",
	".claude",
	".bluclawd",
	".ssh",
	".vscode",
	".idea",
	".husky",
	".cargo",
	".devcontainer",
	".yarn",
	".mvn",
];
/** Protected file basenames (shell/login init + repo/tooling config). */
const PROTECTED_FILES = [
	".bashrc",
	".bash_profile",
	".bash_login",
	".zshrc",
	".zprofile",
	".zshenv",
	".profile",
	".gitconfig",
	".npmrc",
];

/** Dangerous command patterns → block, each paired with a short human reason. */
const DANGEROUS: Array<[RegExp, string]> = [
	// Recursive / forced deletion. Long flags are separate patterns because
	// `-\w*` cannot cross the second dash of `--recursive`.
	[/\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b/i, "recursive force delete (rm -rf)"],
	[/\brm\s+-\w*r\w*\b/i, "recursive delete (rm -r)"],
	[/\brm\b[^\n]*--(recursive|force)\b/i, "recursive/forced delete (rm --recursive/--force)"],
	// Decode-then-execute hides the payload from every literal pattern here.
	[
		/\b(base64|xxd|openssl\s+enc)\b[^\n]*\|\s*(sudo\s+)?(bash|sh|zsh|python\d?|node|perl|ruby)\b/i,
		"decode piped to an interpreter",
	],
	[/\beval\b/i, "eval (executes constructed input)"],
	[/\brmdir\b/i, "directory delete (rmdir)"],
	[/\bfind\b[^\n]*\s-delete\b/i, "find -delete"],
	[/\bgit\s+clean\s+-\w*f/i, "git clean -f (deletes untracked files)"],
	[/\bshred\b/i, "shred (irreversible destruction)"],
	[/\bdd\b/i, "dd (raw disk write)"],
	// Circuit breakers.
	[/\brm\s+-\w+\s+(\/|~|\$HOME)(\s|\/|$)/i, "delete of filesystem root or home"],
	[/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb"],
	// Destructive git.
	[/\bgit\s+reset\s+--hard\b/i, "git reset --hard (discards changes)"],
	[/\bgit\s+checkout\s+--\s+\./i, "git checkout -- . (discards changes)"],
	[/\bgit\s+restore\s+\.(?:\s|$)/i, "git restore . (discards changes)"],
	[/\bgit\s+stash\s+(drop|clear)\b/i, "git stash drop/clear"],
	[/\bgit\s+push\b[^\n]*(--force(?:-with-lease)?|\s-f\b)/i, "git push --force"],
	// `git push origin +main:main` force-pushes via refspec, no --force needed.
	[/\bgit\s+push\b[^\n]*\s\+\S*:/i, "git push with a force refspec (+ref)"],
	[/\bgit\s+commit\b[^\n]*--amend\b/i, "git commit --amend (rewrites history)"],
	// Pipe-to-shell.
	[/\|\s*(sudo\s+)?(bash|sh|zsh)\b/i, "pipe-to-shell (remote code execution)"],
	// Privilege / permission escalation.
	[/\bsudo\b/i, "sudo (privilege escalation)"],
	[/\bsu\s+-/i, "su (privilege escalation)"],
	[/\bchmod\s+(-\w+\s+)*[0-7]*7[0-7]*\b/i, "chmod granting world access"],
	[/\bchmod\s+[^\n]*\ba?\+\w*w/i, "chmod a+w (world-writable)"],
	[/\bchmod\s+-\w*R/i, "chmod -R (recursive permission change)"],
	[/\bchown\b/i, "chown (ownership change)"],
	[/\bchgrp\b/i, "chgrp (group change)"],
	// Infra destroy.
	[/\b(terraform|pulumi|cdk|terragrunt)\s+destroy\b/i, "infrastructure destroy"],
	[/\bkubectl\s+delete\b/i, "kubectl delete"],
	[/\bhelm\s+uninstall\b/i, "helm uninstall"],
	// System control.
	[/\breboot\b/i, "reboot"],
	[/\bshutdown\b/i, "shutdown"],
	[/\bhalt\b/i, "halt"],
	[/\bsystemctl\s+(stop|disable)\b/i, "systemctl stop/disable"],
	[/\bservice\s+\S+\s+stop\b/i, "service stop"],
	[/\bmkfs\b/i, "mkfs (format filesystem)"],
	[/\bkill\s+-9\b/i, "kill -9"],
	[/\bpkill\b/i, "pkill"],
	[/\bkillall\b/i, "killall"],
];

/** A delete whose target is an unresolved shell variable — can't verify → block. */
const VAR_DELETE = /\brm\s+-\w+\s+["']?\$\{?\w+/i;

/**
 * Redirect target: `>`, `>>` or `>|` followed by a path (quoted or bare).
 *
 * Group 1 is the `&` of a descriptor dup (`2>&1`, `>&2`), which redirects to a
 * file descriptor and names no path at all. Group 2 is the path.
 */
const REDIRECT = /(?:^|[^>])>>?\|?\s*(&?)("[^"]+"|'[^']+'|[^\s;&|<>]*)/g;

function segments(command: string): string[] {
	return (
		command
			// `|` and `&` directly after `>` belong to the redirect — `>|` is the
			// clobber override and `>&` a descriptor dup. Splitting there tore the
			// operator in half: the `>|` target never reached the redirect scan, and
			// `2>&1` decayed into an empty target that read as an unparseable
			// redirect, which is why auto mode blocked `npm test 2>&1`.
			.split(/[;\n]+|(?<!>)[&|]+/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
	);
}

/**
 * Character devices a redirect may target despite living outside the working
 * directory. Discarding output is what build and test commands do, and
 * `2>/dev/null` was being blocked as a write escape.
 *
 * Deliberately these four, not `/dev` at large: `> /dev/sda` is a raw disk write.
 */
const WRITABLE_DEVICES = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"];

/** True if a write to `p` is protected (segment/basename) or resolves outside `cwd`. */
function pathUnsafe(rawPath: string, cwd: string): { unsafe: boolean; reason: string } {
	if (WRITABLE_DEVICES.includes(rawPath)) return { unsafe: false, reason: "" };
	// Expand ~ and $HOME/$PWD first: `> $HOME/.zshrc` otherwise resolves under
	// cwd and passes the containment check while the shell writes to the home dir.
	const home = process.env.HOME ?? "";
	const p = rawPath
		.replace(/^~(?=\/|$)/, home)
		.replace(/\$\{?HOME\}?/g, home)
		.replace(/\$\{?PWD\}?/g, cwd);
	const parts = p.split("/");
	const base = parts[parts.length - 1] ?? p;
	if (PROTECTED_FILES.some((f) => f.toLowerCase() === base.toLowerCase())) {
		return { unsafe: true, reason: `write to protected file ${base}` };
	}
	// Case-insensitive: macOS/Windows reach .git through .GIT.
	for (const seg of parts) {
		const lower = seg.toLowerCase();
		if (PROTECTED_SEGMENTS.some((protectedSeg) => protectedSeg.toLowerCase() === lower)) {
			return { unsafe: true, reason: `write inside protected path ${seg}` };
		}
	}
	const abs = isAbsolute(p) ? p : resolve(cwd, p);
	const rel = relative(cwd, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) return { unsafe: true, reason: "write outside the working directory" };
	return { unsafe: false, reason: "" };
}

/**
 * Every redirect target in a bash command, in source order, one entry per redirect.
 *
 * An entry is `""` when the redirect names no path: `2>&1` and `>&2` duplicate a
 * file descriptor. Callers decide what that means — a PATH screen must skip those
 * (there is nothing to resolve), while {@link autoGuard} treats an unresolvable
 * target as reason enough to block.
 *
 * Shared with the permission gate's protected-path check so both read the same
 * redirects; it is not a shell parser, and write primitives that take a path as an
 * argument (`tee`, `cp`, `sed -i`, an interpreter) are NOT covered.
 */
export function bashRedirectTargets(command: string): string[] {
	const targets: string[] = [];
	// Per segment so each `> path` is read independently, and every match within a
	// segment: `> ok.txt > ~/.zshrc` applies both, so screening one misses the other.
	for (const seg of segments(command)) {
		REDIRECT.lastIndex = 0;
		for (const m of seg.matchAll(REDIRECT)) {
			// `&` only means "no path" when what follows is a descriptor (`2>&1`,
			// `>&2`) or a close (`>&-`). `>&FILE` is redirect-BOTH-streams-to-a-file
			// and writes it — verified in bash, zsh and sh — so it must be screened.
			if (m[1] === "&" && /^\d+$|^-$/.test(m[2])) continue;
			targets.push(m[2].replace(/^["']|["']$/g, ""));
		}
	}
	return targets;
}

/** `tee [-flags] FILE...` — the write primitive that reads like a pipe, not a redirect. */
const TEE = /\btee\b((?:\s+-\w+)*)((?:\s+(?:"[^"]+"|'[^']+'|[^\s;&|<>]+))+)/g;

/**
 * Paths a bash command writes, as far as a command string can be read: redirect
 * targets plus `tee` arguments.
 *
 * NOT a completeness claim, and callers must not treat it as one. `cp`, `mv`,
 * `sed -i`, `dd`, an editor, or any interpreter given a script all write paths
 * this never sees. It raises the cost of the vectors a model reaches for first;
 * the OS sandbox is the boundary that actually holds.
 */
export function bashWriteTargets(command: string): string[] {
	const targets = bashRedirectTargets(command);
	TEE.lastIndex = 0;
	for (const m of command.matchAll(TEE)) {
		for (const arg of m[2].trim().split(/\s+/)) {
			targets.push(arg.replace(/^["']|["']$/g, ""));
		}
	}
	return targets;
}

/**
 * The command denylist alone — patterns dangerous in themselves, wherever they run.
 *
 * Split out from {@link autoGuard} because the two screens answer different questions.
 * This one asks "is this command destructive?"; the rest of `autoGuard` adds CONTAINMENT
 * (writes and redirects must stay inside the working directory), which is part of auto
 * mode's specific bargain: it never prompts, so it screens hard. The manual modes do
 * prompt, and asking before every `> /tmp/log.txt` or write to an absolute path would be
 * friction without a matching danger — and "Always allow" persists the literal path, so
 * each new temp file would ask again.
 */
export function dangerousCommand(command: string): AutoVerdict {
	if (!command) return "allow";
	if (VAR_DELETE.test(command)) {
		return {
			reason: "delete whose target is an unresolved shell variable (cannot verify) — name the exact path",
		};
	}
	// Runs against the WHOLE command: splitting on `|` would destroy the pipe-to-shell
	// signal (e.g. `curl … | bash`). Any dangerous pattern anywhere refuses.
	for (const [pat, reason] of DANGEROUS) {
		if (pat.test(command)) return { reason };
	}
	return "allow";
}

export function autoGuard(tool: string, input: Record<string, unknown>, cwd: string): AutoVerdict {
	if (tool === "edit" || tool === "write") {
		const p = String(input.path ?? "");
		if (!p) return "allow";
		const { unsafe, reason } = pathUnsafe(p, cwd);
		return unsafe ? { reason } : "allow";
	}
	if (tool !== "bash") return "allow";

	const command = String(input.command ?? "");
	if (!command) return "allow";

	const dangerous = dangerousCommand(command);
	if (dangerous !== "allow") return dangerous;

	for (const target of bashRedirectTargets(command)) {
		if (!target) return { reason: "redirect with an unparseable target" };
		const { unsafe, reason } = pathUnsafe(target, cwd);
		if (unsafe) return { reason: `redirect ${reason}` };
	}
	return "allow";
}
