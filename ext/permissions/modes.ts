/**
 * Permission mode store (PLAN.md F2.1).
 *
 * Holds the session-scoped permission mode.
 */

export type PermissionMode = "default" | "acceptEdits" | "auto" | "bypass" | "dontAsk";

/**
 * Every valid mode name — the vocabulary accepted by `--permission-mode`,
 * `permissions.defaultMode` and `/mode <name>`.
 *
 * Deliberately WIDER than MODE_CYCLE: `bypass` and `dontAsk` are nameable but not
 * reachable by keyboard. Do not collapse the two back into one list — that is what put
 * bypass four Shift+Tab presses from `default`.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "auto", "bypass", "dontAsk"];

/**
 * Cycle order for Shift+Tab and a bare `/mode`, in increasing autonomy.
 *
 * The two non-interactive modes are deliberately NOT here (Claude Code parity — its
 * own remote-session allowlist is likewise `acceptEdits|plan|default|auto`, excluding
 * exactly these two). `bypass` disables every guard; `dontAsk` silently converts every
 * would-be prompt into a refusal, so landing on it by accident looks like the agent
 * breaking rather than a mode change. Both must be named: `/mode <name>`,
 * `--permission-mode <name>`, `--dangerously-skip-permissions` (bypass), or
 * `permissions.defaultMode`. Cycling FROM either still works: they are not in the
 * list, so `indexOf` returns -1 and the cycle resumes at `default`.
 */
export const MODE_CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "auto"];

export interface ModeStore {
	/** Current mode. */
	get(): PermissionMode;
	/** User-initiated cycle to the next mode. Returns the new mode. */
	cycle(): PermissionMode;
	/** User-initiated set to a specific mode. */
	set(mode: PermissionMode): void;
	/** No-op; kept for the caller's create/dispose lifecycle symmetry. */
	dispose(): void;
}

/** `onChange` fires on every mode change with the new mode — use it to refresh UI. */
export function createModeStore(onChange?: (mode: PermissionMode) => void): ModeStore {
	let mode: PermissionMode = "default";

	function userTransition(next: PermissionMode): void {
		if (next === mode) return;
		mode = next;
		onChange?.(mode);
	}

	return {
		get: () => mode,
		cycle: () => {
			const idx = MODE_CYCLE.indexOf(mode);
			const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
			userTransition(next);
			return mode;
		},
		set: (next) => userTransition(next),
		dispose: () => {},
	};
}
