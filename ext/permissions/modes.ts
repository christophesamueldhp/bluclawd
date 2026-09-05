/**
 * Permission mode store (PLAN.md F2.1).
 *
 * Holds the session-scoped permission mode, and enforces the one rule project
 * trust imposes on it (see {@link createModeStore}).
 *
 * ── Vocabulary ────────────────────────────────────────────────────────────────
 * The names are pi's, not Claude Code's. pi has no permission modes of its own,
 * but it does have a vocabulary for the same question — "may this go ahead?" —
 * in `defaultProjectTrust`: `ask` / `always` / `never`. Three of the five modes
 * are exactly that question applied to tool calls instead of project resources,
 * so they take those names; `edits` and `auto` name the scope they narrow to.
 *
 * The Claude Code names this layer shipped with (`default`, `acceptEdits`,
 * `bypass`, `dontAsk`) are still accepted everywhere a mode can be named — see
 * {@link parseMode} — so a stored `permissions.defaultMode`, a script passing
 * `--permission-mode acceptEdits`, or muscle memory at the `/mode` prompt all
 * keep working.
 */

export type PermissionMode = "ask" | "edits" | "auto" | "always" | "never";

/**
 * Every valid mode name — the vocabulary accepted by `--permission-mode`,
 * `permissions.defaultMode` and `/mode <name>`.
 *
 * Deliberately WIDER than MODE_CYCLE: `always` and `never` are nameable but not
 * reachable by keyboard. Do not collapse the two back into one list — that is what put
 * bypass four Shift+Tab presses from `default`.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "edits", "auto", "always", "never"];

/**
 * Cycle order for Alt+M and a bare `/mode`, in increasing autonomy.
 *
 * The two non-interactive modes are deliberately NOT here (Claude Code parity — its
 * own remote-session allowlist is likewise `acceptEdits|plan|default|auto`, excluding
 * exactly these two). `always` disables every guard; `never` silently converts every
 * would-be prompt into a refusal, so landing on it by accident looks like the agent
 * breaking rather than a mode change. Both must be named: `/mode <name>`,
 * `--permission-mode <name>`, `--dangerously-skip-permissions` (always), or
 * `permissions.defaultMode`. Cycling FROM either still works: they are not in the
 * list, so `indexOf` returns -1 and the cycle resumes at `ask`.
 */
export const MODE_CYCLE: readonly PermissionMode[] = ["ask", "edits", "auto"];

/** The mode every session starts in, and the only one an untrusted project may use. */
export const SAFEST_MODE: PermissionMode = "ask";

/** One line per mode, for `/mode`'s selector and its command description. */
export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
	ask: "ask before anything that is not already allowed",
	edits: "approve file edits automatically, ask for the rest",
	auto: "never prompt, but screen every dangerous command",
	always: "approve everything, no guards at all",
	never: "refuse anything that would have prompted, instead of asking",
};

/** The names this layer used before it adopted pi's vocabulary. */
const LEGACY_MODE_NAMES: Readonly<Record<string, PermissionMode>> = {
	default: "ask",
	acceptEdits: "edits",
	bypass: "always",
	dontAsk: "never",
};

/**
 * Resolve a user-supplied mode name — current or legacy — or undefined when it names
 * no mode. Every entry point that accepts a mode name goes through this, so the legacy
 * spellings cannot work in one place and fail in another.
 */
export function parseMode(name: string): PermissionMode | undefined {
	const trimmed = name.trim();
	if ((PERMISSION_MODES as readonly string[]).includes(trimmed)) return trimmed as PermissionMode;
	return LEGACY_MODE_NAMES[trimmed];
}

/**
 * Is this mode allowed in a project the user has not trusted?
 *
 * Only the safest one is. An untrusted project is by definition one the user has not
 * vouched for, and pi already refuses to load its settings, extensions and skills for
 * that reason; letting the same repository run under a mode that auto-approves edits
 * or skips prompts entirely would hand back everything that gate withholds. `/trust`
 * is the way out, which is what the refusal message points at.
 */
export function isModeAllowedUntrusted(mode: PermissionMode): boolean {
	return mode === SAFEST_MODE;
}

/**
 * The mode a cycle from `mode` aims at. Exported so a caller that has to explain a
 * REFUSED cycle can name the mode that was actually attempted — the store reports the
 * mode still in effect, which for a refusal is the one the user already had.
 */
export function nextInCycle(mode: PermissionMode): PermissionMode {
	return MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
}

export interface ModeStore {
	/** Current mode. */
	get(): PermissionMode;
	/** User-initiated cycle to the next mode. Returns the mode now in effect — unchanged
	 *  when project trust refused the raise. */
	cycle(): PermissionMode;
	/** User-initiated set to a specific mode. Returns false when project trust refused it. */
	set(mode: PermissionMode): boolean;
	/** No-op; kept for the caller's create/dispose lifecycle symmetry. */
	dispose(): void;
}

/**
 * `onChange` fires on every mode change with the new mode — use it to refresh UI.
 *
 * `isTrusted` is consulted on every transition rather than once at construction: pi
 * resolves project trust during startup and a user can grant it mid-session with
 * `/trust`, so a snapshot taken when this store is built would strand the session in
 * the clamped mode for the rest of its life.
 */
export function createModeStore(
	onChange?: (mode: PermissionMode) => void,
	isTrusted: () => boolean = () => true,
): ModeStore {
	let mode: PermissionMode = SAFEST_MODE;

	function userTransition(next: PermissionMode): boolean {
		if (!isTrusted() && !isModeAllowedUntrusted(next)) return false;
		if (next === mode) return true;
		mode = next;
		onChange?.(mode);
		return true;
	}

	return {
		get: () => mode,
		cycle: () => {
			userTransition(nextInCycle(mode));
			return mode;
		},
		set: (next) => userTransition(next),
		dispose: () => {},
	};
}
