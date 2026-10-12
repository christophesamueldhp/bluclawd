/**
 * Panes the phone starts: a pi of its own in agent view's tmux server, with the arguments agent
 * view's composer and peek reply give it, so the session is the same as one started on the Mac.
 */
import { Tmux } from "../../ext/agent-view/tmux.ts";
import type { PaneLaunch } from "../ipc/protocol.ts";

export interface SessionSpec {
	cwd: string;
	/** The first prompt: a new session's task, or the reply that resumes a stored one. */
	task: string;
	/** `provider/id`. */
	model?: string;
	/** Resume this session instead of starting a new one. */
	sessionFile?: string;
	launch: PaneLaunch;
}

/** Returns the pane's tmux session name, which is also the id its row registers as. */
export function startSession({ tmux = new Tmux(), ...spec }: SessionSpec & { tmux?: Tmux }): string {
	const args = spec.sessionFile
		? ["--session", spec.sessionFile, "--", spec.task]
		: [...(spec.model ? ["--model", spec.model] : []), "--", spec.task];
	return tmux.newSession({ cwd: spec.cwd, command: spec.launch.command, args });
}
