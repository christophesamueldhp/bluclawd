import type { Component } from "@earendil-works/pi-tui";

export function focusedComponent(tui: unknown): Component | null | undefined {
	// getFocusedComponent is on pi-tui's TUI class, not its TUI interface.
	return (tui as { getFocusedComponent?: () => Component | null } | undefined)?.getFocusedComponent?.();
}

export function isPromptEditor(component: unknown): boolean {
	return typeof (component as { getText?: unknown } | null | undefined)?.getText === "function";
}
