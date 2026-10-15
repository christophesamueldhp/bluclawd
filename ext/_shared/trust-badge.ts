/**
 * The badge for pi's `defaultProjectTrust`: the permissions footer and agent view's hint line.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export type ProjectTrust = "always" | "ask" | "never";

const AMBER = "\x1b[38;2;255;193;7m";

/** The colored badge for a `defaultProjectTrust` value. */
export function trustBadge(theme: Theme, trust: ProjectTrust): string {
	return trust === "always"
		? theme.getColorMode() === "truecolor"
			? `${AMBER}⏵⏵ always\x1b[39m`
			: theme.fg("warning", "⏵⏵ always")
		: trust === "ask"
			? theme.fg("muted", "⏸ ask")
			: theme.fg("error", "✕ never");
}
