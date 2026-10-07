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
	type TUI,
} from "@earendil-works/pi-tui";
import { lastLine, textOf, toolActivity } from "../../daemon/session-state.ts";
import { BUILTIN_SLASH_COMMANDS } from "../_shared/builtin-commands.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { setSharedTheme, theme } from "../_shared/theme.ts";
import { trustBadge } from "../permissions/index.ts";
import { AgentView, EXIT_WORDS, type PastSession } from "./agent-view.ts";
import { type BackgroundableSession, handOffAfterExit } from "./hand-off.ts";
import { type InstanceSummary, OrchestratorClient, type PaneMessage } from "./orchestrator-client.ts";
import { loadViewMode, saveViewMode } from "./prefs.ts";
import { collectRows, labelFromTask } from "./rows.ts";
import { deriveLabel, ForegroundActivity, SelfRegistration, type SelfSessionInfo } from "./self-registration.ts";
import { AGENT_VIEW_COMMAND, HIDE_ENV, NORMAL_ENV, OPEN_VIEW_ENV, Tmux } from "./tmux.ts";

/** At anything less than the whole terminal, the conversation behind shows through the margins. */
const FULL_SCREEN = { width: "100%", maxHeight: "100%" } as const;

const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const PILL_POLL_MS = 10_000;
const DONE_FLASH_MS = 2500;
/** How long the first ← waits for the second, as in Claude Code. */
const LEFT_ARM_MS = 3000;
/** An edit this recent makes the first ← arm instead of opening. */
const LEFT_EDIT_MS = 2000;
/** A second ctrl+c or ctrl+d this soon after the first exits (pi's own window for ctrl+c). */
const EXIT_PRESS_MS = 500;
/** How many times (50ms apart) deleting this terminal's session waits for the pane it moves to. */
const VIEW_READY_POLLS = 100;
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

/** An exit word or /exit alone at the prompt: Claude Code runs /exit for it, which is pi's /quit. */
export function isQuitAlias(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/exit" || EXIT_WORDS.has(trimmed);
}

/** What an exit key or word does, as in Claude Code. */
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
 * Claude Code's exit keys. A normal session (the one `claude` started in this terminal) ends on
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

/** pi's ways to pick a session; a pane is given the one its launcher already picked. */
const SESSION_FLAGS: ReadonlySet<string> = new Set(["-c", "--continue", "-r", "--resume"]);
const SESSION_VALUE_FLAGS: ReadonlySet<string> = new Set(["--session", "--session-id", "--fork"]);

/** The arguments a launching pi hands its pane: its own, with the session it resolved. */
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
		let stopPill: (() => void) | undefined;
		let viewOpen = false;
		// The first ← swaps the footer pill for this hint; the second opens agent view.
		let leftHint: string | undefined;
		let paintPill: (() => void) | undefined;
		let autocompleteAdded = false;
		// Pane mode: this pi runs in a tmux session of agent view's own (tmux.ts).
		const pane = Tmux.currentPane();
		const panes = new Tmux();
		let launched = false;
		// What the turn in progress is doing, for this session's row in other windows.
		let liveDetail: string | undefined;

		// A pane nothing has been asked in yet is not a session, as a Claude Code session isn't one
		// until it runs: no other window lists it, and it ends when the terminal leaves it.
		const blank = (ctx: ExtensionContext): boolean =>
			!!pane && !ctx.sessionManager.getEntries().some((e) => e.type === "message");
		// A normal session, as Claude Code's: the pane `pi` started in this terminal, until ← opens
		// agent view. Quitting ends it, and so does closing its terminal.
		let normal = false;
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
		// Agent view there has no session of this terminal's, as Claude Code's once its origin is
		// deleted: no own row, and esc quits.
		const hosting = (ctx: ExtensionContext): boolean => viewHost && blank(ctx);
		/** Leave this pane: tmux keeps a session running; one with nothing in it ends. */
		const leavePane = (ending: boolean): void => {
			if (ending && pane) panes.kill(pane);
			else panes.detach();
		};

		const selfInfo = (ctx: ExtensionContext): SelfSessionInfo | undefined => {
			if (blank(ctx)) return undefined;
			const row = selfRow(ctx);
			return {
				cwd: ctx.sessionManager.getCwd(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				label: row.label,
				pane,
				detail: row.detail,
				turns: row.turns,
				createdAt: row.createdAt,
			};
		};

		/** This window's session as an agent-view row. */
		const selfRow = (ctx: ExtensionContext): InstanceSummary => {
			const entries = ctx.sessionManager.getEntries();
			const messages = entries.filter((e) => e.type === "message") as Array<{
				message: { role?: string; content?: unknown };
			}>;
			const lastAssistant = [...messages].reverse().find((e) => e.message.role === "assistant");
			const name = ctx.sessionManager.getSessionName();
			const firstUser = deriveLabel(undefined, entries);
			return {
				id: registration?.id ?? `self:${ctx.sessionManager.getSessionId()}`,
				status: "online",
				activity: activity.current,
				cwd: ctx.sessionManager.getCwd(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				label: name?.trim() || (firstUser ? labelFromTask(firstUser) : undefined),
				detail:
					activity.current === "working" && liveDetail
						? liveDetail
						: lastAssistant
							? lastLine(textOf(lastAssistant.message.content))
							: undefined,
				turns: messages.some((e) => e.message.role === "assistant") ? 1 : 0,
				createdAt: ctx.sessionManager.getHeader()?.timestamp,
				external: true,
				pane,
			};
		};

		/** The current session as a stored row, or undefined while it has no file to resume from. */
		const captureOutgoing = (ctx: ExtensionContext): BackgroundableSession | undefined => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile)) return undefined;
			return {
				cwd: ctx.sessionManager.getCwd(),
				label: ctx.sessionManager.getSessionName() ?? selfRow(ctx).label,
				sessionFile,
			};
		};

		/**
		 * Pane mode's launcher: `pi` run in a terminal starts its session as a pane and attaches to
		 * it, so this process is only that terminal's tmux client. Before the TUI has done anything
		 * but draw, and before an argument prompt is sent. False when tmux could not start it.
		 */
		const launchInTmux = (ctx: ExtensionContext): boolean => {
			let name: string;
			try {
				name = panes.newSession({
					cwd: ctx.cwd,
					args: paneArgs(process.argv.slice(2), ctx.sessionManager.getSessionFile()),
					env: { [NORMAL_ENV]: "1" },
				});
			} catch (error) {
				ctx.ui.notify(
					`Agent view is off — tmux couldn't start: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return false;
			}
			let tui: TUI | undefined;
			ctx.ui.setWidget("agent-view:launch", (widgetTui) => {
				tui = widgetTui;
				return { render: () => [], invalidate: () => {} };
			});
			ctx.ui.setWidget("agent-view:launch", undefined);
			// Fullscreen pi copies its last frame to the terminal's own screen on stop; this one is
			// not the session's, so it would stay behind once tmux leaves.
			(tui as { stop(options?: { preserveScreen?: boolean }): void } | undefined)?.stop({ preserveScreen: true });
			panes.attach(name);
			// tmux's own "[detached (from session …)]" / "[exited]" line.
			process.stdout.write("\x1b[1A\r\x1b[2K");
			process.exit(0);
		};

		/** Pane mode: what another window's agent view asks of this session. */
		const onPaneMessage = (ctx: ExtensionContext, message: PaneMessage): void => {
			if (message.type === "prompt") {
				pi.sendUserMessage(message.text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			} else if (message.type === "abort") ctx.abort();
			else pi.setSessionName(message.name);
		};

		/** The `← for agents` footer hint: `← N agents` while sessions wait on you, `← N done`
		 *  briefly when some finish. Only reads — it never starts the daemon. */
		const startPill = (ctx: ExtensionContext): (() => void) => {
			const client = new OrchestratorClient();
			let finished: Set<string> | undefined;
			let flashUntil = 0;
			let flashCount = 0;
			let stopped = false;
			let last = theme.fg("dim", "← for agents");
			const paint = (): void => {
				if (!stopped) ctx.ui.setStatus(STATUS_KEY, leftHint ?? last);
			};
			paintPill = paint;
			const tick = async (): Promise<void> => {
				let text = theme.fg("dim", "← for agents");
				try {
					const rows = collectRows(await client.list(), undefined).filter((r) => r.id !== registration?.id);
					const waiting = rows.filter((r) => r.state === "needs").length;
					const done = new Set(rows.filter((r) => r.state === "done" || r.state === "failed").map((r) => r.id));
					const fresh = finished ? [...done].filter((id) => !finished?.has(id)).length : 0;
					finished = done;
					if (fresh > 0) {
						flashCount = fresh;
						flashUntil = Date.now() + DONE_FLASH_MS;
						setTimeout(() => void tick(), DONE_FLASH_MS);
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
				paintPill = undefined;
				ctx.ui.setStatus(STATUS_KEY, undefined);
			};
		};

		pi.on("session_start", (_event, ctx) => {
			// pi's package loader gives each top-level extension file its own module
			// instance, so agent view populates its own copy of the shared theme.
			setSharedTheme(ctx.ui.theme);
			// Agent view is a terminal affordance: print, json and rpc modes have none.
			if (ctx.mode !== "tui") return;
			if (!pane) {
				if (launched) return;
				launched = true;
				if (!Tmux.available()) {
					ctx.ui.notify(NEEDS_TMUX, "warning");
					return;
				}
				launchInTmux(ctx);
				return;
			}
			registration?.stop();
			// Before the first heartbeat, which must not list a pane that only hosts agent view.
			if (process.env[OPEN_VIEW_ENV]) viewHost = true;
			delete process.env[OPEN_VIEW_ENV];
			hide ??= process.env[HIDE_ENV];
			delete process.env[HIDE_ENV];
			activity = new ForegroundActivity();
			registration = new SelfRegistration(
				new OrchestratorClient(),
				() => selfInfo(ctx),
				(message) => onPaneMessage(ctx, message),
				pane,
			);
			registration.start();
			if (process.env[NORMAL_ENV]) normal = true;
			delete process.env[NORMAL_ENV];
			syncEndOnDetach(ctx);
			stopPill?.();
			const offPill = startPill(ctx);
			if (!autocompleteAdded) {
				autocompleteAdded = true;
				ctx.ui.addAutocompleteProvider(withoutAgentViewCommand);
			}
			// A zero-line widget, only to get hold of the TUI: onTerminalInput sees keys before any
			// dialog does, so ← must check that the main editor really has the keyboard.
			let tui: TUI | undefined;
			ctx.ui.setWidget("agent-view:tui", (widgetTui) => {
				tui = widgetTui;
				return { render: () => [], invalidate: () => {} };
			});
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
				const focused = (tui as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.();
				return typeof (focused as { getText?: unknown } | null)?.getText === "function";
			};
			const offKey = ctx.ui.onTerminalInput((data) => {
				// Kitty reports a release (and a held key) as separate events; only presses count.
				if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
				// Claude Code's exit keys and words replace pi's own (exitAction).
				if (!viewOpen && !tui?.hasOverlay()) {
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
				if (!tui || tui.hasOverlay() || !editorFocused()) {
					disarm();
					return undefined;
				}
				if (Date.now() - editedAt >= LEFT_EDIT_MS || (armedAt && Date.now() - armedAt < LEFT_ARM_MS)) {
					disarm();
					pi.sendUserMessage(`/${AGENT_VIEW_COMMAND}`, { expandPromptTemplates: true });
					return { consume: true };
				}
				const at = Date.now();
				armedAt = at;
				leftHint = theme.fg("dim", "Press ← again to open agents");
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

		const track = (event: { type: string; kind?: string }): void => {
			const current = activity.apply(event);
			registration?.setActivity(current);
		};
		pi.on("agent_start", (event, ctx) => {
			// Asked something: a session now, which a background pane runs on after its terminal leaves.
			syncEndOnDetach(ctx);
			track(event);
		});
		pi.on("turn_start", track);
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
			registration?.stop();
			registration = undefined;
			stopPill?.();
			stopPill = undefined;
			// Quitting ends the session as it ends a Claude Code session: a turn in progress dies with
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
			// ← moves a normal session to the background, as in Claude Code: from here on it detaches.
			normal = false;
			syncEndOnDetach(ctx);
			const model = ctx.model;
			// A global setting, so the project's settings are not read. As Claude Code, the mode
			// shows only when it is not the default (pi's is "ask").
			const trust = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: false }).getDefaultProjectTrust();
			const sessionTitle = (): string => {
				const name = ctx.sessionManager.getSessionName();
				const dir = basename(ctx.sessionManager.getCwd());
				return name ? `π - ${name} - ${dir}` : `π - ${dir}`;
			};
			try {
				await ctx.ui.custom<void>(
					(tui, _theme, _keybindings, done) => {
						const client = new OrchestratorClient();
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
								detach: () => leavePane(blank(ctx)),
								startShell: (cwd, command) => panes.startShell(cwd, command),
								listShells: () => panes.listShells(),
								stopShell: (name) => panes.stopShell(name),
								capture: (name, lines) => panes.capture(name, lines),
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

export default agentView.factory;
