import { existsSync } from "node:fs";
import type { PaneLaunch } from "../ipc/protocol.ts";
import { Tmux } from "../tmux.ts";

export function launchUsable(launch: PaneLaunch | undefined): launch is PaneLaunch {
	if (!launch) return false;
	const [command, ...args] = launch.command;
	const script = args.at(-1);
	return command !== undefined && existsSync(command) && (script === undefined || existsSync(script));
}

export interface SessionSpec {
	cwd: string;
	task: string;
	model?: string;
	sessionFile?: string;
	launch: PaneLaunch;
}

export function startSession({ tmux = new Tmux(), ...spec }: SessionSpec & { tmux?: Tmux }): string {
	// pi reads any argument starting with `@` as a file to attach, even after `--`, and exits when no such file exists.
	const task = spec.task.startsWith("@") ? ` ${spec.task}` : spec.task;
	const args = spec.sessionFile
		? ["--session", spec.sessionFile, ...(task ? ["--", task] : [])]
		: [...(spec.model ? ["--model", spec.model] : []), "--", task];
	return tmux.newSession({ cwd: spec.cwd, command: spec.launch.command, args });
}
