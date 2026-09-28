/**
 * The active theme, for TUI components that import `theme` at module level;
 * pi's own theme singleton is not exported.
 *
 * This is NOT one instance for the whole layer: pi gives each `pi.extensions`
 * entry its own module graph, so a value set from one extension's copy is
 * invisible to another's. Every top-level extension that transitively imports
 * this file must call `setSharedTheme(ctx.ui.theme)` itself.
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
