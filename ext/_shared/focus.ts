import type { Component } from "@earendil-works/pi-tui";

/** The component that has the keyboard; undefined when the TUI cannot say. */
export function focusedComponent(tui: unknown): Component | null | undefined {
	// getFocusedComponent is on pi-tui's TUI class, not its TUI interface.
	return (tui as { getFocusedComponent?: () => Component | null } | undefined)?.getFocusedComponent?.();
}

/** Whether `component` is the prompt editor: of the components that take focus, only it has getText. */
export function isPromptEditor(component: unknown): boolean {
	return typeof (component as { getText?: unknown } | null | undefined)?.getText === "function";
}
