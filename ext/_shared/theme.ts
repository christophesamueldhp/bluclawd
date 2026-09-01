/**
 * A shared reference to the active theme, for the TUI components in this
 * layer that read `theme.fg(...)` etc. as a module-level import rather than
 * a constructor parameter (fleet-view and friends — ported from the fork
 * branch, where pi's own `theme` singleton was importable directly).
 *
 * pi's own singleton (`modes/interactive/theme/theme.ts`) isn't part of the
 * public package export, so `setSharedTheme(ctx.ui.theme)` populates this
 * instead — but "this" is NOT one singleton shared by the whole layer.
 * `package.json`'s `pi.extensions` lists each top-level file separately, and
 * pi's loader (`loadExtensionModule`, `moduleCache: false`) gives each of
 * those its OWN module graph. `_shared/theme.ts` is the same file on disk but
 * a SEPARATE loaded instance per top-level extension — a value set from
 * `branding`'s copy is invisible to `diff`'s or `fleet`'s. Confirmed live:
 * `/diff` crashed with "theme accessed before session_start populated it"
 * even though branding's welcome banner (which sets its own copy) had
 * already rendered.
 *
 * So every top-level extension that transitively imports this file calls
 * `setSharedTheme` itself: `branding` and `fleet` in their `session_start`
 * handler, `diff` right before constructing `DiffView` (no `session_start`
 * handler of its own, and setting it adjacent to the read means a mid-session
 * `/settings` theme switch is picked up for free — worth doing in the other
 * two as well if that turns out to matter for them).
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
