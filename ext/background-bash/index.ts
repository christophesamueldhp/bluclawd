import type {
	BashOperations,
	ExtensionCommandContext,
	ExtensionContext,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	matchesKey,
	rgbColor,
	styleText,
	styleTextWithAnsi,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { stripAnsi } from "../../daemon/ansi.ts";
import { currentDaemonBuildId, OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { runParent, Tmux, takeEndedAsQuit, underTmuxPrefix } from "../../daemon/tmux.ts";
import { processStart } from "../../daemon/wakeups.ts";
import { agentTasks, isAgentTaskId, isStillRunning, subscribeAgentTasks } from "../_shared/agent-tasks.ts";
import { commandBlock } from "../_shared/command-block.ts";
import { sharedRef } from "../_shared/global-state.ts";
import { toolOffNoticeOnce } from "../_shared/notice-once.ts";
import { startupSettings } from "../_shared/startup-settings.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { subagentPanelHasRows } from "../_shared/subagent-panel.ts";
import { timed } from "../_shared/timing.ts";
import { wrapExec } from "../sandbox/runtime.ts";
import { backgroundBashJobs, describeJobStatus, isShellTaskId, noTaskError, shellTaskStop } from "./background-bash.ts";
import { backgroundTasksDisabled } from "./bash-limits.ts";
import { createBackgroundBashTool } from "./bash-tool.ts";
import { detachAll, runningForegroundShells, subscribeForegroundShells } from "./foreground-shells.ts";
import { clearMainSession, mainSession, setMainSession } from "./main-session.ts";
import {
	EVENT_DELIVERY,
	MONITOR_MESSAGE_TYPE,
	type MonitorMessageDetails,
	TASK_EXIT_MESSAGE_TYPE,
	type TaskExitDetails,
} from "./monitor-events.ts";
import { monitorShellExec } from "./monitor-shell.ts";
import { createMonitorTool } from "./monitor-tool.ts";
import {
	deliverOrHold,
	heldNotifications,
	heldNotificationsLine,
	holdNotifications,
	subscribeNotificationHold,
} from "./notification-hold.ts";
import { findOrphanShells, orphanShellMessage, SHELL_END_ENTRY, SHELL_START_ENTRY } from "./orphan-shells.ts";
import { restoreModelBeforeWakeups } from "./session-model.ts";
import { type TaskRow, TasksDialog, taskRows } from "./tasks-dialog.ts";
import {
	isWakeupTaskId,
	WAKEUP_MESSAGE_TYPE,
	type WakeupMessageDetails,
	wakeupClock,
	wakeupLifecycle,
	wakeupScheduledText,
	wakeups,
	wakeupToolOffNotice,
} from "./wakeups.ts";

const MAX_COMMAND_CHARS = 80;

const stripTerminalControls = (s: string) => stripAnsi(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

const blankAsAbsent = (s: string | undefined) => s?.trim() || undefined;

const legacyShellId = (params: object) => (params as { shell_id?: string }).shell_id;

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

const NOTIFICATION_DOT = process.platform === "darwin" ? "⏺" : "●";
const NOTIFICATION_DOT_COLOR: Record<string, "success" | "error" | "warning" | undefined> = {
	completed: "success",
	failed: "error",
	killed: "warning",
};

const PILL = (text: string) => styleText(text, { fg: rgbColor(0, 204, 204) }, "truecolor");
const INVERSE = (text: string) => styleTextWithAnsi(text, undefined, undefined, { inverse: true });
const BACKGROUND_HINT_MS = 2000;

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

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

export function backgroundHint(): string {
	const key = underTmuxPrefix() ? "ctrl+b ctrl+b (twice)" : "ctrl+b";
	return `(${key} to run in background)`;
}

const isEditor = (component: unknown) => typeof (component as { getText?: unknown } | null)?.getText === "function";

/**
 * The main session's id, for handing its jobs to the next one on /clear. pi builds a
 * new instance of this extension per session, so it cannot live in the instance.
 */
const lastMainSession = sharedRef<string | undefined>("backgroundBash.lastMainSession", undefined);

let processStartedAt: number | undefined;
function thisProcessStart(): number | undefined {
	processStartedAt ??= processStart(process.pid);
	return processStartedAt;
}

/** Whether a SIGHUP or SIGTERM came. pi takes one for a quit, which ADR-0009 counts as a crash. */
const signals = sharedRef("backgroundBash.signals", { watching: false, received: false }).get();
function watchSignals(): void {
	if (signals.watching) return;
	signals.watching = true;
	for (const signal of ["SIGHUP", "SIGTERM"] as const) {
		const listener = () => {
			signals.received = true;
			// Alone, it would keep the process from ending on the signal, so it ends the process as the signal would have.
			if (process.listenerCount(signal) === 1) {
				process.off(signal, listener);
				process.kill(process.pid, signal);
			}
		};
		process.on(signal, listener);
	}
}

async function killedBySignal(): Promise<boolean> {
	await new Promise((resolve) => setImmediate(resolve));
	if (!signals.received) return false;
	const pane = Tmux.currentPane();
	return !(pane && takeEndedAsQuit(pane));
}

const backgroundBash: InlineExtension = {
	name: "background-bash",
	factory: (pi) => {
		let ctx: ExtensionContext | undefined;
		let tui: TUI | undefined;
		let pillSelected = false;
		let hintTimer: ReturnType<typeof setTimeout> | undefined;
		const cleanups: (() => void)[] = [];

		const owner = () => ctx?.sessionManager?.getSessionId();

		let shellPath: string | undefined;
		let commandPrefix: string | undefined;
		const operations: BashOperations = {
			exec: wrapExec(
				(command, cwd, options) => createLocalBashOperations({ shellPath }).exec(command, cwd, options),
				() => shellPath,
			),
		};
		const localCwd = process.cwd();

		pi.registerTool(
			createBackgroundBashTool({
				cwd: localCwd,
				operations,
				commandPrefix: () => commandPrefix,
				sendMessage: (message, delivery) => deliverOrHold(() => mainSession.sendMessage(message, delivery)),
				isMain: true,
				record: {
					start: (record) => mainSession.appendEntry(SHELL_START_ENTRY, record),
					end: (taskId) => mainSession.appendEntry(SHELL_END_ENTRY, { taskId }),
				},
			}),
		);

		pi.registerTool(
			createMonitorTool({
				sendMessage: (message, options) => deliverOrHold(() => mainSession.sendMessage(message, options)),
				cwd: localCwd,
				exec: wrapExec(
					monitorShellExec(() => shellPath),
					() => shellPath,
				),
				commandPrefix: () => commandPrefix,
			}),
		);

		const sessionWakeups = wakeupLifecycle({
			session: () => ctx,
			append: (customType, data) => pi.appendEntry(customType, data),
			send: (message) => pi.sendMessage(message, EVENT_DELIVERY),
			daemon: () => new OrchestratorClient(),
			buildId: currentDaemonBuildId,
			holder: () => {
				const startedAt = thisProcessStart();
				return startedAt === undefined ? undefined : { pid: process.pid, startedAt };
			},
			now: () => Date.now(),
			killedBySignal,
			log: (line) => {
				if (ctx?.hasUI) ctx.ui.notify(line, "warning");
				else console.error(line);
			},
		});

		if (!runParent()) {
			pi.on("agent_settled", sessionWakeups.settled);
			pi.on("session_tree", sessionWakeups.cancel);
			pi.registerTool({
				name: "schedule_wakeup",
				label: "ScheduleWakeup",
				defaultActive: false,
				description: [
					"- Schedules a turn of your own: once it is due, you get a notice with the prompt you give here and start a turn",
					"- Give exactly one of delay (seconds from now) or at (a local 24-hour clock time, HH:MM; its next occurrence)",
					"- It must fall due between 1 minute and 24 hours from now; one due while you are working waits for your next turn",
					"- Returns the wake-up's task id; cancel it with task_stop",
					"- One-shot: to check again later, schedule the next one when you wake",
					"- Use it to come back to something you are waiting on: CI, a deploy, a follow-up",
				].join("\n"),
				parameters: Type.Object({
					prompt: Type.String({ description: "What to do when it is due, written for yourself" }),
					delay: Type.Optional(Type.Number({ description: "Seconds from now, 60 to 86400" })),
					at: Type.Optional(Type.String({ description: "A local 24-hour clock time, HH:MM, e.g. 14:05" })),
				}),
				execute: async (_toolCallId, params) => {
					const wakeup = sessionWakeups.schedule(params);
					return { content: [{ type: "text", text: wakeupScheduledText(wakeup) }], details: undefined };
				},
			});
		}

		pi.registerTool({
			name: "task_stop",
			label: "TaskStop",
			description: [
				"- Stops a running background task by its ID",
				"- Takes a task_id parameter identifying the task to stop",
				"- Returns a success or failure status",
				"- Use this tool when you need to terminate a long-running task",
			].join("\n"),
			parameters: Type.Object({
				task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, toolCtx) => {
				const id = blankAsAbsent(params.task_id) ?? blankAsAbsent(legacyShellId(params)) ?? "";
				if (!id) throw new Error("Missing required parameter: task_id");
				const callerOwner = toolCtx?.sessionManager?.getSessionId();
				if (isAgentTaskId(id)) {
					const closed = agentTasks()?.closeOwned(id, { owner: callerOwner, source: "model" });
					if (closed?.ok === false && closed.reason === "not_running") {
						throw new Error(`Task ${id} is not running (status: ${closed.task.status})`);
					}
					if (!closed?.ok) throw noTaskError(id);
					const label = `${closed.task.agent}: ${closed.task.summary}`;
					const text = JSON.stringify({
						message: isStillRunning(closed.task.state)
							? `Stop requested for task: ${id} (${label}); it is ${closed.task.status}, not ended yet, and its session is kept`
							: `Successfully closed task: ${id} (${label}); its session is kept`,
						task_id: id,
						task_type: "local_agent",
						command: label,
					});
					return { content: [{ type: "text", text }], details: undefined };
				}
				if (isWakeupTaskId(id)) {
					const wakeup = wakeups.take(id, callerOwner);
					if (!wakeup) throw noTaskError(id);
					const text = JSON.stringify({
						message: `Successfully cancelled wake-up: ${id} (${wakeup.prompt})`,
						task_id: id,
						task_type: "wakeup",
					});
					return { content: [{ type: "text", text }], details: undefined };
				}
				if (!isShellTaskId(id)) throw noTaskError(id);
				const text = shellTaskStop(id, { owner: callerOwner });
				return { content: [{ type: "text", text }], details: undefined };
			},
		});

		const reportOrphanShells = (startCtx: ExtensionContext) => {
			const { orphans, live } = findOrphanShells(startCtx.sessionManager.getBranch(), (id) =>
				Boolean(backgroundBashJobs.get(id)),
			);
			const message = orphanShellMessage(orphans, live);
			if (!message) return;
			pi.sendMessage(message, { deliverAs: "steer", triggerTurn: false });
			for (const orphan of orphans) pi.appendEntry(SHELL_END_ENTRY, { taskId: orphan.taskId });
		};

		const refresh = () => {
			if (!ctx?.hasUI) return;
			const label = tasksPillLabel(taskRows(owner()));
			if (!label) pillSelected = false;
			const hint = pillSelected
				? "Enter to view tasks"
				: subagentPanelHasRows()
					? "/tasks to manage"
					: "↓ to manage";
			const pill = pillSelected ? INVERSE(PILL(label ?? "")) : PILL(label ?? "");
			ctx.ui.setStatus(STATUS_KEYS.tasks, label ? `${pill}${ctx.ui.theme.fg("dim", ` · ${hint}`)}` : undefined);
			tui?.requestRender();
		};

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
						rows: () => dialogTui.terminal.rows,
					},
				);
				const timer = setInterval(() => dialogTui.requestRender(), 1000);
				const offJobs = backgroundBashJobs.subscribe(() => dialogTui.requestRender());
				const offAgents = subscribeAgentTasks(() => dialogTui.requestRender());
				const offWakeups = wakeups.subscribe(() => dialogTui.requestRender());
				const offHeld = subscribeNotificationHold(() => dialogTui.requestRender());
				const offForeground = subscribeForegroundShells(() => dialogTui.requestRender());
				return Object.assign(dialog as Component, {
					dispose: () => {
						clearInterval(timer);
						offJobs();
						offAgents();
						offWakeups();
						offHeld();
						offForeground();
					},
				});
			});
		};

		const deselect = () => {
			if (!pillSelected) return;
			pillSelected = false;
			refresh();
		};

		pi.on("session_start", async (event, startCtx) => {
			await restoreModelBeforeWakeups(pi, startCtx);
			ctx = startCtx;
			setMainSession({
				sendMessage: (message, delivery) => pi.sendMessage(message, delivery),
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
			});
			try {
				const { settings } = startupSettings(event, startCtx);
				shellPath = settings.getShellPath();
				commandPrefix = settings.getShellCommandPrefix();
			} catch {
				shellPath = undefined;
				commandPrefix = undefined;
			}
			const session = startCtx.sessionManager.getSessionId();
			const previous = lastMainSession.get();
			if (event.reason === "new" && previous && previous !== session) backgroundBashJobs.reown(previous, session);
			lastMainSession.set(session);
			const stored = runParent() ? 0 : sessionWakeups.restore(event.reason);
			if (stored > 0 && !pi.getActiveTools().includes("schedule_wakeup")) {
				toolOffNoticeOnce(startCtx, getAgentDir(), "schedule-wakeup-tool-off", wakeupToolOffNotice(stored));
			}
			watchSignals();
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
						if (
							matchesKey(data, "down") &&
							ui.getEditorText() === "" &&
							!subagentPanelHasRows() &&
							tasksPillLabel(taskRows(owner()))
						) {
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

		pi.on("input", (event, inputCtx) => {
			if (event.streamingBehavior && event.source !== "extension" && !backgroundTasksDisabled()) {
				detachAll("message", { owner: inputCtx.sessionManager.getSessionId() });
			}
			return { action: "continue" };
		});

		pi.on("session_shutdown", async (event) => {
			await sessionWakeups.shutdown(event);
			clearMainSession();
			for (const off of cleanups.splice(0)) off();
			clearTimeout(hintTimer);
			ctx = undefined;
			tui = undefined;
		});

		pi.registerMessageRenderer<MonitorMessageDetails>(MONITOR_MESSAGE_TYPE, (message, { outputPad }, theme) => {
			const d = message.details;
			// Without details there is nothing to lay out; returning undefined leaves
			// pi to render the message's own content rather than an empty box.
			if (!d) return undefined;
			const lines: string[] = [theme.fg("accent", `monitor ${d.id}`) + theme.fg("dim", ` · ${d.description}`)];
			for (const line of d.lines) lines.push(stripTerminalControls(line));
			if (d.end) lines.push(theme.fg(d.status ?? "dim", d.end));
			const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
			box.addChild(new Text(lines.join("\n"), 0, 0));
			return box;
		});

		pi.registerMessageRenderer<TaskExitDetails>(TASK_EXIT_MESSAGE_TYPE, (message, _options, theme) => {
			const d = message.details;
			if (!d) return undefined;
			const color = NOTIFICATION_DOT_COLOR[d.state ?? ""];
			return commandBlock([
				`${color ? theme.fg(color, NOTIFICATION_DOT) : NOTIFICATION_DOT} ${stripTerminalControls(d.end)}`,
			]);
		});

		pi.registerMessageRenderer<WakeupMessageDetails>(WAKEUP_MESSAGE_TYPE, (message, _options, theme) => {
			const d = message.details;
			if (!d) return undefined;
			const prompt = d.prompt.split("\n").map((line) => `  ${theme.fg("dim", stripTerminalControls(line))}`);
			return commandBlock([
				`${theme.fg("accent", NOTIFICATION_DOT)} Wake-up due ${wakeupClock(d.dueAt)}`,
				...prompt,
			]);
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
			return commandBlock(lines);
		});

		pi.registerCommand("tasks", {
			description: "View and manage everything running in the background",
			handler: (_args, commandCtx) => showTasks(commandCtx),
		});

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

export default timed("background-bash", backgroundBash.factory);
