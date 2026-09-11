/**
 * The paths a bash command writes, as far as a command string can be read.
 *
 * Feeds the protected-path gate in evaluate.ts: `echo {} > .bluclawd/mcp.json`
 * installs a shell-executing config file exactly as `write` does, so its redirect
 * and `tee` targets are screened with the same predicate `write` is.
 */

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
			// redirect.
			.split(/[;\n]+|(?<!>)[&|]+/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
	);
}

/**
 * Every redirect target in a bash command, in source order, one entry per redirect.
 *
 * An entry is `""` when the redirect names no path: `2>&1` and `>&2` duplicate a
 * file descriptor. A PATH screen must skip those (there is nothing to resolve).
 *
 * Not a shell parser: write primitives that take a path as an argument (`cp`,
 * `sed -i`, an interpreter) are NOT covered.
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
