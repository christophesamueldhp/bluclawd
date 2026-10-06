import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ManagedDraft } from "../../daemon/view-types.ts";
import { setSharedTheme } from "../_shared/theme.ts";
import { AgentView, type PastSession } from "./agent-view.ts";
import type { AgentClipboard } from "./clipboard.ts";
import { createConversationDialog } from "./conversation-dialog.ts";
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
	private localDialog?: ReturnType<typeof createConversationDialog>;
	private finishLocal?: (value?: string) => void;
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
		if (this.localDialog) this.localDialog.focused = value;
		this.conversation.focused = value && this.mode === "conversation";
		if (this.roster) this.roster.focused = value && this.mode === "agents";
	}
	async submit(draft: ManagedDraft): Promise<void> {
		if (this.disposed) return;
		this.options.controller.setDraft(draft);
		await this.conversation.submit(draft.text);
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
	choose(title: string, choices: string[]): Promise<string | undefined> {
		this.finishLocal?.();
		return new Promise((resolve) => {
			this.finishLocal = (value) => {
				this.localDialog?.dispose();
				this.localDialog = undefined;
				this.finishLocal = undefined;
				this.focused = this.focus;
				this.options.tui.requestRender();
				resolve(value);
			};
			this.localDialog = createConversationDialog(
				{ type: "extension_ui_request", method: "select", id: "local", title, options: choices },
				{
					theme: this.options.theme,
					tui: this.options.tui,
					onAnswer: (answer) => this.finishLocal?.("value" in answer ? answer.value : undefined),
				},
			);
			this.localDialog.focused = this.focus;
			this.options.tui.requestRender();
		});
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.localDialog) {
			this.localDialog.handleInput?.(data);
			this.options.tui.requestRender();
			return;
		}
		if (this.mode === "agents") this.roster?.handleInput(data);
		else this.conversation.handleInput(data);
	}
	render(width: number): string[] {
		const rows = Math.max(1, this.options.tui.terminal.rows || 24);
		const lines = this.localDialog
			? this.localDialog.render(width)
			: this.mode === "agents" && this.roster
				? this.roster.render(width)
				: this.conversation.render(width);
		// Every screen owns the full viewport, including short local dialogs.
		const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		const start = Math.max(0, Math.min(lines.length - rows, cursor < 0 ? 0 : cursor - rows + 1));
		const visible = lines.slice(start, start + rows);
		return [...visible, ...Array(rows - visible.length).fill("")];
	}
	invalidate(): void {
		this.conversation.invalidate();
		this.roster?.invalidate();
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.finishLocal?.();
		this.roster?.dispose();
		this.roster = undefined;
		this.conversation.dispose();
	}
}
