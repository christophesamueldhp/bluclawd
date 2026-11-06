/**
 * Vibes extension: each agent turn shows a spinner verb and its elapsed time
 * ("Pondering… (12s · escape to interrupt)") in place of "Working...". Always on,
 * nothing to configure, no model calls.
 */
import { type ExtensionAPI, type InlineExtension, keyText } from "@earendil-works/pi-coding-agent";
import { timed } from "../_shared/timing.ts";
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
			ctx.ui.setWorkingMessage(`${verb}… (${seconds}s · ${keyText("app.interrupt")} to interrupt)`);
		};
		show();
		timer = setInterval(show, 1000);
		timer.unref?.();
	});

	// A run can end several agent passes (retries, queued follow-ups); it settles once.
	pi.on("agent_settled", (_event, ctx) => {
		clearInterval(timer);
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", () => clearInterval(timer));
}

const vibesExtension: InlineExtension = { name: "vibes", factory };
export default timed("vibes", vibesExtension.factory);
