/**
 * Permission mode store: holds the session-scoped permission mode and enforces the
 * one rule project trust imposes on it (see {@link createModeStore}).
 *
 * `auto` is the bypass mode: it approves everything the rules do not veto. Legacy
 * names (`default`, `acceptEdits`, `always`, `bypass`) still resolve via
 * {@link parseMode}, so stored settings and scripts keep working.
 */

export type PermissionMode = "ask" | "edits" | "auto";

export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "edits", "auto"];

/** Cycle order for Alt+M and a bare `/mode`, in increasing autonomy. */
export const MODE_CYCLE: readonly PermissionMode[] = ["ask", "edits", "auto"];

/** The only mode an untrusted project may use, and what an untrusted or freshly
 *  constructed store falls back to. Kept separate from {@link DEFAULT_MODE} so
 *  raising the product default can never loosen this floor. */
export const SAFEST_MODE: PermissionMode = "ask";

/** The mode a trusted session starts in absent an explicit `permissions.defaultMode`
 *  or `--permission-mode`/`--dangerously-skip-permissions` flag. */
export const DEFAULT_MODE: PermissionMode = "auto";

/** One line per mode, for `/mode`'s selector and its command description. */
export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
	ask: "ask before every edit and every non-read-only command the rules do not allow",
	edits: "approve file edits automatically, ask for the rest",
	auto: "never prompt: only deny and ask rules can stop a call",
};

const LEGACY_MODE_NAMES: Readonly<Record<string, PermissionMode>> = {
	default: "ask",
	acceptEdits: "edits",
	always: "auto",
	bypass: "auto",
};

/**
 * Resolve a user-supplied mode name — current or legacy — or undefined when it names
 * no mode. Every entry point goes through this so legacy spellings behave the same
 * everywhere.
 */
export function parseMode(name: string): PermissionMode | undefined {
	const trimmed = name.trim();
	if ((PERMISSION_MODES as readonly string[]).includes(trimmed)) return trimmed as PermissionMode;
	return LEGACY_MODE_NAMES[trimmed];
}

/**
 * Only the safest mode is allowed in an untrusted project: pi already withholds its
 * settings, extensions and skills, and an auto-approving mode would hand that back.
 */
export function isModeAllowedUntrusted(mode: PermissionMode): boolean {
	return mode === SAFEST_MODE;
}

/**
 * The mode a cycle from `mode` aims at. Exported so a refused cycle can name the
 * attempted mode; the store only reports the mode still in effect.
 */
export function nextInCycle(mode: PermissionMode): PermissionMode {
	return MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
}

export interface ModeStore {
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
 * `isTrusted` is consulted on every transition, not once at construction: trust can
 * be granted mid-session with `/trust`, and a snapshot would strand the session in
 * the clamped mode.
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
