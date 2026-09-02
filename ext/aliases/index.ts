/**
 * Claude Code's names for things pi already does under other names:
 *
 *   /clear         → pi's /new       (start a fresh session)
 *   /exit          → pi's /quit      (leave)
 *   /rename <name> → pi's /name      (name the current session)
 *
 * pi has no hidden-alias mechanism (`registerCommand` has no alias field, and
 * the `input` event fires only after the built-in command chain), so these are
 * real commands and show up in autocomplete next to pi's own names. That is the
 * price of parity here; the alternative — patching pi's built-in table — is the
 * fork approach this package exists to avoid.
 *
 * Not aliased, because no extension route reaches them: /config (pi's settings
 * selector is a private interactive-mode panel) and /keybindings (same, for
 * pi's /hotkeys panel).
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const aliases: InlineExtension = {
	name: "aliases",
	factory: (pi) => {
		pi.registerCommand("clear", {
			description: "Start a new session (same as /new)",
			handler: async (_args, ctx) => {
				await ctx.newSession();
			},
		});

		pi.registerCommand("exit", {
			description: "Exit (same as /quit)",
			handler: async (_args, ctx) => {
				ctx.shutdown();
			},
		});

		pi.registerCommand("rename", {
			description: "Name the current session (same as /name)",
			handler: async (args, ctx) => {
				const name = args.trim();
				if (!name) {
					const current = pi.getSessionName();
					ctx.ui.notify(
						current ? `Session name: ${current}\nUsage: /rename <name>` : "Usage: /rename <name>",
						"info",
					);
					return;
				}
				pi.setSessionName(name);
				ctx.ui.notify(`Session renamed to "${name}".`, "info");
			},
		});
	},
};

export default aliases.factory;
