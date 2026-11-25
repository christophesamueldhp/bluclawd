import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import type { ExtensionCommandContext, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type Component,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
} from "@earendil-works/pi-tui";
import type { PaneHeartbeat, PaneMessage } from "../../daemon/ipc/protocol.ts";
import { type InstanceSummary, OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { labelFromTask, otherRows } from "../../daemon/rows.ts";
import { toolActivity } from "../../daemon/session-state.ts";
import {
	AGENT_VIEW_COMMAND,
	FOREGROUND_PANE_ENV,
	HIDDEN_ROW_ENV,
	OPEN_VIEW_ENV,
	outerTmuxEnv,
	RUN_PANE_ENV,
	runParent,
	Tmux,
} from "../../daemon/tmux.ts";
import { agentTasks, isStillRunning, subscribeAgentTasks } from "../_shared/agent-tasks.ts";
import { BUILTIN_SLASH_COMMANDS } from "../_shared/builtin-commands.ts";
import { holdTui } from "../_shared/hold-tui.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { setSharedTheme, theme } from "../_shared/theme.ts";
import { timed, timedCall } from "../_shared/timing.ts";
import { trustBadge } from "../_shared/trust-badge.ts";
import { wakeups } from "../background-bash/wakeups.ts";
import { AgentView, EXIT_WORDS, type PastSession } from "./agent-view.ts";
import { type BackgroundableSession, spawnDetachedRowSaver } from "./hand-off.ts";
import { loadViewMode, saveViewModeIfWritable } from "./prefs.ts";
import {
	dialogDetail,
	ForegroundActivity,
	SelfRegistration,
	SessionDigest,
	waitingDetail,
} from "./self-registration.ts";

const FULL_SCREEN = { width: "100%", maxHeight: "100%" } as const;

const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const PILL_POLL_MS = 10_000;
const DONE_FLASH_MS = 2500;
const LEFT_ARM_MS = 3000;
const LEFT_EDIT_MS = 2000;
const EXIT_PRESS_MS = 500;
const VIEW_READY_POLLS = 100;
const PRELOAD_MS = 250;
const STATUS_KEY = STATUS_KEYS.agents;
const NEEDS_TMUX = "Agent view needs tmux — install it (brew install tmux) and start pi again";
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([AGENT_VIEW_COMMAND]);

export function withoutAgentViewCommand(current: AutocompleteProvider): AutocompleteProvider {
	return {
		...current,
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
		applyCompletion: current.applyCompletion.bind(current),
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!base) return base;
			const items = base.items.filter((item) => !HIDDEN_COMMANDS.has(item.value));
			return items.length > 0 ? { ...base, items } : null;
		},
	};
}

export function isQuitAlias(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/exit" || EXIT_WORDS.has(trimmed);
}

export type ExitAction = "stopTurn" | "armSecondPress" | "endSession" | "detach" | "passToPi";

export function exitAction(
	key: "ctrl+c" | "ctrl+d" | "exit",
	state: { normal: boolean; idle: boolean; empty: boolean; sincePrevious: number },
): ExitAction {
	const leave = state.normal ? "endSession" : "detach";
	if (key === "exit") return leave;
	if (key === "ctrl+c") {
		if (!state.idle) return "stopTurn";
		return state.sincePrevious < EXIT_PRESS_MS ? leave : "armSecondPress";
	}
	if (!state.empty) return "passToPi";
	if (!state.normal) return "detach";
	return state.sincePrevious < EXIT_PRESS_MS ? "endSession" : "armSecondPress";
}

export function leaveViewAction(state: {
	startedHere: boolean;
	idle: boolean;
	blank: boolean;
}): "quit" | "kill" | "detach" {
	if (state.blank) return "kill";
	return state.startedHere && state.idle ? "quit" : "detach";
}

/**
 * How another window's prompt reaches this pi: queued behind a turn in progress, and a slash
 * command run as if typed here (an extension command, a skill, a prompt template). Not with
 * images, because pi runs an extension command with its text alone, and the images would be lost. Always
 * with a delivery mode, which pi uses only while it streams. A turn may start after the pane looked
 * and before pi does, and pi throws on a prompt with none then.
 */
export function promptOptions(message: { text: string; images?: unknown[] }): {
	deliverAs: "followUp";
	expandPromptTemplates?: true;
} {
	return {
		deliverAs: "followUp",
		...(!message.images?.length && message.text.startsWith("/") ? { expandPromptTemplates: true as const } : {}),
	};
}

/**
 * Another window's prompt as pi takes it. An image gets an `[Image #N]` line under the text, as a
 * paste in the editor does, since pi's chat shows a message's text and not its images.
 */
export function promptContent(message: { text: string; images?: Array<{ mimeType: string; data: string }> }) {
	if (!message.images?.length) return message.text;
	const marks = message.images.map((_, i) => `[Image #${i + 1}]`).join("\n");
	return [
		{ type: "text" as const, text: `${message.text}\n\n${marks}` },
		...message.images.map((image) => ({ type: "image" as const, ...image })),
	];
}

export function isBlankPane(
	pane: string | undefined,
	header: { parentSession?: string } | null,
	messaged: boolean,
): boolean {
	return !!pane && !header?.parentSession && !messaged;
}

export function shutdownPlan(
	event: { reason: string; targetSessionFile?: string },
	currentFile: string | undefined,
): { await: boolean; unregister: boolean } {
	if (event.reason === "quit") return { await: false, unregister: true };
	const carriesOn =
		event.reason === "reload" ||
		event.reason === "new" ||
		(event.reason === "resume" && event.targetSessionFile === currentFile);
	return { await: true, unregister: !carriesOn };
}

function leafIdIfMovedOffLastEntry(leafId: string | undefined, lastEntryId: string | undefined): string | undefined {
	return leafId !== lastEntryId ? leafId : undefined;
}

function endOnDetachUnlessTmuxGone(panes: Tmux, pane: string, want: boolean): boolean {
	try {
		panes.endOnDetach(pane, want);
		return true;
	} catch {
		return false;
	}
}

function markOpenedFromViewQuietly(panes: Tmux, name: string): void {
	try {
		panes.setOpenedFromView(name, true);
	} catch {}
}

function markViewReadyQuietly(panes: Tmux, pane: string): void {
	try {
		panes.markViewReady(pane);
	} catch {}
}

function isRealCwd(cwd: string): boolean {
	return existsSync(cwd) && !TMP_ROOTS.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

async function loadPastSessions(cwd: string): Promise<PastSession[]> {
	const infos = await SessionManager.list(cwd);
	return infos
		.filter((info) => info.messageCount > 0 && isRealCwd(info.cwd || cwd))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, 50)
		.map((info) => ({
			sessionFile: info.path,
			cwd: info.cwd || cwd,
			label: info.name || labelFromTask(info.firstMessage),
			modifiedAt: info.modified.toISOString(),
		}));
}

const agentView: InlineExtension = {
	name: "agent-view",
	factory: (pi) => {
		let registration: SelfRegistration | undefined;
		let activity = new ForegroundActivity();
		let offSubagents: (() => void) | undefined;
		let stopPill: (() => void) | undefined;
		let viewOpen = false;
		let leftHint: string | undefined;
		let paintPill: (() => void) | undefined;
		let autocompleteAdded = false;
		const pane = Tmux.currentPane();
		const panes = new Tmux();
		const parent = runParent;
		const backToView = (): boolean => {
			try {
				return !!pane && panes.openedFromView(pane);
			} catch {
				return false;
			}
		};
		const backTo = (): string | undefined => {
			const orchestrator = parent();
			if (!orchestrator || backToView()) return undefined;
			try {
				return panes.hasSession(orchestrator) ? orchestrator : undefined;
			} catch {
				return orchestrator;
			}
		};
		let launched = false;
		let liveDetail: string | undefined;

		const digest = new SessionDigest();

		const blank = (ctx: ExtensionContext): boolean =>
			isBlankPane(pane, ctx.sessionManager.getHeader(), digest.read(ctx.sessionManager).asked);
		let normal = false;
		let startedHere = false;
		let endsOnDetach = false;
		const syncEndOnDetach = (ctx: ExtensionContext): void => {
			const want = !!pane && (normal || blank(ctx));
			if (!pane || want === endsOnDetach) return;
			if (endOnDetachUnlessTmuxGone(panes, pane, want)) endsOnDetach = want;
		};
		let viewHost = false;
		let hide: string | undefined;
		const hosting = (ctx: ExtensionContext): boolean => viewHost && blank(ctx);
		const leavePane = (ending: boolean): void => {
			if (ending && pane) panes.killWithoutSave(pane);
			else panes.detach();
		};

		const selfLabel = (ctx: ExtensionContext): string | undefined => {
			const { name, firstPrompt } = digest.read(ctx.sessionManager);
			return name?.trim() || (firstPrompt ? labelFromTask(firstPrompt) : undefined);
		};

		const selfHeartbeat = (ctx: ExtensionContext): PaneHeartbeat => {
			const session = digest.read(ctx.sessionManager);
			return {
				cwd: ctx.sessionManager.getCwd(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				label: selfLabel(ctx),
				pane,
				detail:
					dialogDetail(activity) ??
					waitingDetail(activity) ??
					(activity.current === "working" && liveDetail ? liveDetail : session.lastAnswer),
				turns: session.answered ? 1 : 0,
				createdAt: ctx.sessionManager.getHeader()?.timestamp,
				finishedAt: session.lastEntry?.timestamp,
				turnStartedAt: session.turnStartedAt,
				leafId: leafIdIfMovedOffLastEntry(ctx.sessionManager.getLeafId() ?? undefined, session.lastEntry?.id),
				dialog: activity.current === "awaiting_input" ? activity.dialog : undefined,
				wakesAt: wakeups.list(ctx.sessionManager.getSessionId())[0]?.dueAt,
				...(ctx.ui.getEditorText().trim() !== "" ? { draft: true } : {}),
				...(parent() ? { parent: parent() } : {}),
			};
		};

		const selfRow = (ctx: ExtensionContext): InstanceSummary => ({
			...selfHeartbeat(ctx),
			id: registration?.id ?? `self:${ctx.sessionManager.getSessionId()}`,
			status: "online",
			activity: activity.current,
			external: true,
		});

		const captureOutgoing = (ctx: ExtensionContext): BackgroundableSession | undefined => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile)) return undefined;
			return {
				cwd: ctx.sessionManager.getCwd(),
				label: ctx.sessionManager.getSessionName() ?? selfLabel(ctx),
				sessionFile,
				sessionId: ctx.sessionManager.getSessionId(),
				...(parent() ? { parent: parent() } : {}),
			};
		};

		const onPaneMessage = (ctx: ExtensionContext, message: PaneMessage): void => {
			if (message.type === "prompt" && !message.id)
				pi.sendUserMessage(promptContent(message), promptOptions(message));
			else if (message.type === "abort") ctx.abort();
			else if (message.type === "rename") pi.setSessionName(message.name);
			else if (message.type === "session_message") pi.events.emit("bluclawd:session-message", message);
			else pi.events.emit("bluclawd:pane-message", message);
		};

		const startPill = (ctx: ExtensionContext, pane: string): (() => void) => {
			const client = new OrchestratorClient();
			let finished: Set<string> | undefined;
			let flashUntil = 0;
			let flashCount = 0;
			let flashTimer: ReturnType<typeof setTimeout> | undefined;
			let stopped = false;
			let parentLabel = parent();
			const runHint = (): string => theme.fg("dim", `← subagent of ${parentLabel}`);
			const labelFromDaemon = async (orchestrator: string): Promise<string | undefined> => {
				try {
					return (await client.list()).find((r) => r.pane === orchestrator)?.label;
				} catch {
					return undefined;
				}
			};
			const pillFromDaemonOr = async (plain: string): Promise<string> => {
				try {
					const rows = otherRows(await client.list(), pane);
					const waiting = rows.filter((r) => r.state === "needs").length;
					const done = new Set(rows.filter((r) => r.state === "done" || r.state === "failed").map((r) => r.id));
					const fresh = finished ? [...done].filter((id) => !finished?.has(id)).length : 0;
					finished = done;
					if (fresh > 0) {
						flashCount = fresh;
						flashUntil = Date.now() + DONE_FLASH_MS;
						clearTimeout(flashTimer);
						flashTimer = setTimeout(() => void tick(), DONE_FLASH_MS);
					}
					if (waiting > 0) {
						const n = waiting > 99 ? "99+" : String(waiting);
						return `${theme.fg("dim", "← ")}${theme.fg("warning", n)}${theme.fg("dim", ` agent${waiting === 1 ? "" : "s"}`)}`;
					}
					if (Date.now() < flashUntil) {
						return `${theme.fg("dim", "← ")}${theme.fg("success", String(flashCount))}${theme.fg("dim", " done")}`;
					}
				} catch {}
				return plain;
			};
			let last = parent() ? runHint() : theme.fg("dim", "← for agents");
			const paint = (): void => {
				if (!stopped) ctx.ui.setStatus(STATUS_KEY, leftHint ?? last);
			};
			paintPill = paint;
			const tick = async (): Promise<void> => {
				const orchestrator = parent();
				if (orchestrator) {
					parentLabel = (await labelFromDaemon(orchestrator)) ?? parentLabel;
					last = runHint();
					paint();
					return;
				}
				last = await pillFromDaemonOr(theme.fg("dim", "← for agents"));
				paint();
			};
			void tick();
			const timer = setInterval(() => void tick(), PILL_POLL_MS);
			return () => {
				stopped = true;
				clearInterval(timer);
				clearTimeout(flashTimer);
				paintPill = undefined;
				ctx.ui.setStatus(STATUS_KEY, undefined);
			};
		};

		pi.on("session_start", (event, ctx) => {
			setSharedTheme(ctx.ui.theme);
			if (ctx.mode !== "tui") return;
			if (!pane) {
				if (launched) return;
				launched = true;
				if (!Tmux.available()) ctx.ui.notify(NEEDS_TMUX, "warning");
				return;
			}
			registration?.stop();
			if (process.env[OPEN_VIEW_ENV]) viewHost = true;
			delete process.env[OPEN_VIEW_ENV];
			hide ??= process.env[HIDDEN_ROW_ENV];
			delete process.env[HIDDEN_ROW_ENV];
			activity = new ForegroundActivity();
			const subagentsChanged = () => {
				const line = waitingDetail(activity);
				const running = (agentTasks()?.list() ?? []).filter((task) => isStillRunning(task.state)).length;
				registration?.setActivity(activity.setWaitingOn(running));
				if (waitingDetail(activity) !== line) void registration?.refresh();
			};
			if (!process.env[RUN_PANE_ENV]) {
				const waitsForFirstPrompt = (): boolean => blank(ctx) && !parent() && event.reason !== "new";
				registration = new SelfRegistration(
					new OrchestratorClient(),
					() =>
						timedCall("agent-view", "heartbeat", () => (waitsForFirstPrompt() ? undefined : selfHeartbeat(ctx))),
					(message) => onPaneMessage(ctx, message),
					pane,
					(watched) => pi.events.emit("bluclawd:remote-watched", watched),
					() => pi.events.emit("bluclawd:remote-want-report", true),
					() => pi.events.emit("bluclawd:daemon-reconnected", true),
				);
				registration.start();
			}
			offSubagents?.();
			offSubagents = subscribeAgentTasks(subagentsChanged);
			subagentsChanged();
			if (process.env[FOREGROUND_PANE_ENV]) normal = startedHere = true;
			delete process.env[FOREGROUND_PANE_ENV];
			syncEndOnDetach(ctx);
			stopPill?.();
			const offPill = startPill(ctx, pane);
			if (!autocompleteAdded) {
				autocompleteAdded = true;
				ctx.ui.addAutocompleteProvider(withoutAgentViewCommand);
			}
			// Hold the TUI. onTerminalInput sees keys before any dialog does, so ← must check that the main
			// editor has the keyboard.
			const tui = holdTui(ctx, "agent-view:tui");
			let armedAt = 0;
			let editedAt = 0;
			const pressedAt = { "ctrl+c": 0, "ctrl+d": 0 };
			let exitHintAt = 0;
			const exitHint = (text: string): void => {
				const at = Date.now();
				exitHintAt = at;
				leftHint = theme.fg("dim", text);
				paintPill?.();
				setTimeout(() => {
					if (exitHintAt !== at) return;
					exitHintAt = 0;
					leftHint = undefined;
					paintPill?.();
				}, EXIT_PRESS_MS * 3);
			};
			const act = (action: ExitAction, key: "ctrl+c" | "ctrl+d" | "exit"): { consume: true } | undefined => {
				switch (action) {
					case "stopTurn":
						pressedAt["ctrl+c"] = 0;
						ctx.abort();
						return { consume: true };
					case "armSecondPress":
						pressedAt[key as "ctrl+c" | "ctrl+d"] = Date.now();
						exitHint(
							`Press ${key === "ctrl+c" ? "Ctrl-C" : "Ctrl-D"} again to exit${normal ? "" : " · this session keeps running"}`,
						);
						// pi clears the editor on ctrl+c; its own second press never comes.
						return key === "ctrl+c" ? undefined : { consume: true };
					case "endSession":
						ctx.shutdown();
						return { consume: true };
					case "detach":
						if (key === "exit") ctx.ui.setEditorText("");
						leavePane(blank(ctx));
						return { consume: true };
					case "passToPi":
						return undefined;
				}
			};
			const disarm = (): void => {
				if (!armedAt) return;
				armedAt = 0;
				leftHint = undefined;
				paintPill?.();
			};
			const editorFocused = (): boolean => {
				// getFocusedComponent is on pi-tui's TUI class, not its TUI interface.
				const focused = (tui() as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.();
				return typeof (focused as { getText?: unknown } | null)?.getText === "function";
			};
			const offKey = ctx.ui.onTerminalInput((data) => {
				// Kitty reports a release (and a held key) as separate events; only presses count.
				if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
				if (!viewOpen && !tui()?.hasOverlay()) {
					for (const key of ["ctrl+c", "ctrl+d"] as const) {
						if (!matchesKey(data, key)) continue;
						const state = {
							normal,
							idle: ctx.isIdle(),
							empty: ctx.ui.getEditorText() === "",
							sincePrevious: Date.now() - pressedAt[key],
						};
						return act(exitAction(key, state), key);
					}
				}
				if (!viewOpen && matchesKey(data, "enter") && isQuitAlias(ctx.ui.getEditorText()) && editorFocused()) {
					const action = exitAction("exit", { normal, idle: true, empty: false, sincePrevious: 0 });
					if (action === "endSession") ctx.ui.setEditorText("/quit");
					else return act(action, "exit");
				}
				if (
					ctx.ui.getEditorText() !== "" ||
					matchesKey(data, "backspace") ||
					matchesKey(data, "up") ||
					matchesKey(data, "down")
				)
					editedAt = Date.now();
				if (viewOpen || !matchesKey(data, "left") || ctx.ui.getEditorText() !== "") {
					disarm();
					return undefined;
				}
				if (!tui() || tui()?.hasOverlay() || !editorFocused()) {
					disarm();
					return undefined;
				}
				if (Date.now() - editedAt >= LEFT_EDIT_MS || (armedAt && Date.now() - armedAt < LEFT_ARM_MS)) {
					disarm();
					const orchestrator = backTo();
					if (!orchestrator) pi.sendUserMessage(`/${AGENT_VIEW_COMMAND}`, { expandPromptTemplates: true });
					else {
						try {
							panes.switchTo(orchestrator);
						} catch (error) {
							ctx.ui.notify(`Could not go back to the orchestrator: ${Tmux.reason(error)}`, "warning");
						}
					}
					return { consume: true };
				}
				const at = Date.now();
				armedAt = at;
				leftHint = theme.fg("dim", backTo() ? "Press ← again to go back" : "Press ← again to open agents");
				paintPill?.();
				setTimeout(() => {
					if (armedAt === at) disarm();
				}, LEFT_ARM_MS);
				return { consume: true };
			});
			stopPill = () => {
				offPill();
				offKey();
				ctx.ui.setWidget("agent-view:tui", undefined);
			};
		});

		const track = (event: { type: string; kind?: string; title?: string }): void => {
			const current = activity.apply(event);
			registration?.setActivity(current);
		};
		pi.on("agent_start", (event, ctx) => {
			syncEndOnDetach(ctx);
			track(event);
		});
		pi.on("turn_start", track);
		pi.on("message_start", (event) => {
			if (event.message.role === "assistant") registration?.ensureListed();
		});
		pi.on("agent_settled", (event) => {
			liveDetail = undefined;
			track(event);
		});
		pi.on("tool_execution_start", (event) => {
			liveDetail = toolActivity(event.toolName, event.args);
		});
		pi.on("ui_prompt_start", track);
		pi.on("ui_prompt_end", track);
		pi.on("session_shutdown", async (event, ctx) => {
			const plan = shutdownPlan(event, ctx.sessionManager.getSessionFile());
			const stopping = registration?.stop({ unregister: plan.unregister, reason: event.reason });
			if (plan.await) await stopping;
			registration = undefined;
			stopPill?.();
			offSubagents?.();
			offSubagents = undefined;
			stopPill = undefined;
			if (event.reason !== "quit" || ctx.mode !== "tui" || !pane) return;
			const outgoing = captureOutgoing(ctx);
			if (outgoing) spawnDetachedRowSaver(outgoing);
		});

		const openAgentView = async (ctx: ExtensionCommandContext): Promise<void> => {
			if (!pane) {
				ctx.ui.notify(NEEDS_TMUX, "warning");
				return;
			}
			if (viewOpen) return;
			viewOpen = true;
			normal = false;
			syncEndOnDetach(ctx);
			const model = ctx.model;
			const trust = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: false }).getDefaultProjectTrust();
			const sessionTitle = (): string => {
				const name = ctx.sessionManager.getSessionName();
				const dir = basename(ctx.sessionManager.getCwd());
				return name ? `π - ${name} - ${dir}` : `π - ${dir}`;
			};
			try {
				const client = new OrchestratorClient();
				const instances = await Promise.race([
					client.list().catch(() => undefined),
					new Promise<undefined>((resolve) => setTimeout(resolve, PRELOAD_MS)),
				]);
				await ctx.ui.custom<void>(
					(tui, _theme, keybindings, done) => {
						const view = AgentView.show({
							ui: tui,
							keybindings,
							client,
							appName: "bluclawd",
							version: VERSION,
							model: model ? { provider: model.provider, id: model.id } : undefined,
							modelName: model?.name,
							mode: trust === "ask" ? undefined : trustBadge(theme, trust),
							cwd: ctx.cwd,
							home: process.env.HOME ?? "",
							self: () => (hosting(ctx) ? undefined : selfRow(ctx)),
							onClose: () => done(undefined),
							panes: {
								current: pane,
								switchTo: (name) => {
									const ending = blank(ctx);
									markOpenedFromViewQuietly(panes, name);
									panes.switchTo(name);
									if (ending) panes.killWithoutSave(pane);
								},
								start: (cwd, args, env) => panes.newSession({ cwd, args, env: { ...outerTmuxEnv(), ...env } }),
								waitForView: async (name) => {
									for (let i = 0; i < VIEW_READY_POLLS && !panes.viewReady(name); i++) {
										await new Promise((resolve) => setTimeout(resolve, 50));
									}
								},
								end: (name) => panes.hangUpAsQuit(name),
								kill: (name) => panes.killWithoutSave(name),
								unlist: async () => {
									await registration?.stop();
									registration = undefined;
								},
								detach: () => {
									const action = leaveViewAction({ startedHere, idle: ctx.isIdle(), blank: blank(ctx) });
									if (action === "quit") ctx.shutdown();
									else leavePane(action === "kill");
								},
								startShell: (cwd, command) => panes.startShell(cwd, command),
								listShells: () => panes.listShells(),
								listShellsAsync: () => panes.listShellsAsync(),
								stopShell: (name) => panes.stopShell(name),
								captureAsync: (name, lines) => panes.captureAsync(name, lines),
							},
							listModels: () =>
								ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id })),
							isKnownCommand: (name) =>
								BUILTIN_SLASH_COMMANDS.some((c) => c.name === name) ||
								pi.getCommands().some((c) => c.name === name && c.source === "extension"),
							onSelfReply: (text) =>
								pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" }),
							onStopSelf: () => ctx.abort(),
							onRenameSelf: (name) => pi.setSessionName(name),
							externalEditor: () =>
								SettingsManager.create(ctx.cwd, undefined, {
									projectTrusted: ctx.isProjectTrusted(),
								}).getExternalEditorCommand(),
							loadPastSessions,
							loadViewMode: () => loadViewMode(getAgentDir()),
							saveViewMode: (mode) => saveViewModeIfWritable(getAgentDir(), mode),
							setTitle: (title) => ctx.ui.setTitle(title ?? sessionTitle()),
							hide,
							instances,
							onDrawn: viewHost ? () => markViewReadyQuietly(panes, pane) : undefined,
						});
						return view as Component & { dispose?(): void };
					},
					{ overlay: true, overlayOptions: FULL_SCREEN },
				);
			} finally {
				viewOpen = false;
			}
		};

		pi.registerCommand(AGENT_VIEW_COMMAND, {
			description: "Agent view (press ← on an empty prompt)",
			handler: async (_args, ctx) => openAgentView(ctx),
		});
	},
};

export default timed("agent-view", agentView.factory);
