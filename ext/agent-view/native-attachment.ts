/** Live daemon conversation, composed from Pi's own message, tool, editor and dialog components. */
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLocalBashOperations,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	getMarkdownTheme,
	getSelectListTheme,
	type KeybindingsManager,
	type RpcCommand,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcSessionState,
	type SessionEntry,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type Focusable, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { textOf } from "../../daemon/session-state.ts";
import { theme } from "../_shared/theme.ts";
import { createClaudeBashTool } from "../background-bash/bash-tool.ts";
import { readAgentClipboard } from "./clipboard.ts";
import type { InstanceSummary, OrchestratorClient } from "./orchestrator-client.ts";
import type { Attachment } from "./rpc-attachment.ts";

type Message = Extract<SessionEntry, { type: "message" }>["message"];

/**
 * The renderers this window would draw the worker's tools with: pi draws a tool it has no
 * definition for as raw JSON. Only rendering is used; nothing here executes.
 */
function toolRenderers(cwd: string): Record<string, ToolDefinition> {
	return {
		bash: createClaudeBashTool({
			cwd,
			operations: createLocalBashOperations(),
			sendMessage: () => {},
			isMain: false,
		}),
		read: createReadToolDefinition(cwd) as unknown as ToolDefinition,
		edit: createEditToolDefinition(cwd) as unknown as ToolDefinition,
		write: createWriteToolDefinition(cwd) as unknown as ToolDefinition,
		grep: createGrepToolDefinition(cwd) as unknown as ToolDefinition,
		find: createFindToolDefinition(cwd) as unknown as ToolDefinition,
		ls: createLsToolDefinition(cwd) as unknown as ToolDefinition,
	};
}
type Dialog = Component & { handleInput(data: string): void; dispose?(): void; focused?: boolean };

export class NativeAttachment implements Component, Focusable {
	focused = true;
	private readonly editor: Editor;
	private connection?: Attachment;
	private closed = false;
	private ready = false;
	private pendingEvents: AgentSessionEvent[] = [];
	private readonly ui: TUI;
	private readonly client: OrchestratorClient;
	private readonly instance: InstanceSummary;
	private readonly detach: () => void;
	private readonly keybindings: KeybindingsManager;
	private state?: RpcSessionState;
	private components: Component[] = [];
	private readonly messages = new Map<string, Component>();
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private renderers: Record<string, ToolDefinition> | undefined;
	private dialog?: Dialog;
	private dialogId?: string;
	private scroll = 0;
	private expanded = false;
	private notice = "Connecting…";
	private sending = false;
	private images: ImageContent[] = [];
	private draftVersion = 0;
	private pasting = false;

	constructor(
		ui: TUI,
		client: OrchestratorClient,
		instance: InstanceSummary,
		detach: () => void,
		keybindings: KeybindingsManager,
	) {
		this.ui = ui;
		this.client = client;
		this.instance = instance;
		this.detach = detach;
		this.keybindings = keybindings;
		this.editor = new Editor(ui, {
			borderColor: (text) => theme.fg("border", text),
			selectList: getSelectListTheme(),
		});
		this.editor.onSubmit = (text) => void this.submit(text);
	}

	async connect(): Promise<void> {
		const connection = await this.client.attach(
			this.instance.id,
			(event) => {
				if (this.closed) return;
				if (!this.ready) this.pendingEvents.push(event);
				else this.event(event);
			},
			(request) => {
				if (!this.closed) this.uiRequest(request);
			},
			(error) => {
				if (!this.closed) {
					this.notice = `${error.message} — ← returns to agents`;
					this.editor.disableSubmit = true;
					this.render_();
				}
			},
		);
		if (this.closed) return connection.close();
		this.connection = connection;
		try {
			await this.refreshState();
			const response = await connection.request({ type: "get_entries" });
			if (this.closed) return;
			if (response.success && response.command === "get_entries") {
				// Follow the active branch, rather than rendering abandoned forks alongside it.
				const byId = new Map(response.data.entries.map((entry) => [entry.id, entry]));
				const branch: SessionEntry[] = [];
				let id = response.data.leafId;
				const visited = new Set<string>();
				while (id && !visited.has(id)) {
					visited.add(id);
					const entry = byId.get(id);
					if (!entry) break;
					branch.unshift(entry);
					id = entry.parentId;
				}
				for (const entry of branch) {
					if (entry.type === "message") this.message(entry.message);
					else if (entry.type === "compaction")
						this.components.push(
							new CompactionSummaryMessageComponent({
								role: "compactionSummary",
								summary: entry.summary,
								tokensBefore: entry.tokensBefore,
								timestamp: Date.parse(entry.timestamp),
							}),
						);
					else if (entry.type === "branch_summary")
						this.components.push(
							new BranchSummaryMessageComponent({
								role: "branchSummary",
								summary: entry.summary,
								fromId: entry.fromId,
								timestamp: Date.parse(entry.timestamp),
							}),
						);
					else if (entry.type === "custom_message" && entry.display)
						this.message({ role: "custom", ...entry, timestamp: Date.parse(entry.timestamp) });
				}
			} else throw new Error("Daemon did not return the session transcript");
			this.ready = true;
			for (const event of this.pendingEvents) this.event(event);
			this.pendingEvents = [];
			this.notice = "";
			this.render_();
		} catch (error) {
			this.close();
			throw error;
		}
	}

	private render_(): void {
		if (!this.closed) this.ui.requestRender();
	}

	update(instances: InstanceSummary[]): void {
		const instance = instances.find((row) => row.id === this.instance.id);
		if (!this.closed && instance && (instance.status === "stopped" || instance.status === "error")) {
			this.notice = instance.detail ?? "Session stopped — ← returns to agents";
			if (this.state) this.state.isStreaming = false;
			this.editor.disableSubmit = true;
			this.dialog?.dispose?.();
			this.dialog = undefined;
			this.dialogId = undefined;
			this.render_();
		}
	}

	private async refreshState(): Promise<void> {
		const response = await this.connection?.request({ type: "get_state" });
		if (!this.closed && response?.success && response.command === "get_state") this.state = response.data;
	}

	private message(message: Message, streaming = false): void {
		const key = `${message.role}:${message.timestamp}`;
		if (message.role === "assistant") {
			let component = this.messages.get(key) as AssistantMessageComponent | undefined;
			if (!component) {
				component = new AssistantMessageComponent(undefined, true, getMarkdownTheme());
				this.messages.set(key, component);
				this.components.push(component);
			}
			component.updateContent(message as AssistantMessage, streaming);
			for (const block of message.content) {
				if (block.type === "toolCall") {
					const tool = this.tool(block.id, block.name, block.arguments);
					tool.updateArgs(block.arguments);
					if (!streaming) tool.setArgsComplete();
				}
			}
		} else if (message.role === "toolResult") {
			this.tool(message.toolCallId, message.toolName, {}).updateResult(message);
		} else if (message.role === "user" && !this.messages.has(key)) {
			const content = typeof message.content === "string" ? message.content : textOf(message.content);
			const component = new UserMessageComponent(content || "[Image]", getMarkdownTheme());
			this.messages.set(key, component);
			this.components.push(component);
		} else if (message.role === "custom" && message.display && !this.messages.has(key)) {
			const component = new CustomMessageComponent(message);
			this.messages.set(key, component);
			this.components.push(component);
		}
	}

	private tool(id: string, name: string, args: unknown): ToolExecutionComponent {
		let tool = this.tools.get(id);
		if (!tool) {
			this.renderers ??= toolRenderers(this.instance.cwd);
			tool = new ToolExecutionComponent(name, id, args, undefined, this.renderers[name], this.ui, this.instance.cwd);
			tool.setExpanded(this.expanded);
			this.tools.set(id, tool);
			this.components.push(tool);
		}
		return tool;
	}

	private event(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
			case "message_end":
				this.message(event.message, event.type !== "message_end");
				break;
			case "tool_execution_start":
				this.tool(event.toolCallId, event.toolName, event.args).markExecutionStarted();
				break;
			case "tool_execution_update":
				this.tool(event.toolCallId, event.toolName, event.args).updateResult(
					{ ...event.partialResult, isError: false },
					true,
				);
				break;
			case "tool_execution_end":
				this.tool(event.toolCallId, event.toolName, {}).updateResult({ ...event.result, isError: event.isError });
				break;
			case "agent_start":
				if (this.state) this.state.isStreaming = true;
				break;
			case "queue_update":
				if (this.state) this.state.pendingMessageCount = event.steering.length + event.followUp.length;
				break;
			case "agent_settled":
				if (this.state) this.state.isStreaming = false;
				this.dialog?.dispose?.();
				this.dialog = undefined;
				this.dialogId = undefined;
				break;
		}
		this.render_();
	}

	private uiRequest(request: RpcExtensionUIRequest): void {
		const answer = (value: Record<string, unknown>): void => {
			if (this.dialogId !== request.id || this.closed) return;
			this.connection?.answer({ type: "extension_ui_response", id: request.id, ...value } as RpcExtensionUIResponse);
			this.dialog?.dispose?.();
			this.dialog = undefined;
			this.dialogId = undefined;
			this.render_();
		};
		const cancel = () => answer({ cancelled: true });
		switch (request.method) {
			case "select":
			case "confirm": {
				this.dialog?.dispose?.();
				this.dialogId = request.id;
				const confirm = request.method === "confirm";
				this.dialog = new ExtensionSelectorComponent(
					confirm ? `${request.title}\n${request.message}` : request.title,
					confirm ? ["Yes", "No"] : request.options,
					(value) => answer(confirm ? { confirmed: value === "Yes" } : { value }),
					cancel,
					{ tui: this.ui, timeout: request.timeout },
				);
				break;
			}
			case "input":
				this.dialog?.dispose?.();
				this.dialogId = request.id;
				this.dialog = new ExtensionInputComponent(
					request.title,
					request.method === "input" ? request.placeholder : undefined,
					(value) => answer({ value }),
					cancel,
					{ tui: this.ui },
				);
				this.dialog.focused = true;
				break;
			case "editor": {
				this.dialog?.dispose?.();
				this.dialogId = request.id;
				// ExtensionEditorComponent uses the same multiline editor and external-editor action as Pi.
				this.dialog = new ExtensionEditorComponent(
					this.ui,
					this.keybindings,
					request.title,
					request.prefill,
					(value) => answer({ value }),
					cancel,
				);
				this.dialog.focused = true;
				break;
			}
			case "notify":
				this.notice = request.message;
				break;
			case "set_editor_text":
				this.editor.setText(request.text);
				break;
		}
		this.render_();
	}

	private async submit(text: string): Promise<void> {
		text = text.trim();
		if (this.sending || (!text && !this.images.length) || !this.ready) return;
		if (text === "/exit" || text === "/agent-view") return this.detach();
		this.sending = true;
		const images = [...this.images];
		try {
			let command: RpcCommand;
			if (text === "/stop") command = { type: "abort" };
			else if (/^\/compact(?:\s|$)/.test(text))
				command = { type: "compact", customInstructions: text.slice(8).trim() || undefined };
			else if (/^\/name\s/.test(text)) command = { type: "set_session_name", name: text.slice(6).trim() };
			else if (/^\/model\s/.test(text)) {
				const [provider, ...parts] = text.slice(7).trim().split("/");
				if (!parts.length) throw new Error("Usage: /model provider/model");
				command = { type: "set_model", provider, modelId: parts.join("/") };
			} else
				command = {
					type: "prompt",
					message: text,
					images: images.length ? images : undefined,
					streamingBehavior: "followUp",
				};
			await this.connection?.request(command);
			if (this.closed) return;
			this.editor.addToHistory(text);
			this.editor.setText("");
			this.images = [];
			this.draftVersion++;
			this.scroll = 0;
			this.notice = "";
			await this.refreshState();
		} catch (error) {
			if (!this.closed) this.notice = error instanceof Error ? error.message : String(error);
		} finally {
			this.sending = false;
			this.render_();
		}
	}

	private async paste(): Promise<void> {
		if (this.pasting) return;
		this.pasting = true;
		const version = this.draftVersion;
		try {
			const clipboard = await readAgentClipboard();
			if (this.closed || version !== this.draftVersion) return;
			if (clipboard.image) this.images.push(clipboard.image);
			else if (clipboard.text) this.editor.handleInput(`\x1b[200~${clipboard.text}\x1b[201~`);
		} finally {
			this.pasting = false;
			this.render_();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+z") || (!this.editor.getText() && !this.images.length && matchesKey(data, "left"))) {
			this.detach();
			return;
		}
		if (this.dialog) {
			this.dialog.handleInput(data);
			return;
		}
		if (matchesKey(data, "pageUp")) this.scroll += Math.max(1, this.ui.terminal.rows - 10);
		else if (matchesKey(data, "pageDown"))
			this.scroll = Math.max(0, this.scroll - Math.max(1, this.ui.terminal.rows - 10));
		else if (matchesKey(data, "ctrl+o")) {
			this.expanded = !this.expanded;
			for (const tool of this.tools.values()) tool.setExpanded(this.expanded);
		} else if (matchesKey(data, "ctrl+v"))
			void this.paste().catch((error) => {
				this.notice = String(error);
				this.render_();
			});
		else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.state?.isStreaming)
				void this.connection?.request({ type: "abort" }).catch((error) => {
					this.notice = String(error);
					this.render_();
				});
			else this.detach();
		} else this.editor.handleInput(data);
		this.render_();
	}

	render(width: number): string[] {
		this.editor.focused = this.focused && !this.dialog;
		const editor = this.dialog?.render(width) ?? this.editor.render(width);
		const model = this.state?.model;
		const footer = [
			...(this.notice ? [theme.fg("warning", this.notice)] : []),
			...(this.images.length ? [theme.fg("dim", `${this.images.length} image(s) attached`)] : []),
			...editor,
			truncateToWidth(theme.fg("dim", this.instance.cwd.replace(process.env.HOME ?? "\0", "~")), width),
			truncateToWidth(
				theme.fg(
					"dim",
					`${model?.name ?? model?.id ?? ""} ${this.state?.thinkingLevel ?? ""} · ← for agents${this.state?.isStreaming ? " · working" : ""}${this.state?.pendingMessageCount ? ` · ${this.state.pendingMessageCount} queued` : ""}`,
				),
				width,
			),
		];
		const height = Math.max(1, this.ui.terminal.rows - footer.length);
		const lines = this.components.flatMap((component) => component.render(width));
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - height));
		const end = Math.max(0, lines.length - this.scroll);
		const visible = lines.slice(Math.max(0, end - height), end);
		return [...visible, ...Array(Math.max(0, height - visible.length)).fill(""), ...footer].slice(
			0,
			this.ui.terminal.rows,
		);
	}

	invalidate(): void {
		for (const component of this.components) component.invalidate();
		this.editor.invalidate();
	}

	close(): void {
		this.closed = true;
		this.connection?.close();
		this.dialog?.dispose?.();
		this.pendingEvents = [];
	}
}
