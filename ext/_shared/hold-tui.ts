/**
 * pi hands no TUI to an extension, only to the widgets it draws, so a zero-line widget under `key`
 * gets the TUI. The widget stays until `ctx.ui.setWidget(key, undefined)`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

export function holdTui(ctx: ExtensionContext, key: string): () => TUI | undefined {
	let tui: TUI | undefined;
	ctx.ui.setWidget(key, (widgetTui) => {
		tui = widgetTui;
		return { render: () => [], invalidate: () => {} };
	});
	return () => tui;
}
