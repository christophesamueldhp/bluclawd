/**
 * Background shell jobs: the `bash_output` / `kill_bash` tools and `/tasks`.
 *
 * The `run_in_background` parameter that STARTS a job does not live here — only
 * one extension may own the `bash` tool name, and the sandbox extension already
 * does, so the parameter is registered there against the same job registry in
 * `_shared/background-bash.ts`. Change one, look at the other.
 *
 * `/tasks` renders through `appendEntry` + `registerEntryRenderer` rather than
 * `ctx.ui.notify`, which would dim the whole block and flatten the heading and
 * per-job status colours. Entry data is a snapshot of plain values: entries are
 * persisted JSON, so the theme is applied at render time, and the elapsed
 * seconds are frozen at command time because the output is a moment, not a live
 * view.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	backgroundBashJobs,
	createBashOutputTool,
	createKillBashTool,
	describeJobStatus,
} from "../_shared/background-bash.ts";

const MAX_COMMAND_CHARS = 80;

interface TaskSnapshot {
	id: string;
	command: string;
	status: string;
	seconds: number;
	running: boolean;
}

interface TasksData {
	jobs: TaskSnapshot[];
}

/** A blank line, then the block indented by one column — pi's own command-output shape. */
function block(lines: string[]): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Text(lines.join("\n"), 1, 0));
	return container;
}

const backgroundBash: InlineExtension = {
	name: "background-bash",
	factory: (pi) => {
		pi.registerTool(createBashOutputTool());
		pi.registerTool(createKillBashTool());

		pi.registerEntryRenderer<TasksData>("bluclawd:tasks", (entry, _options, theme) => {
			const jobs = entry.data?.jobs ?? [];
			const lines: string[] = [theme.bold("Background tasks")];
			if (jobs.length === 0) {
				lines.push(theme.fg("dim", "No background tasks. The bash tool starts one with run_in_background: true."));
			} else {
				for (const job of jobs) {
					lines.push(
						`  ${theme.fg("accent", job.id)} ${job.running ? theme.fg("success", job.status) : theme.fg("dim", job.status)} ${theme.fg("dim", `${job.seconds}s`)} ${job.command}`,
					);
				}
				lines.push("");
				lines.push(theme.fg("dim", "Read output: bash_output · stop: kill_bash (ask the model, or use ! with ps)"));
			}
			return block(lines);
		});

		pi.registerCommand("tasks", {
			description: "List background bash tasks",
			handler: async () => {
				const now = Date.now();
				const jobs: TaskSnapshot[] = backgroundBashJobs.list().map((job) => ({
					id: job.id,
					command:
						job.command.length > MAX_COMMAND_CHARS
							? `${job.command.slice(0, MAX_COMMAND_CHARS - 3)}...`
							: job.command,
					status: describeJobStatus(job),
					seconds: Math.max(0, Math.round(((job.exit?.at ?? now) - job.startedAt) / 1000)),
					running: !job.exit,
				}));
				pi.appendEntry<TasksData>("bluclawd:tasks", { jobs });
			},
		});
	},
};

export default backgroundBash;
