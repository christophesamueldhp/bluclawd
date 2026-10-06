/**
 * Agent view (← on an empty prompt).
 *
 * Session switching lives on `ExtensionCommandContext`, not the plain context, so ← dispatches
 * the hidden `/agent-view` command rather than opening the view itself.
 *
 * pi's `switchSession` disposes the current session, so the outgoing handle is captured BEFORE
 * the call and handed to the daemon AFTER it, once its `.jsonl` has been flushed on dispose —
 * otherwise two writers share one session file.
 */

import { existsSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type Component,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	type TUI,
} from "@earendil-works/pi-tui";
import { lastLine, textOf } from "../../daemon/session-state.ts";
import { BUILTIN_SLASH_COMMANDS } from "../_shared/builtin-commands.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { setSharedTheme, theme } from "../_shared/theme.ts";
import { AgentView, type PastSession } from "./agent-view.ts";
import { type BackgroundableSession, CONTINUE_COMMAND, CONTINUE_TEXT, handOff, handOffAfterExit } from "./hand-off.ts";
import { type InstanceSummary, OrchestratorClient } from "./orchestrator-client.ts";
import { loadViewMode, saveViewMode } from "./prefs.ts";
import { collectRows, labelFromTask } from "./rows.ts";
import { deriveLabel, ForegroundActivity, SelfRegistration, type SelfSessionInfo } from "./self-registration.ts";

/** At anything less than the whole terminal, the conversation behind shows through the margins. */
const FULL_SCREEN = { width: "100%", maxHeight: "100%" } as const;

type ViewAction =
	| { type: "open"; sessionFile: string; resume: boolean }
	| { type: "delete" }
	| { type: "create"; model?: { provider: string; id: string }; task: string; images: ImageContent[] };

const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const PILL_POLL_MS = 10_000;
const DONE_FLASH_MS = 2500;
/** How long the first ← waits for the second, as in Claude Code. */
const LEFT_ARM_MS = 3000;
/** An edit this recent makes the first ← arm instead of opening. */
const LEFT_EDIT_MS = 2000;
const STATUS_KEY = STATUS_KEYS.agents;
/** The command ←← dispatches; not meant to be typed. */
const AGENT_VIEW_COMMAND = "agent-view";
/** The command a takeover from another terminal dispatches; not meant to be typed. */
const RELEASE_COMMAND = "agent-view-release";
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([AGENT_VIEW_COMMAND, RELEASE_COMMAND, CONTINUE_COMMAND]);

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
		let closeView: (() => void) | undefined;
		let releasing = false;
		// The first ← swaps the footer pill for this hint; the second opens agent view.
		let leftHint: string | undefined;
		let paintPill: (() => void) | undefined;
		// Set when agent view opened this session, so the hint reads "go back".
		let openedFromView = false;
		let autocompleteAdded = false;
		// Set while quitting waits for the turn's tools to finish.
		let onToolsSettled: (() => void) | undefined;

		const selfInfo = (ctx: ExtensionContext): SelfSessionInfo => ({
			cwd: ctx.sessionManager.getCwd(),
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			label: deriveLabel(ctx.sessionManager.getSessionName(), ctx.sessionManager.getEntries()),
		});

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
				detail: lastAssistant ? lastLine(textOf(lastAssistant.message.content)) : undefined,
				turns: messages.some((e) => e.message.role === "assistant") ? 1 : 0,
				createdAt: ctx.sessionManager.getHeader()?.timestamp,
				external: true,
			};
		};

		/**
		 * A handle on the current session, or undefined when there is nothing worth
		 * backgrounding: an unsaved session has no file for the daemon to resume.
		 */
		const captureOutgoing = (ctx: ExtensionContext): BackgroundableSession | undefined => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile)) return undefined;
			const model = ctx.model;
			return {
				cwd: ctx.sessionManager.getCwd(),
				label: ctx.sessionManager.getSessionName() ?? selfRow(ctx).label,
				sessionFile,
				model: model ? { provider: model.provider, id: model.id } : undefined,
				working: !ctx.isIdle(),
			};
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
					const rows = collectRows(await client.list(), undefined);
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
			// Agent view is a terminal affordance. RPC children (the daemon's own sessions) have a
			// UI too, but registering one as a window would mark its own row "open elsewhere".
			if (ctx.mode !== "tui") return;
			registration?.stop();
			activity = new ForegroundActivity();
			registration = new SelfRegistration(
				new OrchestratorClient(),
				() => selfInfo(ctx),
				// Session switching needs a command context, as ←← does.
				() => pi.sendUserMessage(`/${RELEASE_COMMAND}`, { expandPromptTemplates: true }),
			);
			registration.start();
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
			const disarm = (): void => {
				if (!armedAt) return;
				armedAt = 0;
				leftHint = undefined;
				paintPill?.();
			};
			const offKey = ctx.ui.onTerminalInput((data) => {
				// Kitty reports a release (and a held key) as separate events; only presses count.
				if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
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
				// getFocusedComponent is on pi-tui's TUI class, not its TUI interface.
				const focused = (tui as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.();
				const editorFocused = typeof (focused as { getText?: unknown } | null)?.getText === "function";
				if (!tui || tui.hasOverlay() || !editorFocused) {
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
				leftHint = theme.fg("dim", `Press ← again to ${openedFromView ? "go back to" : "open"} agents`);
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
		pi.on("agent_start", track);
		pi.on("turn_start", track);
		pi.on("agent_settled", (event) => {
			track(event);
			onToolsSettled?.();
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
			// carries on in the daemon once this process is gone (it must be the only writer of the
			// .jsonl). A switch ("new"/"resume") is handed off by agent view itself, and a reload is
			// not leaving.
			if (event.reason !== "quit" || ctx.mode !== "tui") return;
			// A tool blocked on a dialog cannot finish once the TUI is gone.
			if (!ctx.isIdle() && activity.current === "working") await settleTools();
			const outgoing = captureOutgoing(ctx);
			if (outgoing) handOffAfterExit(outgoing);
		});

		const openAgentView = async (ctx: ExtensionCommandContext): Promise<void> => {
			if (viewOpen) return;
			viewOpen = true;
			const model = ctx.model;
			const sessionTitle = (): string => {
				const name = ctx.sessionManager.getSessionName();
				const dir = basename(ctx.sessionManager.getCwd());
				return name ? `π - ${name} - ${dir}` : `π - ${dir}`;
			};
			try {
				const action = await ctx.ui.custom<ViewAction | undefined>(
					(tui, _theme, _keybindings, done) => {
						const client = new OrchestratorClient();
						const view = new AgentView({
							ui: tui,
							client,
							appName: "bluclawd",
							version: VERSION,
							model: model ? { provider: model.provider, id: model.id } : undefined,
							modelName: model?.name,
							cwd: ctx.cwd,
							home: process.env.HOME ?? "",
							self: () => selfRow(ctx),
							onClose: () => done(undefined),
							// Quitting leaves through pi's own shutdown, which hands this session to the daemon.
							onQuit: () => {
								done(undefined);
								ctx.shutdown();
							},
							listModels: () =>
								ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id })),
							isKnownCommand: (name) =>
								BUILTIN_SLASH_COMMANDS.some((c) => c.name === name) ||
								pi.getCommands().some((c) => c.name === name && c.source === "extension"),
							onSelfReply: (text) =>
								pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" }),
							onOpen: (sessionFile, _cwd, resume) => done({ type: "open", sessionFile, resume }),
							onStopSelf: () => ctx.abort(),
							onDeleteSelf: () => done({ type: "delete" }),
							onRenameSelf: (name) => pi.setSessionName(name),
							onCreateAndOpen: (_cwd, spawnModel, task, images) =>
								done({ type: "create", model: spawnModel, task, images }),
							loadPastSessions,
							loadViewMode: () => loadViewMode(getAgentDir()),
							saveViewMode: (mode) => saveViewMode(getAgentDir(), mode),
							setTitle: (title) => ctx.ui.setTitle(title ?? sessionTitle()),
						});
						closeView = () => view.close();
						// The roster loads on show, not on construct — without this it opens empty.
						void view.onShow();
						return view as Component & { dispose?(): void };
					},
					{ overlay: true, overlayOptions: FULL_SCREEN },
				);
				if (!action) return;
				if (action.type === "delete") {
					await deleteSession(ctx);
					return;
				}
				// The switch disposes this session. As on quit, a turn in progress first lets its
				// running tools finish; the daemon then carries the turn on in the background.
				if (!ctx.isIdle() && activity.current === "working") {
					ctx.ui.notify("Switching after the current tool finishes…", "info");
					await toolsSettled();
				}
				// Only plain data survives replacement. The command awaits the whole transition;
				// hand-off runs only in the fresh context, after dispose and never on cancellation.
				const outgoing = captureOutgoing(ctx);
				openedFromView = true;
				if (action.type === "open") {
					await ctx.switchSession(action.sessionFile, {
						withSession: async (replaced) => {
							await handOff(outgoing);
							// Its turn was cut off by the move: it carries on here, with no visible prompt.
							if (action.resume) {
								await replaced.sendMessage(
									{ customType: CONTINUE_COMMAND, content: CONTINUE_TEXT, display: false },
									{ triggerTurn: true },
								);
							}
						},
					});
				} else {
					const chosen = action.model ? `${action.model.provider}/${action.model.id}` : undefined;
					const current = model ? `${model.provider}/${model.id}` : undefined;
					if (chosen && chosen !== current) {
						ctx.ui.notify(
							`New session will use ${current ?? "the default model"} — newSession() cannot set ${chosen}.`,
							"warning",
						);
					}
					await ctx.newSession({
						withSession: async (replaced) => {
							await handOff(outgoing);
							await replaced.sendUserMessage(
								action.images.length
									? [...(action.task ? [{ type: "text" as const, text: action.task }] : []), ...action.images]
									: action.task,
							);
						},
					});
				}
			} finally {
				viewOpen = false;
				closeView = undefined;
			}
		};

		/**
		 * ctrl+x twice on this window's own row: the session leaves agent view like any other, and
		 * this window moves to a new one, still in agent view. The .jsonl stays, resumable with /resume.
		 */
		const deleteSession = async (ctx: ExtensionCommandContext): Promise<void> => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!ctx.isIdle()) {
				ctx.abort();
				await ctx.waitForIdle();
			}
			await ctx.newSession({
				withSession: async (replaced) => {
					// Rows this session left behind earlier (a stored twin) go with it.
					const client = new OrchestratorClient();
					const twins = sessionFile
						? (await client.list().catch(() => [])).filter((i) => !i.external && i.sessionFile === sessionFile)
						: [];
					await Promise.all(twins.map((i) => client.delete(i.id).catch(() => undefined)));
					void replaced.sendUserMessage(`/${AGENT_VIEW_COMMAND}`, { expandPromptTemplates: true });
				},
			});
		};

		/**
		 * Another terminal is taking this session over: let any turn finish
		 * and move to a new session. Not handed to the daemon — the other terminal is its writer now.
		 */
		const releaseSession = async (ctx: ExtensionCommandContext): Promise<void> => {
			if (releasing) return;
			releasing = true;
			try {
				closeView?.();
				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for this session to finish before moving to another terminal", "info");
					await ctx.waitForIdle();
				}
				await ctx.newSession({
					withSession: async (replaced) => {
						replaced.ui.notify("Session moved to another terminal — this is a new one", "info");
					},
				});
			} finally {
				releasing = false;
			}
		};

		pi.registerCommand(AGENT_VIEW_COMMAND, {
			description: "Agent view (press ← on an empty prompt)",
			handler: async (_args, ctx) => openAgentView(ctx),
		});
		// Run by a worker the daemon resumed mid-turn: the model carries on without a visible prompt.
		pi.registerCommand(CONTINUE_COMMAND, {
			description: "Continue a turn that moved to the background",
			handler: async () =>
				pi.sendMessage(
					{ customType: CONTINUE_COMMAND, content: CONTINUE_TEXT, display: false },
					{ triggerTurn: true },
				),
		});
		pi.registerCommand(RELEASE_COMMAND, {
			description: "Let another terminal take this session over",
			handler: async (_args, ctx) => releaseSession(ctx),
		});
	},
};

export default agentView.factory;
