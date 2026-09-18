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
	// `find` that deletes or runs commands: `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`.
	/\bfind\b.*\s-(delete|execdir|exec|okdir|ok)\b/i,
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
	/^\s*git\s+(status|log|diff|show|config\s+--get)/i,
	// Listing forms only: any other word creates, renames or rewires.
	/^\s*git\s+remote(\s+(-v|--verbose))*\s*$/i,
	/^\s*git\s+remote\s+(-v\s+|--verbose\s+)?(show|get-url)\b/i,
	/^\s*git\s+branch(\s+-(?![mMcCfu]\b|-(move|copy|force|set-upstream-to|unset-upstream|edit-description)\b)\S+)*\s*$/i,
	// A filter flag puts git branch in list mode, where git refuses every other mode
	// (create, move, copy, delete, upstream) with a usage error, so any word may follow.
	/^\s*git\s+branch\b(?=[^\n]*\s(--list|--(no-)?contains|--(no-)?merged|--points-at)(\s|=|$))/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	// curl reading only: no request body, method, upload or file output — see UNSAFE_ARGS below.
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
	// curl sending data acts on the server, and `@file` uploads a local file: a body
	// (`-d`, also clustered as `-sSd`), a form, JSON, or any method but a read.
	/\bcurl\b[^\n]*\s(--data(-[a-z]+)?|--form(-string)?|--json|-[a-zA-Z]*[dF])/,
	/\bcurl\b[^\n]*\s(-[a-zA-Z]*X|--request)[\s=]*["']?(?!(GET|HEAD|OPTIONS)\b)\S/,
	// curl options that write a file other than stdout (`-D -` prints the headers).
	/\bcurl\b[^\n]*\s(-D|--dump-header|-c|--cookie-jar|--trace(-ascii)?|--libcurl|--etag-save|--stderr)[\s=]+(?!-(\s|$))/,
	/\bwget\b[^\n]*\s(-O|--output-document)\s*(?!-)/i,
	// find writing through its own primaries (not covered by -exec/-delete).
	/\bfind\b[^\n]*\s-(fprintf|fls|fprint|fprint0)\b/i,
	// sed's `w`/`W` commands write files even under -n.
	/\bsed\b[^\n]*\s(-e\s*)?['"][^'"]*\bw\s+\S/i,
	/\bsed\b[^\n]*\s(-i|--in-place)\b/i,
	// GNU sed runs a shell command with `e` (a command of its own, or an `s///e` flag).
	/\bsed\b[^\n]*(?:['";{}$/\d]|\s-e\s+)\s*e(?:[\s;}'"]|$)/,
	/\bsed\b[^\n]*\bs([^\w\s\\])(?:\\.|(?!\1)[^\\\n])*\1(?:\\.|(?!\1)[^\\\n])*\1[gpiImM\d]*e/,
	// fd and rg run a program per match / per file.
	/\bfd\b[^\n]*\s(-[a-zA-Z]*[xX]|--exec(-batch)?)\b/,
	/\brg\b[^\n]*\s--pre(=|\s)/,
	// sort writes with -o (also clustered, `-uo`) and runs --compress-program.
	/\bsort\b[^\n]*\s(-[a-zA-Z]*o|--output|--compress-program)/,
	/\btree\b[^\n]*\s-o\b/,
	// git's diff options write the patch to a file.
	/\bgit\b[^\n]*\s--output(=|\s)/,
	// grep -f/--file reads a pattern file, but --include with -r into a writer
	// is not the risk; tee is.
	/\btee\b/i,
];

/** `$(...)` / backticks / `<(...)` run arbitrary code before the outer command. */
export const COMMAND_SUBSTITUTION = /\$\(|`|<\(/;

/**
 * Redirects that write nothing: a descriptor dup or close (`2>&1`, `>&2`, `>&-`) and
 * output thrown into /dev/null. `>&word` is NOT one of them: it writes the file `word`.
 */
const HARMLESS_REDIRECTS = /\d*>&(\d+|-)(?=[\s;&|)]|$)|(\d*|&)>>?\s*\/dev\/null(?=[\s;&|)]|$)/g;

/**
 * Split a command on `;`, `&`, `|` and newlines that sit outside quotes, as the shell
 * does, so `grep -E 'a|b'` stays one command. `undefined` when the quoting does not
 * balance: the caller then falls back to splitting on every separator.
 */
function shellSegments(command: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | "$'" | undefined;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = undefined;
			current += c;
		} else if (quote) {
			// `$'…'` and `"…"` both honour a backslash escape.
			if (c === "\\") {
				current += c + (command[++i] ?? "");
			} else {
				if (c === (quote === '"' ? '"' : "'")) quote = undefined;
				current += c;
			}
		} else if (c === "\\") {
			current += c + (command[++i] ?? "");
		} else if (c === "'" || c === '"') {
			// `$'` opens an ANSI-C string only when that `$` is not itself escaped.
			quote = c === "'" && /(?:^|[^\\])(?:\\\\)*\$$/.test(current) ? "$'" : c;
			current += c;
		} else if (/[;&|\n]/.test(c)) {
			segments.push(current);
			current = "";
		} else {
			current += c;
		}
	}
	if (quote) return undefined;
	segments.push(current);
	return segments;
}

export function isSafeCommand(rawCommand: string): boolean {
	const command = rawCommand.replace(HARMLESS_REDIRECTS, " ");
	if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return false;
	// Command substitution executes BEFORE the allowlisted binary sees its
	// arguments, so `echo $(node -e "…")` is arbitrary execution wearing an
	// `echo` prefix. The allowlist cannot reason about it — refuse instead.
	if (COMMAND_SUBSTITUTION.test(command)) return false;
	if (UNSAFE_ARGS.some((p) => p.test(command))) return false;
	// Review I7: the safe-list is anchored (`^…`), so checking only the whole
	// string let a safe prefix smuggle arbitrary follow-on commands past the gate
	// (`ls && python -c "…rmtree…"`). Split on chain/pipe separators and require
	// EVERY segment to independently match the safe list.
	const segments = (shellSegments(command) ?? command.split(/[;&|\n]+/))
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return segments.length > 0 && segments.every((seg) => SAFE_PATTERNS.some((p) => p.test(seg)));
}
