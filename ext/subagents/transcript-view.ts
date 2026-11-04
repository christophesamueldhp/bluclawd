import {
	AssistantMessageComponent,
	CustomMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getMarkdownTheme,
	type Theme,
	type ToolDefinition,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type Focusable,
	Input,
	matchesKey,
	Spacer,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { TranscriptMessage, TranscriptSource } from "./transcripts.ts";

/** The header naming the run, and the message input and hint line under the transcript. */
const CHROME_LINES = 3;
const HINT = "↑/↓ PgUp/PgDn to scroll · Esc to go back";

/**
 * A run's transcript in pi's own message components, kept in step with its source: finished messages are only
 * appended, and the message still streaming is rebuilt on each change.
 */
function createTranscriptBody(options: { tui: TUI; cwd: string; expanded: boolean }) {
	const { tui, cwd, expanded } = options;
	const markdown = getMarkdownTheme();
	// A run's built-in tools are renderer-less proxies of the orchestrator's; pi's own definitions render them.
	const definitions = new Map<string, ToolDefinition>(
		[
			createReadToolDefinition(cwd),
			createBashToolDefinition(cwd),
			createEditToolDefinition(cwd),
			createWriteToolDefinition(cwd),
			createGrepToolDefinition(cwd),
			createFindToolDefinition(cwd),
			createLsToolDefinition(cwd),
		].map((definition) => [definition.name, definition as ToolDefinition]),
	);
	const history = new Container();
	const tail = new Container();
	const container = new Container();
	container.addChild(history);
	container.addChild(tail);
	const tools = new Map<string, ToolExecutionComponent>();
	let shown: readonly TranscriptMessage[] = [];

	const add = (into: Container, message: TranscriptMessage) => {
		if (message.role === "user") {
			if (history.children.length > 0 || into.children.length > 0) into.addChild(new Spacer(1));
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			into.addChild(new UserMessageComponent(text, markdown));
		} else if (message.role === "assistant") {
			into.addChild(new AssistantMessageComponent(message, false, markdown));
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					undefined,
					definitions.get(content.name),
					tui,
					cwd,
				);
				tool.setExpanded(expanded);
				into.addChild(tool);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					tool.updateResult({
						content: [{ type: "text", text: message.errorMessage || "Operation aborted" }],
						isError: true,
					});
				} else tools.set(content.id, tool);
			}
		} else if (message.role === "toolResult") {
			tools.get(message.toolCallId)?.updateResult(message);
			tools.delete(message.toolCallId);
		} else if (message.role === "custom" && message.display) {
			into.addChild(new CustomMessageComponent(message, undefined, markdown));
		}
	};

	return {
		container,
		sync({ messages, streaming }: ReturnType<TranscriptSource["read"]>) {
			// A source that changed under the view (the file read after the live session) is rendered afresh.
			const appended = messages.length >= shown.length && shown.every((message, i) => messages[i] === message);
			if (!appended) {
				history.clear();
				tools.clear();
				shown = [];
			}
			for (const message of messages.slice(shown.length)) add(history, message);
			shown = [...messages];
			tail.clear();
			if (streaming) add(tail, streaming);
		},
	};
}

/**
 * A run's transcript over the whole screen: a header naming the run, the transcript in a viewport that follows
 * its end until scrolled up, an input whose text goes to the run, and a hint line. Esc closes it.
 */
export function createTranscriptView(options: {
	tui: TUI;
	theme: Theme;
	cwd: string;
	/** The run's name, agent, model and status, for the header. */
	title: () => string;
	source: TranscriptSource;
	/** Whether tool output starts expanded, as in the orchestrator's chat. */
	expanded: boolean;
	/** Sends typed text to the run; `status` says whether it was queued, or why not. */
	send: (text: string) => Promise<{ queued: boolean; status: string }>;
	close: () => void;
}): Component & Focusable & { dispose(): void } {
	const { tui, theme, source } = options;
	const body = createTranscriptBody(options);
	let dirty = true;
	const unwatch = source.watch(() => {
		dirty = true;
		tui.requestRender();
	});
	let top = 0;
	let follow = true;
	let height = 1;
	let maxTop = 0;
	const scroll = (by: number) => {
		top = Math.max(0, Math.min(maxTop, top + by));
		follow = top >= maxTop;
		tui.requestRender();
	};
	let status: string | undefined;
	const input = new Input({ placeholder: "Message this run" });
	input.onSubmit = (value) => {
		const text = value.trim();
		if (!text) return;
		// A command typed here would otherwise reach the run as text, or be mistaken for the orchestrator's.
		if (text.startsWith("/") || text.startsWith("!")) {
			status = "Commands do not run in a run's transcript; press Esc to go back to the orchestrator's prompt.";
			tui.requestRender();
			return;
		}
		void options.send(text).then((result) => {
			if (result.queued) input.setValue("");
			status = result.status;
			tui.requestRender();
		});
	};

	return {
		get focused() {
			return input.focused;
		},
		set focused(focused: boolean) {
			input.focused = focused;
		},
		render(width) {
			if (dirty) {
				body.sync(source.read());
				dirty = false;
			}
			const lines = body.container.render(width);
			height = Math.max(1, tui.terminal.rows - CHROME_LINES);
			maxTop = Math.max(0, lines.length - height);
			top = follow ? maxTop : Math.min(top, maxTop);
			const shown = lines.slice(top, top + height);
			return [
				truncateToWidth(theme.bold(options.title()), width),
				...shown,
				...Array.from({ length: height - shown.length }, () => ""),
				...input.render(width),
				truncateToWidth(theme.fg("dim", status ?? HINT), width),
			];
		},
		handleInput(data) {
			if (matchesKey(data, "escape")) options.close();
			else if (matchesKey(data, "up")) scroll(-1);
			else if (matchesKey(data, "down")) scroll(1);
			else if (matchesKey(data, "pageUp")) scroll(-height);
			else if (matchesKey(data, "pageDown")) scroll(height);
			else {
				status = undefined;
				input.handleInput(data);
				tui.requestRender();
			}
		},
		invalidate() {
			body.container.invalidate();
		},
		dispose: unwatch,
	};
}
