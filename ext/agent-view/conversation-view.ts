import {
	CustomEditor,
	getMarkdownTheme,
	type KeybindingsManager,
	type RpcCommand,
	type RpcResponse,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	type Component,
	CURSOR_MARKER,
	type Focusable,
	isKeyRelease,
	isKeyRepeat,
	Markdown,
	matchesKey,
	ScrollView,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { DisplayMessage, ManagedDraft, ViewMessage } from "../../daemon/view-types.ts";
import { type AgentClipboard, readAgentClipboard } from "./clipboard.ts";
import { createConversationDialog } from "./conversation-dialog.ts";
import { routeSessionCommand, type SessionCommandContext, stopSelectedSession } from "./session-commands.ts";
import type { SessionController } from "./session-controller.ts";
export interface ConversationViewOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	controller: SessionController;
	onAgents: () => void;
	onLocalAction: (action: string, text?: string) => void;
	readClipboard?: () => Promise<AgentClipboard>;
}
function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part?.type === "text" ? part.text : part?.type === "image" ? `[image: ${part.mimeType ?? "attachment"}]` : "",
		)
		.filter(Boolean)
		.join("\n");
}
function sameDraft(a: ManagedDraft, b: ManagedDraft) {
	return (
		a.text === b.text &&
		a.images.length === b.images.length &&
		a.images.every((image, i) => image.data === b.images[i]?.data && image.mimeType === b.images[i]?.mimeType)
	);
}
export class ConversationView implements Component, Focusable {
	private readonly options: ConversationViewOptions;
	private readonly editor: CustomEditor;
	private readonly scroll: ScrollView;
	private dialog?: ReturnType<typeof createConversationDialog>;
	private dialogKey?: string;
	private scope?: string;
	private focus = false;
	private disposed = false;
	private syncing = false;
	private revision = 0;
	private clipboardEpoch = 0;
	private lastDraft?: ManagedDraft;
	private leftArmed?: number;
	private leftTimer?: ReturnType<typeof setTimeout>;
	private expandedTools = false;
	private showThinking = false;
	private notice?: string;
	private inspection?: string;
	private commands: SessionCommandContext["commands"] = [];
	private older: ViewMessage[] = [];
	private readonly markdown = new Map<string, { text: string; component: Markdown }>();
	private readonly renderedKeys = new Set<string>();
	private title?: string;
	constructor(options: ConversationViewOptions) {
		this.options = options;
		const t = options.theme;
		this.editor = new CustomEditor(
			options.tui,
			{
				borderColor: (s) => t.fg("border", s),
				selectList: {
					selectedPrefix: (s) => t.fg("accent", s),
					selectedText: (s) => t.fg("accent", s),
					description: (s) => t.fg("muted", s),
					scrollInfo: (s) => t.fg("dim", s),
					noMatch: (s) => t.fg("muted", s),
				},
			},
			options.keybindings,
		);
		this.editor.onChange = () => {
			if (this.syncing || this.disposed) return;
			this.revision++;
			options.controller.setDraft({ ...options.controller.draft(), text: this.editor.getExpandedText() });
			this.refresh();
		};
		this.editor.onSubmit = (text) => {
			void this.submit(text);
		};
		this.editor.onPasteImage = () => {
			void this.paste();
		};
		this.editor.onEscape = () => {
			void this.stop();
		};
		this.editor.onCtrlD = () => options.onLocalAction("quit");
		for (const action of ["new", "resume"] as const)
			this.editor.onAction(action === "new" ? "app.session.new" : "app.session.resume", () =>
				options.onLocalAction(action),
			);
		this.editor.onAction("app.model.select", () => options.onLocalAction("model"));
		this.editor.onAction("app.message.followUp", () => {
			void this.submit(this.editor.getExpandedText());
		});
		this.editor.onAction("app.model.cycleForward", () => {
			void this.rpc({ type: "cycle_model" });
		});
		this.editor.onAction("app.thinking.cycle", () => {
			void this.rpc({ type: "cycle_thinking_level" });
		});
		this.scroll = new ScrollView(
			{
				render: (width) => this.renderBody(width),
				invalidate: () => {
					this.markdown.clear();
				},
			},
			{ follow: "end", scrollbar: "hidden" },
		);
		this.refresh();
	}
	get focused() {
		return this.focus;
	}
	set focused(value: boolean) {
		this.focus = value;
		this.editor.focused = value && !this.dialog;
		if (this.dialog) this.dialog.focused = value;
	}
	private currentScope() {
		const ready = this.options.controller.selected();
		return ready ? `${ready.instance.id}:${ready.generation}` : "$blank";
	}
	private synchronize(): void {
		if (this.disposed) return;
		const controller = this.options.controller;
		const scope = this.currentScope();
		if (scope !== this.scope) {
			this.scope = scope;
			this.revision++;
			this.clipboardEpoch++;
			this.older = [];
			this.inspection = undefined;
			this.notice = undefined;
			this.commands = [];
			this.markdown.clear();
			this.scroll.scrollToEnd();
			this.dialog?.dispose();
			this.dialog = undefined;
			this.dialogKey = undefined;
			void this.loadCommands(scope);
		}
		const draft = controller.draft();
		if (!this.lastDraft || !sameDraft(this.lastDraft, draft)) {
			this.revision++;
			this.lastDraft = draft;
			this.syncing = true;
			this.editor.setText(stripTerminalSequences(draft.text));
			this.syncing = false;
		}
		const request = controller.projection()?.pendingDialog;
		const dialogKey = request ? `${scope}:${request.id}` : undefined;
		if (dialogKey !== this.dialogKey) {
			this.dialog?.dispose();
			this.dialog = undefined;
			this.dialogKey = dialogKey;
			if (request && dialogKey && controller.connectionState() !== "disconnected") {
				this.dialog = createConversationDialog(request, {
					theme: this.options.theme,
					tui: this.options.tui,
					onAnswer: (response) => {
						if (this.disposed || this.currentScope() !== scope || this.dialogKey !== dialogKey) return;
						void controller.answer(response).then((ok) => {
							if (this.disposed || this.currentScope() !== scope) return;
							if (!ok) this.notice = "Answer was not accepted; reconnect to inspect the pending question";
							this.refresh();
						});
					},
				});
			}
		}
		this.focused = this.focus;
		const title = controller.projection()?.title;
		if (title !== this.title) {
			this.title = title;
			if (title) this.options.tui.terminal.setTitle(stripTerminalSequences(title));
		}
	}
	refresh(): void {
		if (this.disposed) return;
		this.synchronize();
		this.options.tui.requestRender();
	}
	invalidate(): void {
		this.markdown.clear();
		this.editor.invalidate();
		this.dialog?.invalidate();
	}
	private async loadCommands(scope: string) {
		if (!this.options.controller.selected()) return;
		try {
			const response = await this.options.controller.send({ type: "get_commands" });
			if (
				this.disposed ||
				scope !== this.currentScope() ||
				response.success === false ||
				response.command !== "get_commands" ||
				!("data" in response)
			)
				return;
			this.commands = response.data.commands;
			this.editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(
					response.data.commands.map((command) => ({ name: command.name, description: command.description })),
					this.options.controller.selected()!.instance.cwd,
				),
			);
			this.refresh();
		} catch {
			/* Disconnected/archived views remain readable. */
		}
	}
	async submit(text: string) {
		if (this.disposed) return;
		const controller = this.options.controller;
		const draft = { ...controller.draft(), text };
		controller.setDraft(draft);
		const p = controller.projection();
		const route = routeSessionCommand(text, { busy: !!p && (p.running || p.compacting), commands: this.commands });
		this.notice = undefined;
		if (route.type === "unavailable") {
			this.notice = route.message;
			this.refresh();
			return;
		}
		if (route.type === "local") {
			controller.setDraft({ ...draft, text: "" });
			if (route.action === "agents") this.options.onAgents();
			else this.options.onLocalAction(route.action, text);
			this.refresh();
			return;
		}
		if (route.type === "prompt") {
			await controller.submit({ ...draft, text: route.message });
			this.refresh();
			return;
		}
		const scope = this.currentScope();
		const revision = this.revision;
		const command = route.command;
		if (command.type === "steer" && draft.images.length) command.images = draft.images;
		const response = await this.rpc(command);
		if (response?.success && scope === this.currentScope() && revision === this.revision)
			controller.setDraft({ ...controller.draft(), text: "" });
		this.refresh();
	}
	private async rpc(command: RpcCommand): Promise<RpcResponse | undefined> {
		const scope = this.currentScope();
		try {
			const response = await this.options.controller.send(command);
			if (this.disposed || this.currentScope() !== scope) return response;
			if (response.success === false) this.notice = response.error;
			else if (response.command === "get_state" && "data" in response) {
				const state = response.data;
				this.inspection = [
					`Model: ${state.model?.provider ?? "unknown"}/${state.model?.id ?? "unknown"}`,
					`Thinking: ${state.thinkingLevel}`,
					`Messages: ${state.messageCount}`,
					`Streaming: ${state.isStreaming} · Compacting: ${state.isCompacting}`,
					`Session: ${state.sessionName ?? state.sessionId}`,
				].join("\n");
			} else if (response.command === "get_session_stats" && "data" in response)
				this.inspection = JSON.stringify(response.data, null, 2);
			else if (response.command === "export_html" && "data" in response)
				this.notice = `Exported: ${response.data.path}`;
			this.refresh();
			return response;
		} catch (error) {
			if (!this.disposed && this.currentScope() === scope) {
				this.notice = error instanceof Error ? error.message : String(error);
				this.refresh();
			}
			return undefined;
		}
	}
	private async stop() {
		const scope = this.currentScope();
		try {
			await stopSelectedSession(this.options.controller);
		} catch (error) {
			if (scope === this.currentScope()) this.notice = error instanceof Error ? error.message : String(error);
		}
		this.refresh();
	}
	private async paste() {
		const scope = this.currentScope();
		const revision = this.revision;
		const epoch = ++this.clipboardEpoch;
		const draft = this.options.controller.draft();
		try {
			const clip = await (this.options.readClipboard ?? readAgentClipboard)();
			if (
				this.disposed ||
				scope !== this.currentScope() ||
				revision !== this.revision ||
				epoch !== this.clipboardEpoch ||
				!sameDraft(draft, this.options.controller.draft())
			)
				return;
			if (clip.image) this.options.controller.setDraft({ ...draft, images: [...draft.images, clip.image] });
			else if (clip.text) this.editor.insertTextAtCursor(stripTerminalSequences(clip.text));
			this.refresh();
		} catch (error) {
			if (!this.disposed && scope === this.currentScope()) {
				this.notice = error instanceof Error ? error.message : String(error);
				this.refresh();
			}
		}
	}
	async loadOlder(): Promise<void> {
		const scope = this.currentScope();
		try {
			const page = await this.options.controller.history();
			if (this.disposed || scope !== this.currentScope()) return;
			const ids = new Set(this.older.map((message) => message.entryId ?? message.key));
			this.older = [
				...page.messages.filter((message) => !ids.has(message.entryId ?? message.key)),
				...this.older,
			].slice(0, 200);
			this.scroll.scrollToStart();
			this.refresh();
		} catch (error) {
			if (scope === this.currentScope()) {
				this.notice = error instanceof Error ? error.message : String(error);
				this.refresh();
			}
		}
	}
	handleInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		const controller = this.options.controller;
		const kb = this.options.keybindings;
		if (matchesKey(data, "ctrl+shift+a")) {
			this.options.onAgents();
			return;
		}
		if (
			!this.dialog &&
			matchesKey(data, "left") &&
			!this.editor.getExpandedText() &&
			!controller.draft().images.length
		) {
			if (isKeyRepeat(data)) return;
			const now = Date.now();
			if (this.leftArmed !== undefined && now - this.leftArmed <= 2000) {
				this.leftArmed = undefined;
				clearTimeout(this.leftTimer);
				this.options.onAgents();
			} else {
				this.leftArmed = now;
				clearTimeout(this.leftTimer);
				this.leftTimer = setTimeout(() => {
					this.leftArmed = undefined;
					this.refresh();
				}, 2000);
			}
			this.refresh();
			return;
		}
		this.leftArmed = undefined;
		clearTimeout(this.leftTimer);
		if (this.dialog) {
			this.dialog.handleInput?.(data);
			this.refresh();
			return;
		}
		if (kb.matches(data, "app.tools.expand")) {
			this.expandedTools = !this.expandedTools;
			this.invalidate();
			this.refresh();
			return;
		}
		if (kb.matches(data, "app.thinking.toggle")) {
			this.showThinking = !this.showThinking;
			this.invalidate();
			this.refresh();
			return;
		}
		if (matchesKey(data, "ctrl+pageUp")) {
			void this.loadOlder();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
			this.refresh();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
			this.refresh();
			return;
		}
		if (matchesKey(data, "ctrl+end")) {
			this.scroll.scrollToEnd();
			this.refresh();
			return;
		}
		if (matchesKey(data, "ctrl+alt+r")) {
			void controller.reconnect();
			return;
		}

		if (matchesKey(data, "backspace") && !this.editor.getExpandedText() && controller.draft().images.length) {
			const draft = controller.draft();
			controller.setDraft({ ...draft, images: draft.images.slice(0, -1) });
			this.refresh();
			return;
		}
		this.revision++;
		this.editor.handleInput(data);
		this.refresh();
	}
	private md(key: string, text: string, width: number): string[] {
		this.renderedKeys.add(key);
		const safe = stripTerminalSequences(text);
		let cached = this.markdown.get(key);
		if (!cached) {
			cached = { text: safe, component: new Markdown(safe, 0, 0, getMarkdownTheme()) };
			this.markdown.set(key, cached);
		} else if (cached.text !== safe) {
			cached.text = safe;
			cached.component.setText(safe);
		}
		return cached.component.render(width);
	}
	private messageText(message: DisplayMessage): string {
		const m = message as unknown as Record<string, unknown>;
		let text = textParts(m.content);
		if (message.role === "assistant") {
			if (this.showThinking)
				text =
					message.content
						.filter((part) => part.type === "thinking")
						.map((part) => (part.type === "thinking" ? part.thinking : ""))
						.filter(Boolean)
						.join("\n") +
					"\n" +
					text;
			if (message.errorMessage) text += `\n${message.errorMessage}`;
		}
		if (!text && typeof m.summary === "string") text = m.summary;
		if (!text && typeof m.output === "string") text = m.output;
		if (message.role === "toolResult" && !this.expandedTools) text = text.trim().split("\n").at(-1) ?? "";
		return text;
	}
	private renderBody(width: number): string[] {
		const p = this.options.controller.projection();
		this.renderedKeys.clear();
		const lines: string[] = [];
		if (!p) return [this.options.theme.fg("dim", "Write a prompt to start a daemon-owned conversation")];
		const liveIds = new Set(p.messages.map((message) => message.entryId ?? message.key));
		for (const entry of [
			...this.older.filter((message) => !liveIds.has(message.entryId ?? message.key)),
			...p.messages,
		]) {
			if (this.older.length && entry === p.messages[0])
				lines.push(this.options.theme.fg("dim", "Saved archive page above · live conversation below"), "");
			const m = entry.message as unknown as Record<string, unknown>;
			if (m.role === "system" || m.display === false) continue;
			const role = String(m.role ?? "message");
			lines.push(
				this.options.theme.fg(role === "user" ? "accent" : "muted", role),
				...this.md(entry.key, this.messageText(entry.message), width),
				"",
			);
		}
		if (p.partial)
			lines.push(
				this.options.theme.fg("muted", "assistant · streaming"),
				...this.md("partial", this.messageText(p.partial), width),
				"",
			);
		for (const tool of Object.values(p.tools)) {
			const result = tool.partialResult as { content?: unknown; output?: string } | undefined;
			const output =
				typeof tool.partialResult === "string"
					? tool.partialResult
					: textParts(result?.content) || result?.output || "";
			const title = `${tool.parentToolCallId ? "↳ " : ""}${tool.toolName} · running`;
			lines.push(this.options.theme.fg("toolTitle", title));
			const content = this.expandedTools
				? `${JSON.stringify(tool.args, null, 2)}\n${output}`
				: (output.trim().split("\n").at(-1) ?? "");
			lines.push(...this.md(`tool:${tool.toolCallId}`, content, width), "");
		}
		if (this.inspection) lines.push(...this.md("inspection", this.inspection, width));
		for (const key of this.markdown.keys()) if (!this.renderedKeys.has(key)) this.markdown.delete(key);
		return lines.length ? lines : [this.options.theme.fg("dim", "No messages yet")];
	}
	render(width: number): string[] {
		if (this.disposed) return [];
		this.synchronize();
		const w = Math.max(1, width);
		const controller = this.options.controller;
		const ready = controller.selected();
		const p = controller.projection();
		const theme = this.options.theme;
		const title = ready ? (ready.instance.label ?? ready.state.sessionName ?? ready.instance.id) : "Blank composer";
		const rows = this.options.tui.terminal.rows || 24;
		const header = [
			theme.fg("accent", stripTerminalSequences(title).replace(/[\r\n]+/g, " ")),
			theme.fg(
				"dim",
				`${controller.connectionState()} · ${p?.activity ?? "idle"}${ready?.state.model ? ` · ${ready.state.model.id}` : ""}`,
			),
		];
		if (rows < 10) header.splice(1);
		const editor = this.editor.render(w);
		const widgets = (placement: string) =>
			Object.values(p?.widgets ?? {})
				.filter((widget) => widget.placement === placement)
				.flatMap((widget) => widget.lines)
				.slice(0, 2)
				.flatMap((line) => wrapTextWithAnsi(stripTerminalSequences(line), w))
				.slice(0, 3);
		const feedback = this.notice ?? controller.notice() ?? p?.errors.at(-1);
		let footer = [
			...widgets("aboveEditor"),
			...(this.dialog?.render(w) ?? []),
			...editor,
			...(controller.draft().images.length
				? [theme.fg("muted", `${controller.draft().images.length} image(s) attached`)]
				: []),
			...widgets("belowEditor"),
			...(feedback ? wrapTextWithAnsi(theme.fg("warning", stripTerminalSequences(feedback)), w).slice(0, 3) : []),
			theme.fg(
				"dim",
				this.leftArmed !== undefined ? "← again for agents" : "← ← agents · Esc stop · Ctrl+PgUp older",
			),
			...(p && Object.keys(p.statuses).length
				? [
						truncateToWidth(
							theme.fg("dim", Object.values(p.statuses).map(stripTerminalSequences).join(" · ")),
							w,
							"",
						),
					]
				: []),
		];
		if (this.dialog)
			footer = [
				...this.dialog.render(w),
				...(rows >= 16 ? [theme.fg("dim", "Draft preserved · Ctrl+Shift+A agents")] : []),
			];
		const footerBudget = Math.max(1, rows - header.length - 1);
		if (footer.length > footerBudget) {
			const cursor = footer.findIndex((line) => line.includes(CURSOR_MARKER));
			const start = Math.max(0, Math.min(footer.length - footerBudget, cursor < 0 ? 0 : cursor - footerBudget + 1));
			footer = footer.slice(start, start + footerBudget);
		}
		const body = this.scroll.render(w);
		const height = Math.max(1, rows - header.length - footer.length);
		this.scroll.updateLayout(body.length, height, () => this.options.tui.requestRender());
		const visible = body.slice(this.scroll.scrollTop, this.scroll.scrollTop + height);
		// Reserve the entire body viewport even before the first message arrives.
		// Otherwise Pi centers this short overlay and exposes the idle host's editor.
		return [...header, ...visible, ...Array(Math.max(0, height - visible.length)).fill(""), ...footer].map((line) =>
			truncateToWidth(line, w, ""),
		);
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clipboardEpoch++;
		clearTimeout(this.leftTimer);
		this.dialog?.dispose();
		this.dialog = undefined;
		this.editor.focused = false;
		this.markdown.clear();
	}
}
