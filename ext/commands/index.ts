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
import { existsSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The `/init` prompt.
 *
 * Deliberately submitted as ordinary user input rather than run as a tool call:
 * it flows through the normal submission path, so compaction, streaming and
 * queueing behave exactly as they do for something the user typed.
 */
function buildInitPrompt(cwd: string): string {
	const goal = existsSync(join(cwd, "AGENTS.md"))
		? "An AGENTS.md already exists in this repository. Read it first, then improve it in place with surgical edits — fix anything outdated, fill real gaps, and remove fluff. Do not rewrite sections that are still accurate."
		: "Create an AGENTS.md file at the repository root.";
	return `Analyze this repository and prepare its agent context file.

${goal}

AGENTS.md is loaded into every agent session here, so it must earn its tokens. Include only what an agent could not trivially discover on its own:
- Build, test, and lint commands that actually work in this repo (including how to run a single test).
- A short architecture overview: the main packages/modules, entry points, and how they connect.
- Code style and conventions that differ from language defaults (imports, naming, error handling, formatting tools).
- Gotchas a newcomer would hit: required env vars, generated files that must not be hand-edited, known flaky tests, pre-commit hooks.

Keep it under ~150 lines of markdown. No generic advice, no restating what the code makes obvious.`;
}

const commands: InlineExtension = {
	name: "commands",
	factory: (pi) => {
		pi.registerEntryRenderer<BugData>("bluclawd:bug", (entry, _options, theme) => {
			const url = entry.data?.url ?? BUG_REPORT_URL;
			return block([theme.fg("dim", `Report bugs at: ${url}`)]);
		});

		pi.registerCommand("init", {
			description: "Analyze the project and create AGENTS.md",
			handler: async (_args, ctx) => {
				pi.sendUserMessage(buildInitPrompt(ctx.cwd));
			},
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
