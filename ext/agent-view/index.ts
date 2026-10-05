/**
 * Agent view (← twice on an empty prompt).
 *
 * Session switching lives on `ExtensionCommandContext`, not the plain context, so ← dispatches
 * the hidden `/agent-view` command rather than opening the view itself.
 *
 * pi's `switchSession` disposes the current session, so the outgoing handle is captured BEFORE
 * the call and handed to the daemon AFTER it, once its `.jsonl` has been flushed on dispose —
 * otherwise two writers share one session file.
 */

import { existsSync } from "node:fs";
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
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { setSharedTheme, theme } from "../_shared/theme.ts";
import { AgentView, type PastSession } from "./agent-view.ts";
import { type BackgroundableSession, CONTINUE_PROMPT, handOff, handOffAfterExit } from "./hand-off.ts";
import { createManagedRuntime, MANAGED_BOOTSTRAP_COMMAND } from "./managed-runtime.ts";
import { managedUiRef } from "./managed-state.ts";
import { type InstanceSummary, OrchestratorClient } from "./orchestrator-client.ts";
import { loadViewMode, saveViewMode } from "./prefs.ts";
import { collectRows, labelFromTask } from "./rows.ts";
import { deriveLabel, ForegroundActivity, type SelfRegistration, type SelfSessionInfo } from "./self-registration.ts";

/** At anything less than the whole terminal, the conversation behind shows through the margins. */
const FULL_SCREEN = { width: "100%", maxHeight: "100%" } as const;

type ViewAction =
	| { type: "open"; sessionFile: string; resume: boolean }
	| { type: "create"; model?: { provider: string; id: string }; task: string; images: ImageContent[] };

const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const PILL_POLL_MS = 10_000;
const DONE_FLASH_MS = 2500;
/** How long the first ← waits for the second. */
const LEFT_ARM_MS = 2000;
const STATUS_KEY = STATUS_KEYS.agents;
/** The command ←← dispatches; not meant to be typed. */
const AGENT_VIEW_COMMAND = "agent-view";
/** The command a takeover from another terminal dispatches; not meant to be typed. */
const RELEASE_COMMAND = "agent-view-release";
const HIDDEN_COMMANDS: ReadonlySet<string> = new Set([AGENT_VIEW_COMMAND, RELEASE_COMMAND, MANAGED_BOOTSTRAP_COMMAND]);

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
		const managedState = managedUiRef.get();
		const managed = createManagedRuntime(pi, managedState, loadPastSessions);
		pi.on("input", (event, ctx) => managed.input(event, ctx));
		pi.registerCommand(MANAGED_BOOTSTRAP_COMMAND, {
			description: "Initialize persistent session views",
			handler: async (_args, ctx) => managed.bootstrap(ctx),
		});
		let registration: SelfRegistration | undefined;
		// What this window is doing: its own agent-view row, and what other windows see.
		const activity = new ForegroundActivity();
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
			if (!autocompleteAdded) {
				autocompleteAdded = true;
				ctx.ui.addAutocompleteProvider(withoutAgentViewCommand);
			}
			managed.sessionStart(ctx);
		});

		const track = (event: { type: string; kind?: string }): void => {
			registration?.setActivity(activity.apply(event));
		};
		pi.on("agent_start", track);
		pi.on("turn_start", track);
		pi.on("agent_settled", track);
		pi.on("ui_prompt_start", track);
		pi.on("ui_prompt_end", track);

		pi.on("session_shutdown", (event, ctx) => {
			if (ctx.mode === "tui" && managed.shutdown()) return;
			registration?.stop();
			registration = undefined;
			stopPill?.();
			stopPill = undefined;
			// Exiting pi keeps the session in agent view until ctrl+x deletes it; a turn in progress
			// carries on in the daemon once this process is gone (it must be the only writer of the
			// .jsonl). A switch ("new"/"resume") is handed off by agent view itself, and a reload is
			// not leaving.
			if (event.reason !== "quit" || ctx.mode !== "tui") return;
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
						const view = new AgentView({
							ui: tui,
							client: new OrchestratorClient(),
							appName: "bluclawd",
							version: VERSION,
							model: model ? { provider: model.provider, id: model.id } : undefined,
							modelName: model?.name,
							cwd: ctx.cwd,
							home: process.env.HOME ?? "",
							self: () => selfRow(ctx),
							onClose: () => done(undefined),
							onSelfReply: (text) =>
								pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" }),
							onOpen: async (target) => {
								const sessionFile =
									"sessionFile" in target
										? target.sessionFile
										: (await new OrchestratorClient().list()).find((row) => row.id === target.instanceId)
												?.sessionFile;
								if (!sessionFile) return false;
								done({ type: "open", sessionFile, resume: false });
								return true;
							},
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
				// Only plain data survives replacement. The command awaits the whole transition;
				// hand-off runs only in the fresh context, after dispose and never on cancellation.
				const outgoing = captureOutgoing(ctx);
				openedFromView = true;
				if (action.type === "open") {
					await ctx.switchSession(action.sessionFile, {
						withSession: async (replaced) => {
							await handOff(outgoing);
							if (action.resume) await replaced.sendUserMessage(CONTINUE_PROMPT);
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
		 * Another terminal is taking this session over: stop any turn (that terminal carries it on)
		 * and move to a new session. Not handed to the daemon — the other terminal is its writer now.
		 */
		const releaseSession = async (ctx: ExtensionCommandContext): Promise<void> => {
			if (releasing) return;
			releasing = true;
			try {
				closeView?.();
				if (!ctx.isIdle()) await ctx.waitForIdle();
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
			description: "Agent view (press ← twice on an empty prompt)",
			handler: async (_args, ctx) => (ctx.mode === "tui" ? managed.agents(ctx) : openAgentView(ctx)),
		});
		pi.registerCommand(RELEASE_COMMAND, {
			description: "Let another terminal take this session over",
			handler: async (_args, ctx) => releaseSession(ctx),
		});
	},
};

export default agentView.factory;
