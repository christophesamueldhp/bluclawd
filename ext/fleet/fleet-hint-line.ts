import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../_shared/theme.ts";

/**
 * A single dim hint line shown just below the prompt input for the FleetView ←← gesture.
 * Renders nothing (zero lines) when there is no hint, so it takes no vertical space when idle.
 */
export class FleetHintLine implements Component {
	private readonly getText: () => string | null;

	constructor(getText: () => string | null) {
		this.getText = getText;
	}

	render(width: number): string[] {
		const text = this.getText();
		return text ? [truncateToWidth(theme.fg("dim", text), width)] : [];
	}

	invalidate(): void {}
}
