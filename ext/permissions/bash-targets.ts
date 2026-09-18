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

/** `cp`, `mv`, `ln` or `install` at the start of a segment, called by any path. */
const COPY_LIKE = /^\\?(?:\S*\/)?(cp|mv|ln|install)\s+([\s\S]*)$/;

/**
 * What `cp`, `ln` and `install` write — their last path, or the `-t` directory — and
 * what `mv` touches: its destination and every source, which it removes.
 */
function copyTargets(command: string): string[] {
	const targets: string[] = [];
	for (const seg of segments(command)) {
		const m = COPY_LIKE.exec(seg);
		if (!m) continue;
		const words = m[2].split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
		const paths: string[] = [];
		let directory: string | undefined;
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (word === "-t" || word === "--target-directory") directory = words[++i];
			else if (word.startsWith("--target-directory=")) directory = word.slice("--target-directory=".length);
			else if (word && !word.startsWith("-")) paths.push(word);
		}
		if (m[1] === "mv") targets.push(...paths);
		const destination = directory ?? paths.at(-1);
		if (destination) targets.push(destination);
	}
	return targets;
}

/**
 * Paths a bash command writes, as far as a command string can be read: redirect
 * targets, `tee` arguments, and the paths `cp`, `mv`, `ln` and `install` write.
 *
 * NOT a completeness claim, and callers must not treat it as one. `sed -i`, `dd`,
 * `rsync`, an editor, or any interpreter given a script all write paths this never
 * sees. It raises the cost of the vectors a model reaches for first;
 * the OS sandbox is the boundary that actually holds.
 */
export function bashWriteTargets(command: string): string[] {
	const targets = [...bashRedirectTargets(command), ...copyTargets(command)];
	TEE.lastIndex = 0;
	for (const m of command.matchAll(TEE)) {
		for (const arg of m[2].trim().split(/\s+/)) {
			targets.push(arg.replace(/^["']|["']$/g, ""));
		}
	}
	return targets;
}

/**
 * Every word of a bash command that could name a file it reads: arguments, `< file`
 * inputs, and the value of a `--flag=path` or `VAR=path`. Flags without a value are
 * dropped. Feeds the protected-READ screen, so an extra word only prompts more.
 *
 * Same caveat as {@link bashWriteTargets}: a path built at runtime (`cat $F`,
 * `cat ~/.pi/agent/a*h.json` in a subshell, an interpreter opening it) is not seen.
 */
export function bashPathArgs(command: string): string[] {
	const words: string[] = [];
	for (const raw of command.split(/[\s;&|<>()]+/)) {
		let word = raw.replace(/^["']+|["']+$/g, "");
		if (word.startsWith("-") || /^[A-Za-z_]\w*=/.test(word)) {
			const eq = word.indexOf("=");
			if (eq === -1) continue;
			word = word.slice(eq + 1).replace(/^["']+|["']+$/g, "");
		}
		if (word) words.push(word);
	}
	return words;
}
