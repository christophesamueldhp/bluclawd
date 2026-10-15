/**
 * pi hands an extension no TUI, only to the widgets it draws: a zero-line widget under `key` gets
 * hold of it. The widget stays until `ctx.ui.setWidget(key, undefined)`.
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
