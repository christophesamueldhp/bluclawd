/**
 * Agent view (← on an empty prompt).
 *
 * It needs tmux: every session is a pi of its own in a private tmux server (tmux.ts), and `pi` run
 * in a terminal starts its session there and attaches. Without tmux, agent view stays off.
 */

import { existsSync, writeSync } from "node:fs";
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
import { type BackgroundableSession, CONTINUE_COMMAND, CONTINUE_TEXT, handOffAfterExit } from "./hand-off.ts";
import { type InstanceSummary, OrchestratorClient, type PaneMessage } from "./orchestrator-client.ts";
import { loadViewMode, saveViewMode } from "./prefs.ts";
import { collectRows, labelFromTask } from "./rows.ts";
import { deriveLabel, ForegroundActivity, SelfRegistration, type SelfSessionInfo } from "./self-registration.ts";
import { CONTINUE_ENV, OPEN_VIEW_ENV, piCommand, Tmux } from "./tmux.ts";

/** At anything less than the whole terminal, the conversation behind shows through the margins. */
const FULL_SCREEN = { width: "100%", maxHeight: "100%" } as const;

const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const PILL_POLL_MS = 10_000;
const DONE_FLASH_MS = 2500;
/** How long the first ← waits for the second, as in Claude Code. */
const LEFT_ARM_MS = 3000;
/** An edit this recent makes the first ← arm instead of opening. */
const LEFT_EDIT_MS = 2000;
/** pi exits on a second ctrl+c this soon after the first; a pane detaches instead. */
const CTRL_C_MS = 500;
const STATUS_KEY = STATUS_KEYS.agents;
const NEEDS_TMUX = "Agent view needs tmux — install it (brew install tmux) and start pi again";
/** The command ←← dispatches; not meant to be typed. */
const AGENT_VIEW_COMMAND = "agent-view";
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
		// Set while quitting waits for the turn's tools to finish.
		let onToolsSettled: (() => void) | undefined;
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
		// Set while tmux ends this blank pane when its terminal detaches or closes.
		let endsOnDetach = false;
		// Set on a pane started only to show agent view, after this terminal's session was deleted.
		let viewHost = false;
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

		/**
		 * A handle on the current session, or undefined when there is nothing worth
		 * backgrounding: an unsaved session has no file for the daemon to resume.
		 */
		const captureOutgoing = (ctx: ExtensionContext): BackgroundableSession | undefined => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile)) return undefined;
			return {
				cwd: ctx.sessionManager.getCwd(),
				label: ctx.sessionManager.getSessionName() ?? selfRow(ctx).label,
				sessionFile,
				working: !ctx.isIdle(),
				command: piCommand(),
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
			const openView = !!process.env[OPEN_VIEW_ENV];
			delete process.env[OPEN_VIEW_ENV];
			if (openView) viewHost = true;
			activity = new ForegroundActivity();
			registration = new SelfRegistration(
				new OrchestratorClient(),
				() => selfInfo(ctx),
				(message) => onPaneMessage(ctx, message),
				pane,
			);
			registration.start();
			if (blank(ctx) && !endsOnDetach) {
				try {
					panes.endOnDetach(pane, true);
					endsOnDetach = true;
				} catch {
					// it ends on quitting all the same
				}
			}
			// A pane started to carry on a turn, or to show agent view, does so once.
			if (process.env[CONTINUE_ENV]) {
				delete process.env[CONTINUE_ENV];
				pi.sendMessage(
					{ customType: CONTINUE_COMMAND, content: CONTINUE_TEXT, display: false },
					{ triggerTurn: true },
				);
			}
			if (openView) {
				pi.sendUserMessage(`/${AGENT_VIEW_COMMAND}`, { expandPromptTemplates: true });
			}
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
			let ctrlCAt = 0;
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
				// pi's own exit keys (ctrl+c twice, ctrl+d on an empty prompt) leave tmux instead, as
				// quitting Claude Code leaves its sessions running.
				if (!viewOpen && !tui?.hasOverlay()) {
					const empty = ctx.ui.getEditorText() === "";
					if (matchesKey(data, "ctrl+d") && empty) {
						leavePane(blank(ctx));
						return { consume: true };
					}
					if (matchesKey(data, "ctrl+c")) {
						const now = Date.now();
						if (now - ctrlCAt < CTRL_C_MS) {
							ctrlCAt = 0;
							leavePane(blank(ctx));
							return { consume: true };
						}
						ctrlCAt = now;
					}
				}
				// Claude Code runs /exit for these; submitting them as /quit runs pi's own quit.
				if (!viewOpen && matchesKey(data, "enter") && isQuitAlias(ctx.ui.getEditorText()) && editorFocused()) {
					ctx.ui.setEditorText("/quit");
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
		pi.on("agent_start", (event) => {
			// Asked something: a session now, which runs on after its terminal leaves.
			if (endsOnDetach && pane) {
				endsOnDetach = false;
				try {
					panes.endOnDetach(pane, false);
				} catch {
					// tmux is gone with it
				}
			}
			track(event);
		});
		pi.on("turn_start", track);
		pi.on("agent_settled", (event) => {
			liveDetail = undefined;
			track(event);
			onToolsSettled?.();
		});
		pi.on("tool_execution_start", (event) => {
			liveDetail = toolActivity(event.toolName, event.args);
		});
		pi.on("ui_prompt_start", track);
		pi.on("ui_prompt_end", track);
		pi.on("turn_end", (event) => {
			if (event.toolResults.length > 0) onToolsSettled?.();
		});

		/**
		 * Quitting mid-turn waits, as Claude Code does, until the running tools finish, so their
		 * results reach the transcript instead of being cut off and run again in the background.
		 * The turn's next model request is then aborted with the session. Ctrl+C stops waiting.
		 */
		const settleTools = async (): Promise<void> => {
			// A closed terminal (SIGHUP) cannot wait: pi exits on the next write that fails, before
			// the hand-off. The synchronous write is the probe; then the turn is cut off as before.
			try {
				writeSync(
					1,
					`${theme.fg("dim", "Backgrounding after the current tool finishes… (ctrl+c to stop it now)")}\n`,
				);
			} catch {
				return;
			}
			await toolsSettled();
		};

		const toolsSettled = (): Promise<void> =>
			new Promise<void>((resolve) => {
				const done = (): void => {
					onToolsSettled = undefined;
					process.off("SIGINT", done);
					resolve();
				};
				onToolsSettled = done;
				process.once("SIGINT", done);
			});

		pi.on("session_shutdown", async (event, ctx) => {
			registration?.stop();
			registration = undefined;
			stopPill?.();
			stopPill = undefined;
			// Exiting pi keeps the session in agent view until ctrl+x deletes it; a turn in progress
			// carries on in a new pane once this process is gone (it must be the only writer of the
			// .jsonl). A reload is not leaving.
			if (event.reason !== "quit" || ctx.mode !== "tui" || !pane) return;
			// A tool blocked on a dialog cannot finish once the TUI is gone.
			if (!ctx.isIdle() && activity.current === "working") await settleTools();
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
								kill: (name) => panes.kill(name),
								unlist: async () => {
									await registration?.stop();
									registration = undefined;
								},
								detach: () => leavePane(blank(ctx)),
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
