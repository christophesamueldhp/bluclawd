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
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	backgroundBashJobs,
	createBashOutputTool,
	createKillBashTool,
	describeJobStatus,
} from "../_shared/background-bash.ts";
import {
	MONITOR_MESSAGE_TYPE,
	type MonitorMessageDetails,
	TASK_EXIT_MESSAGE_TYPE,
	type TaskExitDetails,
} from "../_shared/monitor-events.ts";

const MAX_COMMAND_CHARS = 80;

interface TaskSnapshot {
	id: string;
	kind: "job" | "monitor";
	command: string;
	status: string;
	seconds: number;
	running: boolean;
	events: number;
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

		// Events land out of band, so each carries its own header. The header is
		// accent, event lines are plain, and the terminal line takes the colour of
		// the outcome: an exit is the one thing a monitor must never be silent about.
		pi.registerMessageRenderer<MonitorMessageDetails>(MONITOR_MESSAGE_TYPE, (message, { outputPad }, theme) => {
			const d = message.details;
			const lines: string[] = [
				theme.fg("accent", `monitor ${d?.id ?? ""}`) + theme.fg("dim", ` · ${d?.description ?? ""}`),
			];
			for (const line of d?.lines ?? []) lines.push(line);
			if (d && d.more > 0) lines.push(theme.fg("dim", `…and ${d.more} more lines (bash_output)`));
			if (d?.end) lines.push(theme.fg(d.status ?? "dim", d.end));
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(lines.join("\n"), 0, 0));
			return box;
		});

		pi.registerMessageRenderer<TaskExitDetails>(TASK_EXIT_MESSAGE_TYPE, (message, { outputPad }, theme) => {
			const d = message.details;
			const lines: string[] = [
				theme.fg("accent", `task ${d?.id ?? ""}`) +
					theme.fg("dim", ` · ${d?.description ?? ""} `) +
					theme.fg(d?.status ?? "dim", d?.end ?? "") +
					theme.fg("dim", ` — ${d?.command ?? ""}`),
			];
			if (d?.tail) lines.push(d.tail);
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(lines.join("\n"), 0, 0));
			return box;
		});

		pi.registerEntryRenderer<TasksData>("bluclawd:tasks", (entry, _options, theme) => {
			const jobs = entry.data?.jobs ?? [];
			const lines: string[] = [theme.bold("Background tasks")];
			if (jobs.length === 0) {
				lines.push(
					theme.fg(
						"dim",
						"No background tasks. bash with run_in_background starts a job; monitor starts a watch.",
					),
				);
			} else {
				for (const job of jobs) {
					const kind = job.kind === "monitor" ? theme.fg("warning", "monitor") : theme.fg("dim", "job");
					const events = job.kind === "monitor" ? theme.fg("dim", ` ${job.events} events`) : "";
					lines.push(
						`  ${theme.fg("accent", job.id)} ${kind} ${job.running ? theme.fg("success", job.status) : theme.fg("dim", job.status)} ${theme.fg("dim", `${job.seconds}s`)}${events} ${job.command}`,
					);
				}
				lines.push("");
				lines.push(
					theme.fg(
						"dim",
						"Read output: bash_output · stop: kill_bash (ask the model, or use ! with ps). monitor starts a watch.",
					),
				);
			}
			return block(lines);
		});

		pi.registerCommand("tasks", {
			description: "List background bash tasks",
			handler: async () => {
				const now = Date.now();
				const jobs: TaskSnapshot[] = backgroundBashJobs.list().map((job) => ({
					id: job.id,
					kind: job.kind,
					command:
						job.command.length > MAX_COMMAND_CHARS
							? `${job.command.slice(0, MAX_COMMAND_CHARS - 3)}...`
							: job.command,
					status: describeJobStatus(job),
					seconds: Math.max(0, Math.round(((job.exit?.at ?? now) - job.startedAt) / 1000)),
					running: !job.exit,
					events: job.events,
				}));
				pi.appendEntry<TasksData>("bluclawd:tasks", { jobs });
			},
		});
	},
};

export default backgroundBash.factory;
