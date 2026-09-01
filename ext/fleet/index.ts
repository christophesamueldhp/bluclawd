/**
 * FleetView — the live session manager, and the one bluclawd feature with no
 * Claude Code equivalent.
 *
 * It is also the feature that looked impossible from outside pi, so it is worth
 * recording why it is not. Everything it needs turns out to be on pi's public
 * extension surface:
 *
 * | needs | pi gives |
 * |---|---|
 * | a full-screen UI with the keyboard | `ctx.ui.custom({ overlay: true })` |
 * | opening another session in this window | `ctx.switchSession(path)` |
 * | starting a fresh one in this window | `ctx.newSession()` |
 * | this session's identity for the roster | `ctx.sessionManager`, `ctx.model`, `ctx.cwd` |
 * | a one-line hint under the editor | `ctx.ui.setWidget` |
 *
 * The session-switching powers live on `ExtensionCommandContext`, not the plain
 * context, which is why FleetView opens from a command rather than an event.
 *
 * The outgoing session keeps running because this hands it to the daemon after
 * the switch — pi's `switchSession` disposes the current session, so the handle
 * has to be captured BEFORE the call and spawned AFTER it, once the outgoing
 * `.jsonl` has been flushed on dispose. Two writers on one session file is the
 * failure this ordering exists to prevent.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { setSharedTheme } from "../_shared/theme.ts";
import { FleetView } from "./fleet-view.ts";
import { OrchestratorClient } from "./orchestrator-client.ts";
import { hideSession, loadHiddenSessions, toSavedSummaries } from "./saved-sessions.ts";
import { FleetSelfRegistration, type SelfSessionInfo } from "./self-registration.ts";

/** What the daemon needs to keep the outgoing session running in the background. */
interface BackgroundableSession {
	cwd: string;
	label?: string;
	sessionFile: string;
	model?: { provider: string; id: string };
}

/**
 * Sessions persisted on disk, across every project, so they survive a daemon
 * restart or a bluclawd exit and can still be resumed from the roster.
 *
 * Sessions whose cwd no longer exists, or lives under an ephemeral temp root,
 * are dropped: hundreds of old test and runtime sessions under /var/folders
 * would otherwise flood the list, and none of them can be meaningfully resumed.
 */
const TMP_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const MAX_SAVED_ROWS = 40;

function isRealCwd(cwd: string): boolean {
	return existsSync(cwd) && !TMP_ROOTS.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

async function loadSavedSessions() {
	return toSavedSummaries(
		await SessionManager.listAll(),
		loadHiddenSessions(getAgentDir()),
		MAX_SAVED_ROWS,
		isRealCwd,
	);
}

const fleet: InlineExtension = {
	name: "fleet",
	factory: (pi) => {
		let registration: FleetSelfRegistration | undefined;

		const selfInfo = (ctx: ExtensionCommandContext): SelfSessionInfo => ({
			cwd: ctx.sessionManager.getCwd(),
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			label: ctx.sessionManager.getSessionName(),
		});

		/**
		 * A handle on the current session, or undefined when there is nothing worth
		 * backgrounding: an unsaved session has no file for the daemon to resume.
		 */
		const captureOutgoing = (ctx: ExtensionCommandContext): BackgroundableSession | undefined => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return undefined;
			const model = ctx.model;
			return {
				cwd: ctx.sessionManager.getCwd(),
				label: ctx.sessionManager.getSessionName(),
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
				// resumable from FleetView; it just is not running in parallel.
			}
		};

		pi.on("session_start", (_event, ctx) => {
			// pi's package loader gives each top-level extension file its own module
			// instance (loadExtensionModule's moduleCache: false), so branding's
			// setSharedTheme call never reaches fleet's separately-loaded copy of
			// _shared/theme.ts — every extension that needs it populates its own.
			setSharedTheme(ctx.ui.theme);
			if (!ctx.hasUI) return; // the roster is a TUI affordance
			registration?.stop();
			registration = new FleetSelfRegistration(new OrchestratorClient(), () =>
				selfInfo(ctx as ExtensionCommandContext),
			);
			registration.start();
		});

		pi.on("session_shutdown", () => {
			registration?.stop();
			registration = undefined;
		});

		pi.registerCommand("fleet", {
			description: "Manage every running and saved session",
			handler: async (_args, ctx) => {
				const model = ctx.model;
				await ctx.ui.custom<void>(
					(tui, _theme, _keybindings, done) => {
						const view = new FleetView({
							ui: tui,
							client: new OrchestratorClient(),
							appName: "pi",
							version: VERSION,
							model: model ? `${model.provider}/${model.id}` : undefined,
							spawnModel: model ? { provider: model.provider, id: model.id } : undefined,
							cwd: ctx.cwd,
							home: process.env.HOME ?? "",
							mascotLines: null,
							selfId: registration?.id,
							onClose: () => done(undefined),
							onJumpIn: (sessionFile) => {
								done(undefined);
								void (async () => {
									// Capture BEFORE the switch: switchSession disposes this session.
									const outgoing = captureOutgoing(ctx);
									await ctx.switchSession(sessionFile);
									// Re-register immediately so the just-opened session shows as
									// "(this session)" at once rather than after the next heartbeat.
									await registration?.refresh();
									await handOff(outgoing);
								})();
							},
							onCreateSession: (cwd, spawnModel, task) => {
								done(undefined);
								void (async () => {
									const outgoing = captureOutgoing(ctx);
									// pi's newSession() takes neither a working directory nor a model,
									// so a chosen cwd/model cannot be honoured from an extension. Say
									// so rather than open a session that quietly ignores the choice.
									const ignored: string[] = [];
									if (cwd && cwd !== ctx.cwd) ignored.push(`directory ${cwd}`);
									const chosen = spawnModel ? `${spawnModel.provider}/${spawnModel.id}` : undefined;
									const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
									if (chosen && chosen !== current) ignored.push(`model ${chosen}`);
									if (ignored.length > 0) {
										ctx.ui.notify(
											`New session opened here instead — pi's newSession() cannot set a ${ignored.join(" or ")}.`,
											"warning",
										);
									}
									await ctx.newSession({
										withSession: async (replaced) => {
											if (task.trim()) replaced.sendUserMessage(task);
										},
									});
									await registration?.refresh();
									await handOff(outgoing);
								})();
							},
							loadSavedSessions,
							loadHiddenSessions: () => loadHiddenSessions(getAgentDir()),
							hideSession: (sessionFile) => hideSession(getAgentDir(), sessionFile),
						});
						// FleetView loads its roster on show, not on construct — without this
						// the overlay opens empty and never polls.
						void view.onShow();
						return view as Component & { dispose?(): void };
					},
					{ overlay: true, overlayOptions: { width: "94%", maxHeight: "92%" } },
				);
			},
		});
	},
};

export default fleet.factory;
