import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOREGROUND_PANE_ENV, outerTmuxEnv, type Tmux } from "../../daemon/tmux.ts";
import { holdTui } from "../_shared/hold-tui.ts";

const SESSION_FLAGS: ReadonlySet<string> = new Set(["-c", "--continue", "-r", "--resume"]);
const SESSION_VALUE_FLAGS: ReadonlySet<string> = new Set(["--session", "--session-id", "--fork"]);

export function paneArgs(argv: string[], sessionFile: string | undefined): string[] {
	if (!sessionFile || !existsSync(sessionFile)) return argv;
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			out.push(...argv.slice(i));
			break;
		}
		if (SESSION_FLAGS.has(arg)) continue;
		if (SESSION_VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if ([...SESSION_VALUE_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) continue;
		out.push(arg);
	}
	return ["--session", sessionFile, ...out];
}

export function launchInTmux(ctx: ExtensionContext, panes: Tmux): boolean {
	let name: string;
	try {
		name = panes.newSession({
			cwd: ctx.cwd,
			args: paneArgs(process.argv.slice(2), ctx.sessionManager.getSessionFile()),
			env: { ...outerTmuxEnv(), [FOREGROUND_PANE_ENV]: "1" },
		});
	} catch (error) {
		ctx.ui.notify(
			`Agent view is off — tmux couldn't start: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return false;
	}
	const tui = holdTui(ctx, "agent-view:launch")();
	ctx.ui.setWidget("agent-view:launch", undefined);
	// Fullscreen pi copies its last frame to the terminal's own screen on stop; this one is
	// not the session's, so it would stay behind once tmux leaves.
	(tui as { stop(options?: { preserveScreen?: boolean }): void } | undefined)?.stop({ preserveScreen: true });
	panes.attach(name);
	// tmux's own "[detached (from session …)]" / "[exited]" line.
	process.stdout.write("\x1b[1A\r\x1b[2K");
	process.exit(0);
}
