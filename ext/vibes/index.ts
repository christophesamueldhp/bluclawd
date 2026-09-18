/**
 * Vibes extension: each agent turn shows one of Claude Code's spinner verbs
 * ("Pondering...", "Clauding...") in place of "Working...". Always on, nothing
 * to configure, no model calls.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { pickVibe, SPINNER_VERBS } from "./vibes.ts";

export function factory(pi: ExtensionAPI): void {
	const seed = Date.now();
	let index = 0;

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWorkingMessage(`${pickVibe(SPINNER_VERBS, index++, seed)}...`);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
}

const vibesExtension: InlineExtension = { name: "vibes", factory };
export default vibesExtension.factory;
