/**
 * A shared reference to the active theme, for the TUI components in this
 * layer that read `theme.fg(...)` etc. as a module-level import rather than
 * a constructor parameter (fleet-view and friends — ported from the fork
 * branch, where pi's own `theme` singleton was importable directly).
 *
 * pi's own singleton (`modes/interactive/theme/theme.ts`) isn't part of the
 * public package export, so `branding`'s `session_start` handler calls
 * `setSharedTheme(ctx.ui.theme)` once per session to populate this — `theme`
 * below is a live ES module binding, so every importer sees the update.
 *
 * Assumption worth verifying live: this assumes `ctx.ui.theme` is (or wraps)
 * pi's own reactive theme object, so a switch via `/settings` after session
 * start still shows up here without a second `setSharedTheme` call. If a
 * live theme switch doesn't propagate to fleet/diff views, that assumption
 * is what to revisit.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";

const notReadyTheme = new Proxy({} as Theme, {
	get(): never {
		throw new Error("theme accessed before session_start populated it (setSharedTheme)");
	},
});

export let theme: Theme = notReadyTheme;

export function setSharedTheme(t: Theme): void {
	theme = t;
}
