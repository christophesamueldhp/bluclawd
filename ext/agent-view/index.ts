/**
 * Agent view (← twice on an empty prompt) — Claude Code's `claude agents` for pi.
 *
 * Everything it needs is on pi's public extension surface:
 *
 * | needs | pi gives |
 * |---|---|
 * | a full-screen UI with the keyboard | `ctx.ui.custom({ overlay: true })` |
 * | opening another session in this window | `ctx.switchSession(path)` |
 * | starting a fresh one in this window | `ctx.newSession()` |
 * | ←← on an empty prompt | `ui.onTerminalInput` + `sendUserMessage("/agent-view", { expandPromptTemplates })` |
 * | the `← for agents` hint | `ctx.ui.setStatus` |
 *
 * The session-switching powers live on `ExtensionCommandContext`, not the plain context, which
 * is why ← dispatches the `/agent-view` command rather than opening the view itself. The command
 * is only that plumbing: ←← is the way in, so autocomplete and /help leave it out.
 *
 * The outgoing session keeps running because this hands it to the daemon after the switch —
 * pi's `switchSession` disposes the current session, so the handle has to be captured BEFORE
 * the call and spawned AFTER it, once the outgoing `.jsonl` has been flushed on dispose. Two
 * writers on one session file is the failure this ordering exists to prevent.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
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
import { setSharedTheme, theme } from "../_shared/theme.ts";
import { AgentView, type PastSession } from "./agent-view.ts";
import { type InstanceSummary, OrchestratorClient } from "./orchestrator-client.ts";
import { loadViewMode, saveViewMode } from "./prefs.ts";
import { collectRows, labelFromTask } from "./rows.ts";
import { deriveLabel, ForegroundActivity, SelfRegistration, type SelfSessionInfo } from "./self-registration.ts";

/** What the daemon needs to keep the outgoing session running in the background. */
interface BackgroundableSession {
	cwd: string;
	label?: string;
	sessionFile: string;
	model?: { provider: string; id: string };
}

/** At anything less than the whole terminal, the conversation behind shows through the margins. */
const FULL_SCREEN = { width: "100%", maxHeight: "100%" } as const;

const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const PILL_POLL_MS = 10_000;
const DONE_FLASH_MS = 2500;
/** How long the first ← waits for the second. */
const LEFT_ARM_MS = 2000;
const STATUS_KEY = "agents";
/** The command ←← dispatches; not meant to be typed. */
export const AGENT_VIEW_COMMAND = "agent-view";

/** Autocomplete without the agent view command. */
export function withoutAgentViewCommand(current: AutocompleteProvider): AutocompleteProvider {
	return {
		...current,
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
		applyCompletion: current.applyCompletion.bind(current),
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!base) return base;
			const items = base.items.filter((item) => item.value !== AGENT_VIEW_COMMAND);
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
		// The first ← swaps the footer pill for this hint; the second opens agent view.
		let leftHint: string | undefined;
		let paintPill: (() => void) | undefined;
		// Set when agent view opened this session, so the hint reads "go back".
		let openedFromView = false;
		let autocompleteAdded = false;

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
		const captureOutgoing = (ctx: ExtensionCommandContext): BackgroundableSession | undefined => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile || !existsSync(sessionFile)) return undefined;
			const model = ctx.model;
			return {
				cwd: ctx.sessionManager.getCwd(),
				label: ctx.sessionManager.getSessionName() ?? selfRow(ctx).label,
				sessionFile,
				model: model ? { provider: model.provider, id: model.id } : undefined,
			};
		};

		const handOff = async (outgoing: BackgroundableSession | undefined): Promise<void> => {
			if (!outgoing) return;
			try {
				await new OrchestratorClient().spawn(outgoing);
			} catch {
				// Best-effort: with no daemon the outgoing session is still on disk and
				// resumable with /resume; it just is not running in parallel.
			}
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
			registration = new SelfRegistration(new OrchestratorClient(), () => selfInfo(ctx));
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
			// ← twice on an empty prompt opens agent view: the first press shows Claude Code's
			// "Press ← again" hint, the second switches. Nothing is taken while an overlay or
			// dialog has the keyboard, or while the prompt holds text.
			let armedAt = 0;
			const disarm = (): void => {
				if (!armedAt) return;
				armedAt = 0;
				leftHint = undefined;
				paintPill?.();
			};
			const offKey = ctx.ui.onTerminalInput((data) => {
				// Kitty reports a release (and a held key) as separate events; only presses count.
				if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
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
				if (Date.now() - armedAt < LEFT_ARM_MS) {
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
			registration?.setActivity(activity.apply(event));
		};
		pi.on("agent_start", track);
		pi.on("turn_start", track);
		pi.on("agent_settled", track);
		pi.on("ui_prompt_start", track);
		pi.on("ui_prompt_end", track);

		pi.on("session_shutdown", () => {
			registration?.stop();
			registration = undefined;
			stopPill?.();
			stopPill = undefined;
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
				await ctx.ui.custom<void>(
					(tui, _theme, _keybindings, done) => {
						const view = new AgentView({
							ui: tui,
							client: new OrchestratorClient(),
							appName: "bluclawd",
							version: VERSION,
							model: model ? { provider: model.provider, id: model.id } : undefined,
							cwd: ctx.cwd,
							home: process.env.HOME ?? "",
							self: () => selfRow(ctx),
							onClose: () => done(undefined),
							onSelfReply: (text) =>
								pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" }),
							onOpen: (sessionFile) => {
								done(undefined);
								openedFromView = true;
								void (async () => {
									// Capture BEFORE the switch: switchSession disposes this session.
									const outgoing = captureOutgoing(ctx);
									await ctx.switchSession(sessionFile);
									await registration?.refresh();
									await handOff(outgoing);
								})();
							},
							onCreateAndOpen: (_cwd, spawnModel, task) => {
								done(undefined);
								openedFromView = true;
								void (async () => {
									const outgoing = captureOutgoing(ctx);
									const chosen = spawnModel ? `${spawnModel.provider}/${spawnModel.id}` : undefined;
									const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
									if (chosen && chosen !== current) {
										// pi's newSession() takes no model; say so instead of quietly ignoring it.
										ctx.ui.notify(
											`New session opened with ${current ?? "the default model"} — newSession() cannot set ${chosen}.`,
											"warning",
										);
									}
									await ctx.newSession({
										withSession: async (replaced) => {
											replaced.sendUserMessage(task);
										},
									});
									await registration?.refresh();
									await handOff(outgoing);
								})();
							},
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
			description: "Agent view (press ← twice on an empty prompt)",
			handler: async (_args, ctx) => openAgentView(ctx),
		});
	},
};

export default agentView.factory;
