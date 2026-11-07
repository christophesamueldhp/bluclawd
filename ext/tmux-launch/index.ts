/**
 * Outside tmux, `pi` run in a terminal starts its session as an agent-view pane and only attaches
 * to it (ext/agent-view/launch.ts). First of all extensions, so the others don't run their startup
 * in a process that is about to become a tmux client. Without tmux, agent view says so.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Tmux } from "../../daemon/tmux.ts";
import { timed } from "../_shared/timing.ts";
import { launchInTmux } from "../agent-view/launch.ts";

const tmuxLaunch: InlineExtension = {
	name: "tmux-launch",
	factory: (pi) => {
		let launched = false;
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || Tmux.currentPane() || launched) return;
			launched = true;
			if (Tmux.available()) launchInTmux(ctx, new Tmux());
		});
	},
};

export default timed("tmux-launch", tmuxLaunch.factory);
