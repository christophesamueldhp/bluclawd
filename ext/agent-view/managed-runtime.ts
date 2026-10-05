import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	RpcCommand,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { SessionTarget } from "../../daemon/view-types.ts";
import { VIEW_PROTOCOL_VERSION } from "../../daemon/view-types.ts";
import type { PastSession } from "./agent-view.ts";
import { bootstrapManagedSession, type ManagedUiState } from "./managed-state.ts";
import { OrchestratorClient } from "./orchestrator-client.ts";
import { loadViewMode, saveViewMode } from "./prefs.ts";
import { SessionController, type SessionControllerOptions } from "./session-controller.ts";
import { SessionShell } from "./session-shell.ts";
import { SessionViewClient } from "./view-client.ts";
export const MANAGED_BOOTSTRAP_COMMAND = "agent-view-bootstrap";
/** Only plain selection/drafts survive reload. All runtime resources are owned by this factory. */
export function createManagedRuntime(
	pi: ExtensionAPI,
	state: ManagedUiState,
	loadPast: (cwd: string) => Promise<PastSession[]>,
) {
	let controller: SessionController | undefined;
	let shell: SessionShell | undefined;
	let closeScreen: (() => void) | undefined;
	let offGate: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let starting = false;
	let flushWork: Promise<void> | undefined;
	let context: ExtensionCommandContext | undefined;
	let controllerOptions: SessionControllerOptions | undefined;
	const save = () => {
		if (controller) Object.assign(state, controller.exportState());
	};
	const dispose = () => {
		save();
		const old = closeScreen;
		closeScreen = undefined;
		controller?.dispose();
		controller = undefined;
		shell?.dispose();
		shell = undefined;
		offGate?.();
		offGate = undefined;
		clearTimeout(timer);
		old?.();
	};
	async function protocol(client: OrchestratorClient) {
		if (!(await client.ensureDaemon())) throw new Error("Agent daemon unavailable; input retained");
		const info = await client.getDaemonInfo();
		if (info.viewProtocol === VIEW_PROTOCOL_VERSION) return;
		if (
			(await client.list()).some(
				(row) => row.status === "online" || row.status === "starting" || row.status === "stopping",
			)
		)
			throw new Error(
				"Agent daemon needs a view-protocol upgrade; live sessions were not restarted. Finish/stop them and retry.",
			);
		const result = await client.restartDaemon();
		if (!result.restarted || (await client.getDaemonInfo()).viewProtocol !== VIEW_PROTOCOL_VERSION)
			throw new Error("Agent daemon does not support persistent views; upgrade and retry");
	}
	function flush(): Promise<void> {
		if (flushWork) return flushWork;
		if (!controller) return Promise.resolve();
		flushWork = Promise.resolve()
			.then(async () => {
				while (state.pendingInput.length && controller) {
					const draft = state.pendingInput.shift()!;
					await controller.submit(draft);
				}
			})
			.finally(() => {
				flushWork = undefined;
				save();
			});
		return flushWork;
	}
	async function local(action: string, text?: string) {
		const ctx = context;
		const view = shell;
		const owner = controller;
		if (!ctx || !view || !owner) return;
		try {
			if (action === "new") {
				if (controllerOptions && owner.selected()?.state.model)
					controllerOptions.model = owner.selected()!.state.model;
				owner.blank();
				view.showConversation();
				return;
			}
			if (action === "agents") {
				view.showAgents();
				return;
			}
			if (action === "quit") {
				save();
				ctx.shutdown();
				return;
			}
			if (action === "reload") {
				dispose();
				await ctx.reload();
				return;
			}
			if (action === "resume") {
				const argument = text?.replace(/^\s*\/\S+\s*/, "").trim();
				const sessions = await loadPast(ctx.cwd);
				const labels = sessions.map((session, i) => `${i + 1}. ${session.label}`);
				const choice = argument ? undefined : await view.choose("Saved sessions (view only)", labels);
				const target = argument ? { sessionFile: argument, cwd: ctx.cwd } : sessions[labels.indexOf(choice ?? "")];
				if (target) {
					await owner.select({ sessionFile: target.sessionFile, cwd: target.cwd });
					view.showConversation();
				}
				return;
			}
			if (action === "theme") {
				const names = ctx.ui.getAllThemes().map((theme) => theme.name);
				const arg = text?.replace(/^\s*\/\S+\s*/, "").trim();
				const selected = arg || (await view.choose("Theme", names));
				if (selected) {
					const result = ctx.ui.setTheme(selected);
					if (!result.success) throw new Error(result.error ?? "Theme unavailable");
					view.invalidate();
					view.refresh();
				}
				return;
			}
			if (action === "model") {
				let models = ctx.modelRegistry.getAvailable();
				if (owner.selected()) {
					const result = await owner.send({ type: "get_available_models" });
					if (!result.success || result.command !== "get_available_models")
						throw new Error("Model catalog unavailable");
					models = result.data.models;
				}
				const names = models.map((model) => model.provider + "/" + model.id);
				const selected = await view.choose("Execution owner model", names);
				const model = models[names.indexOf(selected ?? "")];
				if (model) {
					if (owner.selected()) {
						const result = await owner.send({ type: "set_model", provider: model.provider, modelId: model.id });
						if (result.success === false) throw new Error(result.error);
					} else if (controllerOptions) controllerOptions.model = { provider: model.provider, id: model.id };
				}
				return;
			}
			if (action === "settings") {
				const ready = owner.selected();
				if (!ready) {
					await view.choose("Settings require a selected session", ["Back"]);
					return;
				}
				const items = ["Toggle auto compaction", "Toggle steering mode", "Toggle follow-up mode"];
				const chosen = await view.choose("Selected owner settings", items);
				let command: RpcCommand | undefined;
				if (chosen === items[0])
					command = { type: "set_auto_compaction", enabled: !ready.state.autoCompactionEnabled };
				if (chosen === items[1])
					command = {
						type: "set_steering_mode",
						mode: ready.state.steeringMode === "all" ? "one-at-a-time" : "all",
					};
				if (chosen === items[2])
					command = {
						type: "set_follow_up_mode",
						mode: ready.state.followUpMode === "all" ? "one-at-a-time" : "all",
					};
				if (command) {
					const result = await owner.send(command);
					if (result.success === false) throw new Error(result.error);
				}
				return;
			}
			await view.choose("Persistent views · execution continues while navigating", [
				"← ← agents · Ctrl+Shift+A agents",
				"Esc deliberately stops selected work",
				"Ctrl+Alt+R reconnect · Ctrl+PgUp older history",
				"/new /resume /model /thinking /name /compact /export",
				"/tasks /bashes /rewind screens unavailable; tools remain available",
				"Quit/reload only detach; uncertain input is never replayed",
				"Back",
			]);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
	async function start(ctx: ExtensionCommandContext, initial?: SessionTarget) {
		context = ctx;
		const client = new OrchestratorClient();
		const previous = state.selectedId;
		controllerOptions = {
			client,
			views: new SessionViewClient(),
			cwd: ctx.cwd,
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			onChange: () => {
				save();
				shell?.refresh();
			},
		};
		controller = new SessionController(controllerOptions);
		controller.restoreDrafts(state.drafts);
		if (initial) await controller.select(initial);
		else if (previous) {
			const rows = await client.list();
			if (rows.some((row) => row.id === previous && row.status === "online"))
				await controller.select({ instanceId: previous });
			else ctx.ui.notify("Previous session is stopped; open agents to resume explicitly", "info");
		}
		const owner = controller;
		const lifetime = ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => {
				shell = new SessionShell({
					tui,
					theme,
					keybindings,
					controller: owner,
					client,
					cwd: ctx.cwd,
					home: process.env.HOME ?? "",
					version: VERSION,
					model: controllerOptions?.model,
					onLocalAction: (action, text) => {
						void local(action, text);
					},
					loadPastSessions: loadPast,
					loadViewMode: () => loadViewMode(getAgentDir()),
					saveViewMode: (mode) => saveViewMode(getAgentDir(), mode),
				});
				closeScreen = () => done();
				offGate?.();
				offGate = undefined;
				void flush();
				return shell;
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
		);
		void lifetime.then(
			() => {
				if (controller === owner) {
					dispose();
					ctx.shutdown();
				}
			},
			(error) => {
				if (controller === owner) {
					dispose();
					ctx.ui.notify(String(error), "error");
				}
			},
		);
		await flush();
	}
	return {
		sessionStart(ctx: ExtensionContext) {
			if (ctx.mode !== "tui") return;
			if (state.phase === "replacing") return;
			if (state.phase === "native") state.phase = "waiting";
			offGate?.();
			offGate = ctx.ui.onTerminalInput((data) => {
				if (shell) return;
				if (
					(state.phase === "waiting" || state.phase === "replacing") &&
					(matchesKey(data, "escape") || matchesKey(data, "ctrl+d"))
				)
					return { consume: true };
				if (
					(state.phase === "waiting" || state.phase === "replacing") &&
					matchesKey(data, "enter") &&
					ctx.ui.getEditorText().startsWith("/")
				) {
					state.pendingInput.push({ text: ctx.ui.getEditorText(), images: [] });
					ctx.ui.setEditorText("");
					return { consume: true };
				}
				return;
			});
			clearTimeout(timer);
			timer = setTimeout(
				() => pi.sendUserMessage("/" + MANAGED_BOOTSTRAP_COMMAND, { expandPromptTemplates: false }),
				0,
			);
		},
		async bootstrap(ctx: ExtensionCommandContext) {
			if (starting || controller) return;
			starting = true;
			try {
				const client = new OrchestratorClient();
				await protocol(client);
				if (state.phase === "managed") await start(ctx);
				else await bootstrapManagedSession(ctx, state, start);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				starting = false;
			}
		},
		input(event: InputEvent, ctx: ExtensionContext): InputEventResult | undefined {
			if (ctx.mode !== "tui") return;
			if (event.text.trim() === "/" + MANAGED_BOOTSTRAP_COMMAND) return;
			if (controller && state.phase === "managed") {
				state.pendingInput.push({ text: event.text, images: event.images ?? [] });
				void flush();
				return { action: "handled" };
			}
			if (state.phase === "waiting" || state.phase === "replacing" || state.phase === "managed") {
				state.pendingInput.push({ text: event.text, images: event.images ?? [] });
				return { action: "handled" };
			}
			return;
		},
		shutdown() {
			if (state.phase === "native") return false;
			if (state.phase === "replacing") return true;
			dispose();
			return true;
		},
		async agents(ctx: ExtensionCommandContext) {
			await this.bootstrap(ctx);
			shell?.showAgents();
		},
		dispose,
	};
}
