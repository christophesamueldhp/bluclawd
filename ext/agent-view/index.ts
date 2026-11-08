/**
 * Agent view (← on an empty prompt).
 *
 * It needs tmux: every session is a pi of its own in a private tmux server (tmux.ts), and `pi` run
 * in a terminal starts its session there and attaches. Without tmux, agent view stays off.
 */

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
import { AGENT_VIEW_COMMAND, HIDE_ENV, NORMAL_ENV, OPEN_VIEW_ENV, PARENT_ENV, Tmux } from "../../daemon/tmux.ts";
import { agentTasks, subscribeAgentTasks } from "../_shared/agent-tasks.ts";
import { BUILTIN_SLASH_COMMANDS } from "../_shared/builtin-commands.ts";
import { holdTui } from "../_shared/hold-tui.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { setSharedTheme, theme } from "../_shared/theme.ts";
import { timed, timedCall } from "../_shared/timing.ts";
import { trustBadge } from "../_shared/trust-badge.ts";
import { AgentView, EXIT_WORDS, type PastSession } from "./agent-view.ts";
import { type BackgroundableSession, handOffAfterExit } from "./hand-off.ts";
import { loadViewMode, saveViewMode } from "./prefs.ts";
import {
	dialogDetail,
	ForegroundActivity,
	SelfRegistration,
	SessionDigest,
	waitingDetail,
} from "./self-registration.ts";

/** At anything less than the whole terminal, the conversation behind shows through the margins. */
const FULL_SCREEN = { width: "100%", maxHeight: "100%" } as const;

const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const PILL_POLL_MS = 10_000;
const DONE_FLASH_MS = 2500;
/** How long the first ← waits for the second. */
const LEFT_ARM_MS = 3000;
/** An edit this recent makes the first ← arm instead of opening. */
const LEFT_EDIT_MS = 2000;
/** A second ctrl+c or ctrl+d this soon after the first exits (pi's own window for ctrl+c). */
const EXIT_PRESS_MS = 500;
/** How many times (50ms apart) deleting this terminal's session waits for the pane it moves to. */
const VIEW_READY_POLLS = 100;
/** How long ← waits on the roster before opening agent view without it. */
const PRELOAD_MS = 250;
const STATUS_KEY = STATUS_KEYS.agents;
const NEEDS_TMUX = "Agent view needs tmux — install it (brew install tmux) and start pi again";
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([AGENT_VIEW_COMMAND]);

/** Autocomplete without the agent view commands. */
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

/** An exit word or /exit alone at the prompt: bluclawd runs /exit for it, which is pi's /quit. */
export function isQuitAlias(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/exit" || EXIT_WORDS.has(trimmed);
}

/** What an exit key or word does. */
export type ExitAction =
	/** Stop the turn in progress. */
	| "abort"
	/** The first of a double press: arm it (ctrl+c also reaches pi, which clears the editor). */
	| "first"
	/** End the session; a turn in progress dies with it. */
	| "quit"
	/** Leave tmux; the session keeps running. */
	| "detach"
	/** Not an exit: pi's own key (ctrl+d with text deletes forward). */
	| "pass";

/**
 * The exit keys. A normal session (the one `pi` started in this terminal) ends on
 * ctrl+c twice, ctrl+d twice, an exit word or /exit; a background session detaches on the same,
 * except that one ctrl+d detaches it. Ctrl+c while a turn runs stops the turn.
 */
export function exitAction(
	key: "ctrl+c" | "ctrl+d" | "exit",
	state: { normal: boolean; idle: boolean; empty: boolean; sincePrevious: number },
): ExitAction {
	const leave = state.normal ? "quit" : "detach";
	if (key === "exit") return leave;
	if (key === "ctrl+c") {
		if (!state.idle) return "abort";
		return state.sincePrevious < EXIT_PRESS_MS ? leave : "first";
	}
	if (!state.empty) return "pass";
	if (!state.normal) return "detach";
	return state.sincePrevious < EXIT_PRESS_MS ? "quit" : "first";
}

/**
 * What leaving pi from agent view does to this pane: the session `pi` started in this terminal
 * ends with it while idle, as if quit from its own prompt; mid-turn it runs on in the background, as
 * every other session does. A blank pane, with nothing to keep, ends.
 */
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
 * images: pi runs an extension command with its text alone, and the images would be lost. Always
 * with a delivery mode, which pi uses only while it streams: a turn may start after the pane looked
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
 * Another window's prompt as pi takes it: an image gets an `[Image #N]` line under the text, as a
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

/**
 * A pane nothing has been asked in yet is not a session, as a bluclawd session isn't one until
 * it runs: no other window lists it, and it ends when the terminal leaves it. A fork is one from
 * the start, even of the conversation before its first message, which pi writes no file for yet:
 * it is listed as a row of its own beside the one it was forked from.
 */
export function isBlankPane(
	pane: string | undefined,
	sessions: Pick<ExtensionContext["sessionManager"], "getEntries" | "getHeader">,
): boolean {
	return !!pane && !sessions.getHeader()?.parentSession && !sessions.getEntries().some((e) => e.type === "message");
}

/**
 * What `session_shutdown` does with this pane's registration. A reload, a new session, or resume of
 * the same file goes on in this pane, whose next session registers under the same id: its row (pin,
 * order) and the messages queued for it stay. Resuming another session or a fork leaves this one
 * stopped, and the next one gets its own row. pi awaits the handler, so the stop is awaited
 * where a session follows, and no late heartbeat of this one lands after the next one's.
 */
export function shutdownPlan(
	event: { reason: string; targetSessionFile?: string },
	currentFile: string | undefined,
): { await: boolean; unregister: boolean } {
	if (event.reason === "quit") return { await: false, unregister: true };
	// A new session carries the row on, as /clear does in Claude Code: the old one stays on disk only.
	const carriesOn =
		event.reason === "reload" ||
		event.reason === "new" ||
		(event.reason === "resume" && event.targetSessionFile === currentFile);
	return { await: true, unregister: !carriesOn };
}

function isRealCwd(cwd: string): boolean {
	return existsSync(cwd) && !TMP_ROOTS.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

/** `/resume`: this repository's past sessions, newest first. */
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
		// What this window is doing: its own agent-view row, and what other windows see.
		let activity = new ForegroundActivity();
		let offSubagents: (() => void) | undefined;
		let stopPill: (() => void) | undefined;
		let viewOpen = false;
		// The first ← swaps the footer pill for this hint; the second opens agent view.
		let leftHint: string | undefined;
		let paintPill: (() => void) | undefined;
		let autocompleteAdded = false;
		// Pane mode: this pi runs in a tmux session of agent view's own (tmux.ts).
		const pane = Tmux.currentPane();
		const panes = new Tmux();
		// A run's orchestrator (ADR-0006): ← goes back to it, or to agent view when the run was opened there.
		const parent = process.env[PARENT_ENV] || undefined;
		const backToView = (): boolean => {
			try {
				return !!pane && panes.openedFromView(pane);
			} catch {
				return false;
			}
		};
		let launched = false;
		// What the turn in progress is doing, for this session's row in other windows.
		let liveDetail: string | undefined;

		const blank = (ctx: ExtensionContext): boolean => isBlankPane(pane, ctx.sessionManager);
		// A normal session, as bluclawd's: the pane `pi` started in this terminal, until ← opens
		// agent view. Quitting ends it, and so does closing its terminal.
		let normal = false;
		// The pane `pi` started in this terminal, which stays so once ← moved it to the background.
		let startedHere = false;
		// Set while tmux ends this pane when its terminal detaches or closes: a blank pane, or a
		// normal session.
		let endsOnDetach = false;
		const syncEndOnDetach = (ctx: ExtensionContext): void => {
			const want = !!pane && (normal || blank(ctx));
			if (!pane || want === endsOnDetach) return;
			try {
				panes.endOnDetach(pane, want);
				endsOnDetach = want;
			} catch {
				// tmux is gone with it; quitting ends it all the same
			}
		};
		// Set on a pane started only to show agent view, after this terminal's session was deleted.
		let viewHost = false;
		// The row of the session whose deletion started this pane, until that row is gone.
		let hide: string | undefined;
		// Agent view there has no session of this terminal's, as bluclawd's once its origin is
		// deleted: no own row, and esc quits.
		const hosting = (ctx: ExtensionContext): boolean => viewHost && blank(ctx);
		/** Leave this pane: tmux keeps a session running; one with nothing in it ends. */
		const leavePane = (ending: boolean): void => {
			if (ending && pane) panes.kill(pane);
			else panes.detach();
		};

		// A heartbeat every few seconds reads the session again only once it has changed.
		const digest = new SessionDigest();

		/** This window's session's name, else the first words of its first prompt. */
		const selfLabel = (ctx: ExtensionContext): string | undefined => {
			const { name, firstPrompt } = digest.read(ctx.sessionManager);
			return name?.trim() || (firstPrompt ? labelFromTask(firstPrompt) : undefined);
		};

		/** What this window's session is, as its heartbeat says and its own row shows. */
		const selfHeartbeat = (ctx: ExtensionContext): PaneHeartbeat => {
			const session = digest.read(ctx.sessionManager);
			const leafId = ctx.sessionManager.getLeafId() ?? undefined;
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
				// Its last entry's: once idle, when its last turn ended. Every heartbeat restates its lastSeenAt.
				finishedAt: session.lastEntry?.timestamp,
				// The active branch's, as a Chat times it: after a /tree, not a prompt on the branch left.
				turnStartedAt: session.turnStartedAt,
				// Only once it differs: a heartbeat lags the file, whose last entry is otherwise the leaf.
				leafId: leafId !== session.lastEntry?.id ? leafId : undefined,
				dialog: activity.current === "awaiting_input" ? activity.dialog : undefined,
				...(ctx.ui.getEditorText().trim() !== "" ? { draft: true } : {}),
				...(parent ? { parent } : {}),
			};
		};

		/** This window's session as an agent-view row. */
		const selfRow = (ctx: ExtensionContext): InstanceSummary => ({
			...selfHeartbeat(ctx),
			id: registration?.id ?? `self:${ctx.sessionManager.getSessionId()}`,
			status: "online",
			activity: activity.current,
			external: true,
		});

		/** The current session as a stored row, or undefined while it has no file to resume from. */
		const captureOutgoing = (ctx: ExtensionContext): BackgroundableSession | undefined => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile)) return undefined;
			return {
				cwd: ctx.sessionManager.getCwd(),
				label: ctx.sessionManager.getSessionName() ?? selfLabel(ctx),
				sessionFile,
				sessionId: ctx.sessionManager.getSessionId(),
				...(parent ? { parent } : {}),
			};
		};

		/** Pane mode: what another window's agent view asks of this session. */
		const onPaneMessage = (ctx: ExtensionContext, message: PaneMessage): void => {
			// A phone's prompt, with an id, is remote control's (ext/remote): it reports what became of it.
			if (message.type === "prompt" && !message.id)
				pi.sendUserMessage(promptContent(message), promptOptions(message));
			else if (message.type === "abort") ctx.abort();
			else if (message.type === "rename") pi.setSessionName(message.name);
			// Another session's (ext/subagents).
			else if (message.type === "session_message") pi.events.emit("bluclawd:session-message", message);
			// The rest are remote control's (ext/remote).
			else pi.events.emit("bluclawd:pane-message", message);
		};

		/** The `← for agents` footer hint: `← N agents` while sessions wait on you, `← N done`
		 *  briefly when some finish. Only reads — it never starts the daemon. */
		const startPill = (ctx: ExtensionContext, pane: string): (() => void) => {
			const client = new OrchestratorClient();
			let finished: Set<string> | undefined;
			let flashUntil = 0;
			let flashCount = 0;
			let flashTimer: ReturnType<typeof setTimeout> | undefined;
			let stopped = false;
			let parentLabel = parent;
			const runHint = (): string => theme.fg("dim", `← subagent of ${parentLabel}`);
			let last = parent ? runHint() : theme.fg("dim", "← for agents");
			const paint = (): void => {
				if (!stopped) ctx.ui.setStatus(STATUS_KEY, leftHint ?? last);
			};
			paintPill = paint;
			const tick = async (): Promise<void> => {
				if (parent) {
					try {
						parentLabel = (await client.list()).find((r) => r.pane === parent)?.label ?? parentLabel;
					} catch {
						// no daemon: the pane's name
					}
					last = runHint();
					paint();
					return;
				}
				let text = theme.fg("dim", "← for agents");
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
						text = `${theme.fg("dim", "← ")}${theme.fg("warning", n)}${theme.fg("dim", ` agent${waiting === 1 ? "" : "s"}`)}`;
					} else if (Date.now() < flashUntil) {
						text = `${theme.fg("dim", "← ")}${theme.fg("success", String(flashCount))}${theme.fg("dim", " done")}`;
					}
				} catch {
					// no daemon: the plain hint
				}
				last = text;
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
			// pi's package loader gives each top-level extension file its own module
			// instance, so agent view populates its own copy of the shared theme.
			setSharedTheme(ctx.ui.theme);
			// Agent view is a terminal affordance: print, json and rpc modes have none.
			if (ctx.mode !== "tui") return;
			if (!pane) {
				if (launched) return;
				launched = true;
				// ext/tmux-launch has already started this session as a pane when tmux is there.
				if (!Tmux.available()) ctx.ui.notify(NEEDS_TMUX, "warning");
				return;
			}
			registration?.stop();
			// Before the first heartbeat, which must not list a pane that only hosts agent view.
			if (process.env[OPEN_VIEW_ENV]) viewHost = true;
			delete process.env[OPEN_VIEW_ENV];
			hide ??= process.env[HIDE_ENV];
			delete process.env[HIDE_ENV];
			activity = new ForegroundActivity();
			// Its background subagents keep it working between turns, as the orchestrator waits on them.
			const subagentsChanged = () => {
				const line = waitingDetail(activity);
				const running = (agentTasks()?.list() ?? []).filter((task) => task.state === "running").length;
				registration?.setActivity(activity.setWaitingOn(running));
				// A new count is a new line on the row, which only a heartbeat carries.
				if (waitingDetail(activity) !== line) void registration?.refresh();
			};
			registration = new SelfRegistration(
				new OrchestratorClient(),
				// A blank session waits for its first prompt to be listed, unless it is a run (its orchestrator
				// reaches it from its first turn on) or carries a row on (/new).
				() =>
					timedCall("agent-view", "heartbeat", () =>
						blank(ctx) && !parent && event.reason !== "new" ? undefined : selfHeartbeat(ctx),
					),
				(message) => onPaneMessage(ctx, message),
				pane,
				(watched) => pi.events.emit("bluclawd:remote-watched", watched),
				() => pi.events.emit("bluclawd:remote-want-report", true),
			);
			registration.start();
			offSubagents?.();
			offSubagents = subscribeAgentTasks(subagentsChanged);
			subagentsChanged();
			if (process.env[NORMAL_ENV]) normal = startedHere = true;
			delete process.env[NORMAL_ENV];
			syncEndOnDetach(ctx);
			stopPill?.();
			const offPill = startPill(ctx, pane);
			if (!autocompleteAdded) {
				autocompleteAdded = true;
				ctx.ui.addAutocompleteProvider(withoutAgentViewCommand);
			}
			// The TUI: onTerminalInput sees keys before any dialog does, so ← must check that the main
			// editor really has the keyboard.
			const tui = holdTui(ctx, "agent-view:tui");
			// One ← opens the roster, with a second press required only just after editing/history.
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
					case "abort":
						pressedAt["ctrl+c"] = 0;
						ctx.abort();
						return { consume: true };
					case "first":
						pressedAt[key as "ctrl+c" | "ctrl+d"] = Date.now();
						exitHint(
							`Press ${key === "ctrl+c" ? "Ctrl-C" : "Ctrl-D"} again to exit${normal ? "" : " · this session keeps running"}`,
						);
						// pi clears the editor on ctrl+c; its own second press never comes.
						return key === "ctrl+c" ? undefined : { consume: true };
					case "quit":
						ctx.shutdown();
						return { consume: true };
					case "detach":
						if (key === "exit") ctx.ui.setEditorText("");
						leavePane(blank(ctx));
						return { consume: true };
					case "pass":
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
				// bluclawd's exit keys and words replace pi's own (exitAction).
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
					// Submitting /quit runs pi's own quit.
					if (action === "quit") ctx.ui.setEditorText("/quit");
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
					if (!parent || backToView())
						pi.sendUserMessage(`/${AGENT_VIEW_COMMAND}`, { expandPromptTemplates: true });
					else {
						try {
							panes.switchTo(parent);
						} catch (error) {
							ctx.ui.notify(`Could not go back to the orchestrator: ${Tmux.reason(error)}`, "warning");
						}
					}
					return { consume: true };
				}
				const at = Date.now();
				armedAt = at;
				leftHint = theme.fg(
					"dim",
					parent && !backToView() ? "Press ← again to go back" : "Press ← again to open agents",
				);
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
			// Asked something: a session now, which a background pane runs on after its terminal leaves.
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
			// Quitting ends the session as it ends a bluclawd session: a turn in progress dies with
			// the process. The session stays in agent view as a stopped row until ctrl+x deletes it.
			// A reload is not leaving.
			if (event.reason !== "quit" || ctx.mode !== "tui" || !pane) return;
			const outgoing = captureOutgoing(ctx);
			if (outgoing) handOffAfterExit(outgoing);
		});

		const openAgentView = async (ctx: ExtensionCommandContext): Promise<void> => {
			if (!pane) {
				ctx.ui.notify(NEEDS_TMUX, "warning");
				return;
			}
			if (viewOpen) return;
			viewOpen = true;
			// ← moves a normal session to the background: from here on it detaches.
			normal = false;
			syncEndOnDetach(ctx);
			const model = ctx.model;
			// A global setting, so the project's settings are not read. As bluclawd, the mode
			// shows only when it is not the default (pi's is "ask").
			const trust = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: false }).getDefaultProjectTrust();
			const sessionTitle = (): string => {
				const name = ctx.sessionManager.getSessionName();
				const dir = basename(ctx.sessionManager.getCwd());
				return name ? `π - ${name} - ${dir}` : `π - ${dir}`;
			};
			try {
				const client = new OrchestratorClient();
				// The roster as it stands, so the first frame is the whole view rather than one that fills in
				// a moment later. A daemon slow to answer, or not running yet, is left to the view's own load.
				const instances = await Promise.race([
					client.list().catch(() => undefined),
					new Promise<undefined>((resolve) => setTimeout(resolve, PRELOAD_MS)),
				]);
				await ctx.ui.custom<void>(
					(tui, _theme, _keybindings, done) => {
						const view = new AgentView({
							ui: tui,
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
									try {
										panes.setOpenedFromView(name, true);
									} catch {
										// Its ← then goes to its orchestrator, if it is a run.
									}
									panes.switchTo(name);
									if (ending) panes.kill(pane);
								},
								start: (cwd, args, env) => panes.newSession({ cwd, args, env }),
								waitForView: async (name) => {
									for (let i = 0; i < VIEW_READY_POLLS && !panes.viewReady(name); i++) {
										await new Promise((resolve) => setTimeout(resolve, 50));
									}
								},
								end: (name) => panes.end(name),
								kill: (name) => panes.kill(name),
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
							loadPastSessions,
							loadViewMode: () => loadViewMode(getAgentDir()),
							saveViewMode: (mode) => saveViewMode(getAgentDir(), mode),
							setTitle: (title) => ctx.ui.setTitle(title ?? sessionTitle()),
							hide,
							instances,
							onDrawn: viewHost
								? () => {
										try {
											panes.markViewReady(pane);
										} catch {
											// the terminal waiting on it switches after a few seconds anyway
										}
									}
								: undefined,
						});
						// The roster loads on show, not on construct — without this it opens empty.
						void view.onShow();
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
