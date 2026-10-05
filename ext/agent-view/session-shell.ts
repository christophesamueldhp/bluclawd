import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { setSharedTheme } from "../_shared/theme.ts";
import { AgentView, type PastSession } from "./agent-view.ts";
import type { AgentClipboard } from "./clipboard.ts";
import { ConversationView } from "./conversation-view.ts";
import type { OrchestratorClient } from "./orchestrator-client.ts";
import { labelFromTask, type ViewMode } from "./rows.ts";
import type { SessionController } from "./session-controller.ts";
export interface SessionShellOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	controller: SessionController;
	client: OrchestratorClient;
	cwd: string;
	home: string;
	version: string;
	onLocalAction: (action: string, text?: string) => void;
	model?: { provider: string; id: string };
	readClipboard?: () => Promise<AgentClipboard>;
	loadPastSessions?: (cwd: string) => Promise<PastSession[]>;
	loadViewMode?: () => ViewMode | undefined;
	saveViewMode?: (mode: ViewMode) => void;
}
export class SessionShell implements Component, Focusable {
	private readonly options: SessionShellOptions;
	private readonly conversation: ConversationView;
	private roster?: AgentView;
	private mode: "conversation" | "agents" = "conversation";
	private focus = false;
	private disposed = false;
	private lastSelected?: string;
	constructor(options: SessionShellOptions) {
		this.options = options;
		setSharedTheme(options.theme);
		this.lastSelected = options.controller.selected()?.instance.id;
		this.conversation = new ConversationView({ ...options, onAgents: () => this.showAgents() });
	}
	get focused() {
		return this.focus;
	}
	set focused(value: boolean) {
		this.focus = value;
		this.conversation.focused = value && this.mode === "conversation";
		if (this.roster) this.roster.focused = value && this.mode === "agents";
	}
	showAgents(): void {
		if (this.disposed) return;
		if (this.roster) {
			this.roster.dispose();
			this.roster = undefined;
		}
		const o = this.options;
		this.lastSelected = o.controller.selected()?.instance.id;
		this.roster = new AgentView({
			ui: o.tui,
			client: o.client,
			appName: "bluclawd",
			version: o.version,
			cwd: o.cwd,
			home: o.home,
			model: o.controller.selected()?.state.model ?? o.model,
			currentId: () => o.controller.selected()?.instance.id,
			onClose: () => this.showConversation(),
			onOpen: async (target, signal) => {
				const accepted = await o.controller.select(target, signal);
				if (accepted && !this.disposed) this.showConversation();
				return accepted;
			},
			onDeleted: (id) => {
				const current = o.controller.selected()?.instance.id ?? this.lastSelected;
				o.controller.forget(id);
				if (current === id) this.showConversation();
			},
			onCreateAndOpen: async (cwd, model, text, images) => {
				const instance = await o.client.spawn({ cwd, model, label: labelFromTask(text || "Image task") });
				if (!instance) return false;
				const attached = await o.controller.select({ instanceId: instance.id });
				if (!attached) return false;
				await o.controller.submit({ text, images });
				if (!this.disposed) this.showConversation();
				return true;
			},
			readClipboard: o.readClipboard,
			loadPastSessions: o.loadPastSessions,
			loadViewMode: o.loadViewMode,
			saveViewMode: o.saveViewMode,
		});
		this.mode = "agents";
		this.focused = this.focus;
		void this.roster.onShow();
		o.tui.requestRender();
	}
	showConversation(): void {
		if (this.disposed) return;
		this.roster?.dispose();
		this.roster = undefined;
		this.mode = "conversation";
		this.lastSelected = this.options.controller.selected()?.instance.id;
		this.focused = this.focus;
		this.conversation.refresh();
	}
	refresh(): void {
		if (this.disposed) return;
		if (this.options.controller.selected()) this.lastSelected = this.options.controller.selected()!.instance.id;
		this.conversation.refresh();
		if (this.roster) void this.roster.refresh();
		this.options.tui.requestRender();
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.mode === "agents") this.roster?.handleInput(data);
		else this.conversation.handleInput(data);
	}
	render(width: number): string[] {
		return this.mode === "agents" && this.roster ? this.roster.render(width) : this.conversation.render(width);
	}
	invalidate(): void {
		this.conversation.invalidate();
		this.roster?.invalidate();
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.roster?.dispose();
		this.roster = undefined;
		this.conversation.dispose();
	}
}
