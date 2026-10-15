/**
 * Panes the phone starts: a pi of its own in agent view's tmux server, with the arguments agent
 * view's composer and peek reply give it, so the session is the same as one started on the Mac.
 */
import { existsSync } from "node:fs";
import type { PaneLaunch } from "../ipc/protocol.ts";
import { Tmux } from "../tmux.ts";

/** Its files are still there: a pane started with a node or pi that has moved since (an upgrade)
 *  would die at once. */
export function launchUsable(launch: PaneLaunch | undefined): launch is PaneLaunch {
	if (!launch) return false;
	const [command, ...args] = launch.command;
	const script = args.at(-1);
	return command !== undefined && existsSync(command) && (script === undefined || existsSync(script));
}

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
	// pi reads any argument starting with `@` as a file to attach, even after `--`, and exits when
	// it is missing; it does not trim, so a leading space keeps it a message.
	const task = spec.task.startsWith("@") ? ` ${spec.task}` : spec.task;
	const args = spec.sessionFile
		? ["--session", spec.sessionFile, "--", task]
		: [...(spec.model ? ["--model", spec.model] : []), "--", task];
	return tmux.newSession({ cwd: spec.cwd, command: spec.launch.command, args });
}
