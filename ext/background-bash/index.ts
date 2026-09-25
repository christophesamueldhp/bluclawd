/**
 * Background tasks, the user's side: `/tasks`, the footer's task count, Ctrl+B
 * to move a running foreground bash into the background, and the renderers for
 * job events.
 *
 * Nothing here starts a job or answers the model: `run_in_background` and the
 * monitor live on the sandbox extension (the one owner of the `bash` name), and
 * `task_stop` on the subagents extension, which owns that name;
 * the shell half of both sits in `_shared/background-bash.ts`. Change one, look
 * at the others.
 *
 * The two message renderers here draw events whose senders also live in
 * `ext/sandbox`: `monitor-tool.ts` and the `run_in_background` exit hook. Same
 * coupling as the parameter above — change one, look at the other.
 *
 * Interactive `/tasks` is a dialog; without a UI it renders through
 * `appendEntry` + `registerEntryRenderer` rather than `ctx.ui.notify`, which would dim the whole block and flatten the heading and
 * per-job status colours. Entry data is a snapshot of plain values: entries are
 * persisted JSON, so the theme is applied at render time, and the elapsed
 * seconds are frozen at command time because the output is a moment, not a live
 * view.
 */

import type { ExtensionCommandContext, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, matchesKey, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { subscribeAgentTasks } from "../_shared/agent-tasks.ts";
import { stripAnsi } from "../_shared/ansi.ts";
import { backgroundBashJobs, describeJobStatus } from "../_shared/background-bash.ts";
import { backgroundTasksDisabled } from "../_shared/bash-limits.ts";
import { detachAll, runningForegroundShells, subscribeForegroundShells } from "../_shared/foreground-shells.ts";
import { sharedRef } from "../_shared/global-state.ts";
import {
	MONITOR_MESSAGE_TYPE,
	type MonitorMessageDetails,
	TASK_EXIT_MESSAGE_TYPE,
	type TaskExitDetails,
} from "../_shared/monitor-events.ts";
import {
	heldNotifications,
	heldNotificationsLine,
	holdNotifications,
	subscribeNotificationHold,
} from "../_shared/notification-hold.ts";
import { findOrphanShells, orphanShellMessage, SHELL_END_ENTRY } from "../_shared/orphan-shells.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { type TaskRow, TasksDialog, taskRows } from "./tasks-dialog.ts";

const MAX_COMMAND_CHARS = 80;

/**
 * Child output reaches the frame verbatim, so escape sequences it wrote for its own
 * terminal (colour, but also erase-line and cursor moves) would corrupt the render.
 * Tabs and newlines are legitimate text and stay.
 */
const clean = (s: string) => stripAnsi(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

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

/** Claude Code's dot for a message line (`⏺` on macOS, `●` elsewhere). */
const NOTIFICATION_DOT = process.platform === "darwin" ? "⏺" : "●";
const NOTIFICATION_DOT_COLOR: Record<string, "success" | "error" | "warning" | undefined> = {
	completed: "success",
	failed: "error",
	killed: "warning",
};

/** Claude Code's `background` colour (dark theme), the footer pill's. */
const PILL = (text: string) => `\x1b[38;2;0;204;204m${text}\x1b[39m`;
const INVERSE = (text: string) => `\x1b[7m${text}\x1b[27m`;
/** Claude Code shows the Ctrl+B hint once a foreground command has run this long. */
const BACKGROUND_HINT_MS = 2000;

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * The footer pill's label, Claude Code's: named by type when every running task
 * shares one (shells and monitors are both shell tasks), else a plain count.
 * Subagents are left out: the subagents extension lists them under the mode line.
 */
export function tasksPillLabel(rows: TaskRow[]): string | undefined {
	const running = rows.filter((r) => r.state === "running" && r.kind !== "agent");
	if (running.length === 0) return undefined;
	const type = (r: TaskRow) => (r.id.startsWith("s") ? "ws" : "shell");
	const types = new Set(running.map(type));
	if (types.size > 1) return count(running.length, "background task", "background tasks");
	if (types.has("ws")) return count(running.length, "monitor", "monitors");
	const shells = running.filter((r) => r.kind === "shell").length;
	const monitors = running.length - shells;
	return [shells ? count(shells, "shell", "shells") : "", monitors ? count(monitors, "monitor", "monitors") : ""]
		.filter(Boolean)
		.join(", ");
}

/** The Ctrl+B hint; under tmux Ctrl+B is the prefix, so it takes two presses. */
export function backgroundHint(): string {
	const key = process.env.TMUX ? "ctrl+b ctrl+b (twice)" : "ctrl+b";
	return `(${key} to run in background)`;
}

/** Only the prompt editor has getText among the components that take focus. */
const isEditor = (component: unknown) => typeof (component as { getText?: unknown } | null)?.getText === "function";

/**
 * The main session's id, for handing its jobs to the next one on /clear. pi builds a
 * new instance of this extension per session, so it cannot live in the instance.
 */
const lastMainSession = sharedRef<string | undefined>("backgroundBash.lastMainSession", undefined);

const backgroundBash: InlineExtension = {
	name: "background-bash",
	factory: (pi) => {
		let ctx: ExtensionContext | undefined;
		let tui: TUI | undefined;
		let pillSelected = false;
		let hintTimer: ReturnType<typeof setTimeout> | undefined;
		const cleanups: (() => void)[] = [];

		const owner = () => ctx?.sessionManager?.getSessionId();

		/**
		 * Shells the resumed conversation started but never heard the end of: the model is
		 * told once, without a turn being started for it, and the report is recorded as
		 * their end so the next resume does not repeat it.
		 */
		const reportOrphanShells = (startCtx: ExtensionContext) => {
			const { orphans, live } = findOrphanShells(startCtx.sessionManager.getBranch(), (id) =>
				Boolean(backgroundBashJobs.get(id)),
			);
			const message = orphanShellMessage(orphans, live);
			if (!message) return;
			pi.sendMessage(message, { deliverAs: "steer", triggerTurn: false });
			for (const orphan of orphans) pi.appendEntry(SHELL_END_ENTRY, { taskId: orphan.taskId });
		};

		/** The footer pill: its label, then what ↓ (or Enter, once selected) does. */
		const refresh = () => {
			if (!ctx?.hasUI) return;
			const label = tasksPillLabel(taskRows(owner()));
			if (!label) pillSelected = false;
			// Claude Code's default footer: the hint is an item of its own, after a dim dot.
			const hint = pillSelected ? "Enter to view tasks" : "↓ to manage";
			const pill = pillSelected ? INVERSE(PILL(label ?? "")) : PILL(label ?? "");
			ctx.ui.setStatus(STATUS_KEYS.tasks, label ? `${pill}${ctx.ui.theme.fg("dim", ` · ${hint}`)}` : undefined);
			tui?.requestRender();
		};

		/** The Ctrl+B hint appears 2s into a foreground command, so it needs a render then. */
		const onForegroundChange = () => {
			clearTimeout(hintTimer);
			const shells = runningForegroundShells();
			if (shells.length > 0) {
				const due = Math.min(...shells.map((s) => s.startedAt)) + BACKGROUND_HINT_MS - Date.now();
				hintTimer = setTimeout(() => tui?.requestRender(), Math.max(0, due));
			}
			tui?.requestRender();
		};

		const openDialog = async (ui: ExtensionContext["ui"], sessionOwner: string | undefined) => {
			// Updates wait while the panel is open (Claude Code), and go out when it closes.
			const release = holdNotifications();
			try {
				await showDialog(ui, sessionOwner);
			} finally {
				release();
			}
		};

		const showDialog = async (ui: ExtensionContext["ui"], sessionOwner: string | undefined) => {
			await ui.custom<void>((dialogTui, theme, _keybindings, done) => {
				const dialog = new TasksDialog(
					theme,
					sessionOwner,
					() => done(undefined),
					() => dialogTui.requestRender(),
					{
						notify: (message) => ui.notify(message, "info"),
						held: () => heldNotificationsLine(heldNotifications()),
					},
				);
				// Runtimes and output tails move on their own.
				const timer = setInterval(() => dialogTui.requestRender(), 1000);
				const offJobs = backgroundBashJobs.subscribe(() => dialogTui.requestRender());
				const offHeld = subscribeNotificationHold(() => dialogTui.requestRender());
				return Object.assign(dialog as Component, {
					dispose: () => {
						clearInterval(timer);
						offJobs();
						offHeld();
					},
				});
			});
		};

		const deselect = () => {
			if (!pillSelected) return;
			pillSelected = false;
			refresh();
		};

		pi.on("session_start", (event, startCtx) => {
			ctx = startCtx;
			const session = startCtx.sessionManager.getSessionId();
			// Claude Code keeps background shells across /clear: the new session owns them.
			const previous = lastMainSession.get();
			if (event.reason === "new" && previous && previous !== session) backgroundBashJobs.reown(previous, session);
			lastMainSession.set(session);
			if (event.reason === "startup" || event.reason === "resume") reportOrphanShells(startCtx);
			pillSelected = false;
			for (const off of cleanups.splice(0)) off();
			cleanups.push(
				backgroundBashJobs.subscribe(refresh),
				subscribeAgentTasks(refresh),
				subscribeForegroundShells(onForegroundChange),
			);
			if (startCtx.hasUI) {
				const ui = startCtx.ui;
				// Always mounted: it renders nothing until a foreground command has run 2s.
				ui.setWidget("background-bash:hint", (widgetTui, theme) => {
					tui = widgetTui;
					return {
						render: () => {
							const shells = runningForegroundShells();
							if (!shells.some((s) => Date.now() - s.startedAt >= BACKGROUND_HINT_MS)) return [];
							return [`     ${theme.fg("dim", backgroundHint())}`];
						},
						invalidate: () => {},
					};
				});
				cleanups.push(
					ui.onTerminalInput((data) => {
						// Ctrl+B is the editor's cursor-left, so the key is taken only while a
						// foreground bash is running and would otherwise do nothing useful.
						if (matchesKey(data, "ctrl+b") && detachAll("user") > 0) return { consume: true };
						// ↓ from an empty prompt selects the pill, Enter opens it (Claude Code).
						// Nothing is taken while a dialog or overlay has the keyboard.
						// getFocusedComponent is on pi-tui's TUI class, not its TUI interface.
						const focused = (tui as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.();
						if (!tui || tui.hasOverlay() || !isEditor(focused)) {
							deselect();
							return undefined;
						}
						if (pillSelected) {
							if (matchesKey(data, "enter")) {
								deselect();
								void openDialog(ui, owner());
								return { consume: true };
							}
							if (matchesKey(data, "escape") || matchesKey(data, "up")) {
								deselect();
								return { consume: true };
							}
							if (matchesKey(data, "down")) return { consume: true };
							deselect();
							return undefined;
						}
						if (matchesKey(data, "down") && ui.getEditorText() === "" && tasksPillLabel(taskRows(owner()))) {
							pillSelected = true;
							refresh();
							return { consume: true };
						}
						return undefined;
					}),
				);
			}
			refresh();
		});

		// A message the user sends while the model's bash is running would otherwise wait for
		// the command to end; Claude Code moves the command to the background instead, so
		// the message reaches the model now and the command keeps running. Only the main
		// session's commands, and only ones old enough to be tasks.
		pi.on("input", (event, inputCtx) => {
			if (event.streamingBehavior && event.source !== "extension" && !backgroundTasksDisabled()) {
				detachAll("message", { owner: inputCtx.sessionManager.getSessionId() });
			}
			return { action: "continue" };
		});

		pi.on("session_shutdown", () => {
			for (const off of cleanups.splice(0)) off();
			clearTimeout(hintTimer);
			ctx = undefined;
			tui = undefined;
		});

		// Events land out of band, so each carries its own header. The header is
		// accent, event lines are plain, and the terminal line takes the colour of
		// the outcome: an exit is the one thing a monitor must never be silent about.
		pi.registerMessageRenderer<MonitorMessageDetails>(MONITOR_MESSAGE_TYPE, (message, { outputPad }, theme) => {
			const d = message.details;
			// Without details there is nothing to lay out; returning undefined leaves
			// pi to render the message's own content rather than an empty box.
			if (!d) return undefined;
			const lines: string[] = [theme.fg("accent", `monitor ${d.id}`) + theme.fg("dim", ` · ${d.description}`)];
			for (const line of d.lines) lines.push(clean(line));
			if (d.end) lines.push(theme.fg(d.status ?? "dim", d.end));
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(lines.join("\n"), 0, 0));
			return box;
		});

		// Claude Code draws a task notification as one line: a dot in the colour of its
		// status, then the summary.
		pi.registerMessageRenderer<TaskExitDetails>(TASK_EXIT_MESSAGE_TYPE, (message, _options, theme) => {
			const d = message.details;
			if (!d) return undefined;
			const color = NOTIFICATION_DOT_COLOR[d.state ?? ""];
			return block([`${color ? theme.fg(color, NOTIFICATION_DOT) : NOTIFICATION_DOT} ${clean(d.end)}`]);
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
					const kind = job.kind === "monitor" ? theme.fg("muted", "monitor") : theme.fg("dim", "job");
					const events =
						job.kind === "monitor" ? theme.fg("dim", ` · ${job.events} event${job.events === 1 ? "" : "s"}`) : "";
					lines.push(
						`  ${theme.fg("accent", job.id)} ${kind} ${job.running ? theme.fg("success", job.status) : theme.fg("dim", job.status)} ${theme.fg("dim", `${job.seconds}s`)}${events} ${job.command}`,
					);
				}
				lines.push("");
				lines.push(theme.fg("dim", "Read output: the output file · stop: task_stop. monitor starts a watch."));
			}
			return block(lines);
		});

		// Claude Code's /tasks (formerly /bashes).
		for (const name of ["tasks", "bashes"]) {
			pi.registerCommand(name, {
				description: name === "tasks" ? "View and manage everything running in the background" : "Alias for /tasks",
				handler: (_args, commandCtx) => showTasks(commandCtx),
			});
		}

		async function showTasks(commandCtx: ExtensionCommandContext): Promise<void> {
			if (commandCtx.hasUI) {
				await openDialog(commandCtx.ui, commandCtx.sessionManager.getSessionId());
				return;
			}
			const now = Date.now();
			const jobs: TaskSnapshot[] = backgroundBashJobs.list(commandCtx.sessionManager.getSessionId()).map((job) => ({
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
		}
	},
};

export default backgroundBash.factory;
