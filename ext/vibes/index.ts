/**
 * Vibes extension: each agent turn shows a spinner verb and its elapsed time
 * ("Pondering… (12s · esc to interrupt)") in place of "Working...". Always on,
 * nothing to configure, no model calls.
 */
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { pickVibe, SPINNER_VERBS } from "./vibes.ts";

function factory(pi: ExtensionAPI): void {
	const seed = Date.now();
	let index = 0;
	let timer: ReturnType<typeof setInterval> | undefined;

	pi.on("before_agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		clearInterval(timer);
		const verb = pickVibe(SPINNER_VERBS, index++, seed);
		const startedAt = Date.now();
		const show = () => {
			const seconds = Math.floor((Date.now() - startedAt) / 1000);
			ctx.ui.setWorkingMessage(`${verb}… (${seconds}s · esc to interrupt)`);
		};
		show();
		timer = setInterval(show, 1000);
		timer.unref?.();
	});

	pi.on("agent_end", (_event, ctx) => {
		clearInterval(timer);
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
}

const vibesExtension: InlineExtension = { name: "vibes", factory };
export default vibesExtension.factory;
