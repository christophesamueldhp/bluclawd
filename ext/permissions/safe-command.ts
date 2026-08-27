/**
 * Read-only bash allowlist, used by `evaluate.ts` to auto-approve safe commands
 * across every permission mode (not just as a gate, but as the standing grant
 * that clears an `ask` and the fallback at "no matching rule").
 *
 * Originally ported verbatim from a donor plan-mode extension's utils.ts (PLAN.md F1.5),
 * then relocated here when plan mode was removed — this predicate outlived that feature.
 */

// Destructive commands blocked from auto-approval.
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	// Pipe-to-shell is remote code execution (e.g. `curl url | bash`) and is never
	// read-only — catch `| bash`/`| sh`/`| zsh`, with or without a leading space.
	/\|\s*(bash|sh|zsh)\b/i,
	// `find` that deletes or runs commands: `-delete`, `-exec`, `-execdir`.
	/\bfind\b.*\s-(delete|execdir|exec)\b/i,
	// NOTE (F1.5): this allow/deny regex is a coarse first line only. It still lets
	// subtler read-only violations through (e.g. `curl -o file` writing to disk,
	// arbitrary tool flags). Full command-safety analysis + sandboxing is deferred
	// to F2.1 (permissions); do not grow this into a parser here — add only
	// unambiguous categories.
];

// Safe read-only commands allowed to auto-approve.
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	// curl WITHOUT file-writing or upload flags — see UNSAFE_ARGS below.
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	// `awk` (arbitrary code via system()) and `env` (launcher for any binary,
	// e.g. `env python -c …`) were removed from this list — review I7. Use
	// `printenv` to read the environment.
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/**
 * Argument shapes that make an otherwise read-only command write to disk or
 * upload data. These are checked across the WHOLE command because they appear
 * as arguments, not as the leading binary.
 */
const UNSAFE_ARGS: RegExp[] = [
	// curl/wget writing a file, or uploading one.
	/\bcurl\b[^\n]*\s(-o|-O|--output|--output-dir|--remote-name|--upload-file|-T)\b/i,
	// `@file` or `name=@file` reads a local file into the request body. A bare
	// `-d user@example.com` is just data, so the `@` must start the value.
	/\bcurl\b[^\n]*\s(--data-binary|--data-raw|--data|--form|-d|-F)\s+["']?(@|[^"'\s=]+=@)/i,
	/\bwget\b[^\n]*\s(-O|--output-document)\s*(?!-)/i,
	// find writing through its own primaries (not covered by -exec/-delete).
	/\bfind\b[^\n]*\s-(fprintf|fls|fprint|fprint0)\b/i,
	// sed's `w`/`W` commands write files even under -n.
	/\bsed\b[^\n]*\s(-e\s*)?['"][^'"]*\bw\s+\S/i,
	/\bsed\b[^\n]*\s(-i|--in-place)\b/i,
	// grep -f/--file reads a pattern file, but --include with -r into a writer
	// is not the risk; tee is.
	/\btee\b/i,
];

/** `$(...)` / backticks / `<(...)` run arbitrary code before the outer command. */
const COMMAND_SUBSTITUTION = /\$\(|`|<\(/;

export function isSafeCommand(command: string): boolean {
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
	// Command substitution executes BEFORE the allowlisted binary sees its
	// arguments, so `echo $(node -e "…")` is arbitrary execution wearing an
	// `echo` prefix. The allowlist cannot reason about it — refuse instead.
	if (COMMAND_SUBSTITUTION.test(command)) return false;
	if (UNSAFE_ARGS.some((p) => p.test(command))) return false;
	// Review I7: the safe-list is anchored (`^…`), so checking only the whole
	// string let a safe prefix smuggle arbitrary follow-on commands past the gate
	// (`ls && python -c "…rmtree…"`). Split on chain/pipe separators and require
	// EVERY segment to independently match the safe list. The split is naive about
	// quoting (`echo "a|b"` splits too) — that only fails closed, which is the
	// right trade-off for this coarse first-line gate.
	const segments = command
		.split(/[;&|\n]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return segments.length > 0 && segments.every((seg) => SAFE_PATTERNS.some((p) => p.test(seg)));
}
