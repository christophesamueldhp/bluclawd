/**
 * The badge for pi's `defaultProjectTrust`: the permissions footer and agent view's hint line.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor, styleText } from "@earendil-works/pi-tui";

export type ProjectTrust = "always" | "ask" | "never";

const AMBER = rgbColor(255, 193, 7);

/** The colored badge for a `defaultProjectTrust` value. */
export function trustBadge(theme: Theme, trust: ProjectTrust): string {
	return trust === "always"
		? theme.getColorMode() === "truecolor"
			? styleText("⏵⏵ always", { fg: AMBER }, "truecolor")
			: theme.fg("warning", "⏵⏵ always")
		: trust === "ask"
			? theme.fg("muted", "⏸ ask")
			: theme.fg("error", "✕ never");
}
