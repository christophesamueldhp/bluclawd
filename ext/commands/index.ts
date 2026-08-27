/**
 * bluclawd slash commands.
 *
 * Output goes through `appendEntry` + `registerEntryRenderer` rather than
 * `ctx.ui.notify`: notify wraps the whole message in `theme.fg("dim", …)`,
 * which would flatten bold headings and coloured values. An entry renderer
 * returns a real Component, so the output matches what a built-in command
 * draws — verified byte-for-byte against the pre-extension implementation.
 *
 * Entry data is stored as plain values, never pre-coloured strings: entries are
 * persisted JSON, so the theme has to be applied at render time or a theme
 * change replays stale escape codes.
 *
 * Note that entries persist — output re-renders after `--continue`. That is
 * inherent to this API; the pre-extension implementation drew straight into the
 * transcript and was ephemeral.
 */
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { InlineExtension } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { openBrowser } from "../../../packages/coding-agent/src/utils/open-browser.ts";

/** bluclawd's own tracker — pi's `piConfig` does not cover this string. */
const BUG_REPORT_URL = "https://github.com/christophesamueldhp/bluclawd/issues";

interface BugData {
	url: string;
}

/** A blank line, then the block indented by one column — pi's own command-output shape. */
function block(lines: string[]): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Text(lines.join("\n"), 1, 0));
	return container;
}

const commands: InlineExtension = {
	name: "commands",
	factory: (pi) => {
		pi.registerEntryRenderer<BugData>("bluclawd:bug", (entry, _options, theme) => {
			const url = entry.data?.url ?? BUG_REPORT_URL;
			return block([theme.fg("dim", `Report bugs at: ${url}`)]);
		});

		pi.registerCommand("bug", {
			description: "Report a bug (opens the issue tracker)",
			handler: async () => {
				pi.appendEntry<BugData>("bluclawd:bug", { url: BUG_REPORT_URL });
				openBrowser(BUG_REPORT_URL);
			},
		});
	},
};

export default commands;
