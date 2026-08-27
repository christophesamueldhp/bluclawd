import { type Component, type Focusable, getKeybindings, Input, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { StreamAttachment, type StreamMessage } from "./stream-attachment.ts";
import { TranscriptModel, type WireMessage } from "./transcript.ts";

export interface AttachViewOptions {
	ui: TUI;
	instanceId: string;
	label: string;
	onClose: () => void;
}

/** Live read-only view of a running background session (transcript streams; follow-ups allowed). */
export class AttachView implements Component, Focusable {
	focused = false;

	private readonly opts: AttachViewOptions;
	private readonly transcript = new TranscriptModel();
	private readonly input = new Input();
	private attachment: StreamAttachment | undefined;
	private isStreaming = false;
	private notice = "";
	private renderQueued = false;
	private pendingPrompt: StreamMessage | undefined;

	constructor(opts: AttachViewOptions) {
		this.opts = opts;
	}

	onShow(): void {
		this.attachment = new StreamAttachment(this.opts.instanceId, {
			onReady: () => {
				this.attachment?.send({ type: "get_state" });
				this.attachment?.send({ type: "get_messages" });
			},
			onResponse: (message) => this.onResponse(message),
			onEvent: (event) => this.onEvent(event),
			onUiRequest: (request) => this.onUiRequest(request),
			onError: (error) => {
				this.notice = error;
				this.scheduleRender();
			},
			onClosed: (everReady) => {
				// "session ended" implies one that was actually live — misleading for a socket
				// that was never reachable, or a connection that hung past the ready timeout
				// without ever producing a working session (IMPROVEMENT-PLAN.md §5.1e/§5.1f).
				this.notice = everReady ? "session ended — esc to close" : "couldn't reach that session — esc to close";
				this.isStreaming = false;
				this.scheduleRender();
			},
		});
		this.attachment.connect();
	}

	private onResponse(message: StreamMessage): void {
		const data = (message.data ?? {}) as Record<string, unknown>;
		if (message.command === "get_messages" && Array.isArray(data.messages)) {
			this.transcript.setAll(data.messages as WireMessage[]);
			this.scheduleRender();
		} else if (message.command === "get_state") {
			this.isStreaming = data.isStreaming === true;
			this.scheduleRender();
		}
	}

	private onEvent(event: StreamMessage): void {
		if (event.type === "agent_start" || event.type === "turn_start") this.isStreaming = true;
		else if (event.type === "agent_settled") this.isStreaming = false;
		this.transcript.apply(event as { type: string; message?: WireMessage });
		this.scheduleRender();
	}

	private static readonly BLOCKING = new Set(["select", "confirm", "input", "editor"]);

	private onUiRequest(request: StreamMessage): void {
		if (typeof request.method === "string" && AttachView.BLOCKING.has(request.method)) {
			this.pendingPrompt = request;
			this.input.setValue("");
			this.scheduleRender();
		}
	}

	private answerPrompt(response: Record<string, unknown>): void {
		const prompt = this.pendingPrompt;
		if (!prompt) return;
		this.attachment?.send({ type: "extension_ui_response", id: prompt.id, ...response });
		this.pendingPrompt = undefined;
		this.input.setValue("");
		this.scheduleRender();
	}

	private handlePromptInput(data: string): void {
		const kb = getKeybindings();
		const prompt = this.pendingPrompt;
		if (!prompt) return;
		if (kb.matches(data, "tui.select.cancel")) {
			this.answerPrompt({ cancelled: true });
			return;
		}
		if (prompt.method === "select") {
			const options = Array.isArray(prompt.options) ? (prompt.options as string[]) : [];
			const n = Number.parseInt(data, 10);
			if (n >= 1 && n <= options.length) this.answerPrompt({ value: options[n - 1] });
			return;
		}
		if (prompt.method === "confirm") {
			if (data === "y" || data === "Y") this.answerPrompt({ confirmed: true });
			else if (data === "n" || data === "N") this.answerPrompt({ confirmed: false });
			return;
		}
		// input / editor
		if (kb.matches(data, "tui.input.submit") || data === "\r" || data === "\n") {
			this.answerPrompt({ value: this.input.getValue() });
			return;
		}
		this.input.handleInput(data);
	}

	/** Test seam: deliver a blocking UI request without a socket. */
	handleUiRequestForTest(request: StreamMessage): void {
		this.onUiRequest(request);
	}

	/** Test seam: inject a fake attachment to capture outbound messages. */
	setAttachmentForTest(attachment: StreamAttachment): void {
		this.attachment = attachment;
	}

	/** Coalesce render requests so streaming deltas don't thrash the renderer. */
	private scheduleRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		queueMicrotask(() => {
			this.renderQueued = false;
			this.opts.ui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (this.pendingPrompt) {
			this.handlePromptInput(data);
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (kb.matches(data, "tui.input.submit") || data === "\r" || data === "\n") {
			const text = this.input.getValue().trim();
			if (text) {
				this.attachment?.send({ type: "follow_up", message: text });
				this.input.setValue("");
				this.scheduleRender();
			}
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {}

	/** Test seam: inject transcript state without a socket. */
	setTranscriptForTest(messages: WireMessage[]): void {
		this.transcript.setAll(messages);
	}

	private close(): void {
		this.attachment?.close();
		this.attachment = undefined;
		this.opts.onClose();
	}

	private renderPrompt(prompt: StreamMessage, width: number): string[] {
		const title = typeof prompt.title === "string" ? prompt.title : "Permission required";
		const lines = [theme.fg("warning", `⚠ ${title}`)];
		if (prompt.method === "select") {
			const options = Array.isArray(prompt.options) ? (prompt.options as string[]) : [];
			lines.push(theme.fg("text", options.map((option, i) => `${i + 1}) ${option}`).join("   ")));
			lines.push(theme.fg("dim", "press a number to choose · esc cancels"));
		} else if (prompt.method === "confirm") {
			if (typeof prompt.message === "string") lines.push(prompt.message);
			lines.push(theme.fg("dim", "y / n · esc cancels"));
		} else {
			lines.push(this.input.getValue() ? this.input.render(width)[0] : theme.fg("dim", "> type your answer"));
			lines.push(theme.fg("dim", "enter to answer · esc cancels"));
		}
		return lines;
	}

	render(width: number): string[] {
		const rows = this.opts.ui.terminal.rows;

		const header: string[] = [];
		const status = this.isStreaming ? theme.fg("accent", "● working") : theme.fg("muted", "○ idle");
		header.push(`${theme.bold(this.opts.label)}  ${status}`);
		if (this.notice) header.push(theme.fg("warning", this.notice));
		header.push("");

		const footer: string[] = [];
		footer.push(theme.fg("dim", "─".repeat(Math.max(0, width))));
		if (this.pendingPrompt) {
			footer.push(...this.renderPrompt(this.pendingPrompt, width));
		} else {
			footer.push(
				this.input.getValue() ? this.input.render(width)[0] : theme.fg("dim", "> send a follow-up message"),
			);
			footer.push(theme.fg("dim", "enter send · esc detach (session keeps running)"));
		}

		const budget = Math.max(1, rows - header.length - footer.length);
		const lines = this.transcript.toLines(width);
		const body = lines.length === 0 ? [theme.fg("dim", "(no messages yet)")] : lines;
		const windowed = body.slice(Math.max(0, body.length - budget)); // tail-follow
		const pad = Math.max(0, budget - windowed.length);
		return [...header, ...windowed, ...Array(pad).fill(""), ...footer];
	}
}
