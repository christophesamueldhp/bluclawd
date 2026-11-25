/**
 * The active theme, for TUI components that import `theme` at module level;
 * pi's own theme singleton is not exported.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "./global-state.ts";

const active = sharedRef<Theme | undefined>("theme", undefined);

export function activeTheme(): Theme {
	const current = active.get();
	if (!current) throw new Error("theme accessed before session_start populated it (setSharedTheme)");
	return current;
}

export const theme: Theme = new Proxy({} as Theme, {
	get(_target, key) {
		const current = activeTheme();
		const value = Reflect.get(current, key);
		return typeof value === "function" ? value.bind(current) : value;
	},
});

export function setSharedTheme(t: Theme): void {
	active.set(t);
}
