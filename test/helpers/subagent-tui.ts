import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type ExtensionFactory, type ExtensionUIContext, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../daemon/ansi.ts";
import { SUBAGENT_PANEL_WIDGET } from "../../ext/subagents/panel.ts";
import { createParentSessionWithSubagents } from "./subagent-session.ts";

type Rendered = Component & { dispose?(): void; focused?: boolean };
type InputHandler = Parameters<ExtensionUIContext["onTerminalInput"]>[0];

/** Every style is a no-op, so rendered lines are plain text. */
const plainTheme = new Proxy(
	{},
	{ get: (_target, prop) => (prop === "then" ? undefined : (...args: unknown[]) => args.at(-1)) },
) as ExtensionUIContext["theme"];

/** A child's report in the shape its contract asks for. */
export const REPORT = "### Scope\n- `a.ts`\n### Summary\nDone.\n### Evidence\n- `a.ts:1`\n### Blockers\n- none";

/** An orchestrator turn that launches one run per `name`, all in one message. */
export function launch(names: string[], options: { background?: boolean; agent?: string } = {}) {
	return () =>
		fauxAssistantMessage(
			names.map((name) =>
				fauxToolCall(
					"subagent",
					{
						agent: options.agent ?? "explorer",
						name,
						task: `Task for ${name}`,
						...(options.background ? { background: true } : {}),
					},
					{ id: `call_${name}` },
				),
			),
		);
}

/** Whether a faux-provider request comes from a child run rather than the orchestrator. */
export function isChildContext(context: TranscriptContext): boolean {
	const sys = context.messages.find((m) => m.role === "system");
	return (sys?.role === "system" ? getSystemMessageText(sys) : "").includes("subagent operating in a fresh context");
}

/** Whether a faux-provider request is prompt assistance's, for a suggestion or a session name. */
function isSideContext(context: TranscriptContext): boolean {
	const sys = context.messages.find((m) => m.role === "system");
	return /^(Predict the next short message|Name this coding session)/.test(
		sys?.role === "system" ? getSystemMessageText(sys) : "",
	);
}

/** A gate a scripted faux turn awaits; `open()` lets it go on. */
export function gate(): { wait: Promise<void>; open: () => void } {
	let open!: () => void;
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

/**
 * A real orchestrator session on a faux provider with the subagents extension, bound in TUI mode with a UI
 * context that records what the extension shows: below/above-editor widgets, `ui.custom` views, statuses and
 * notifications. Keys go where the TUI would send them, and time can be moved on without fake timers.
 */
export async function createSubagentTui(options: { extensions?: ExtensionFactory[]; batchWindowMs?: number } = {}) {
	initTheme("dark");
	const dirs = [mkdtempSync(join(tmpdir(), "bluclawd-tui-cwd-")), mkdtempSync(join(tmpdir(), "bluclawd-tui-agent-"))];
	const [cwd, agentDir] = dirs;
	let offset = 0;

	const widgets = new Map<string, { component: Rendered; placement: string }>();
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	const inputHandlers = new Set<InputHandler>();
	let view: Rendered | undefined;
	/** The component that has the keyboard when no view is open; the editor when unset. */
	let focus: Rendered | undefined;
	let editorText = "";
	let editorFactory: ((...args: unknown[]) => typeof editor) | undefined;
	let editor: Rendered & { getText(): string; setText(text: string): void } = {
		focused: true,
		getText: () => editorText,
		setText: (text) => {
			editorText = text;
		},
		handleInput: (data) => {
			if (!/[\x00-\x1f\x7f]/.test(data)) editorText += data;
		},
		render: () => [editorText],
		invalidate: () => {},
	};

	const tui = {
		requestRender: () => {},
		hasOverlay: () => false,
		getFocusedComponent: () => view ?? focus ?? editor,
		setFocus: (component: Rendered | null) => {
			const previous = focus ?? editor;
			if (previous !== component) previous.focused = false;
			focus = component === editor || component === null ? undefined : component;
			(focus ?? editor).focused = true;
		},
		terminal: { rows: 40, columns: 100 },
	};
	const keybindings = { matches: () => false, getKeys: () => [] };

	const uiContext = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string) => notifications.push(message),
		onTerminalInput: (handler: InputHandler) => {
			inputHandlers.add(handler);
			return () => inputHandlers.delete(handler);
		},
		setStatus: (key: string, text: string | undefined) => {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, text);
		},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: (key: string, content: unknown, widgetOptions?: { placement?: string }) => {
			widgets.get(key)?.component.dispose?.();
			widgets.delete(key);
			if (content === undefined) return;
			const component: Rendered =
				typeof content === "function"
					? content(tui, plainTheme)
					: { render: () => content as string[], invalidate: () => {} };
			widgets.set(key, { component, placement: widgetOptions?.placement ?? "aboveEditor" });
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: (factory: (...args: unknown[]) => Rendered | Promise<Rendered>) =>
			new Promise((resolve) => {
				const done = (result: unknown) => {
					view?.dispose?.();
					view = undefined;
					resolve(result);
				};
				void Promise.resolve(factory(tui, plainTheme, keybindings, done)).then((component) => {
					view = component;
				});
			}),
		pasteToEditor: (text: string) => editor.handleInput?.(text),
		setEditorText: (text: string) => editor.setText(text),
		getEditorText: () => editor.getText(),
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: (factory?: (...args: unknown[]) => typeof editor) => {
			editorFactory = factory;
			const text = editor.getText();
			editor = factory?.(tui, { borderColor: (t: string) => t, selectList: {} }, keybindings) ?? editor;
			editor.setText(text);
			editor.focused = !focus;
		},
		getEditorComponent: () => editorFactory,
		theme: plainTheme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	const { session, faux } = await createParentSessionWithSubagents({
		cwd,
		agentDir,
		extensions: options.extensions,
		batchWindowMs: options.batchWindowMs ?? 15,
		now: () => Date.now() + offset,
	});
	await session.bindExtensions({ mode: "tui", uiContext: uiContext as unknown as ExtensionUIContext });

	type Turn = (context: TranscriptContext) => AssistantMessage | Promise<AssistantMessage>;

	const lines = (component: Rendered | undefined, width: number) =>
		component ? component.render(width).map((line) => stripAnsi(line)) : undefined;

	return {
		session,
		faux,
		cwd,
		agentDir,
		/**
		 * Scripts the faux provider: the orchestrator's turns answer with `parent` in order, then "Done."; every
		 * child turn answers with `child`, by default a finished report. Prompt assistance's suggestion and session
		 * name requests answer with `side`, by default nothing.
		 */
		script(
			parent: Turn[],
			child: Turn = () => fauxAssistantMessage(REPORT),
			side: Turn = () => fauxAssistantMessage(""),
		) {
			let turn = 0;
			const next = (context: TranscriptContext) => {
				if (isSideContext(context)) return side(context);
				if (isChildContext(context)) return child(context);
				return (parent[turn++] ?? (() => fauxAssistantMessage("Done.")))(context);
			};
			faux.setResponses(Array.from({ length: 50 }, () => next));
		},
		/** The subagent panel below the prompt as plain lines; empty when it shows nothing. */
		panel: (width = 100) => lines(widgets.get(SUBAGENT_PANEL_WIDGET)?.component, width) ?? [],
		/** A widget's plain lines and placement, if one is mounted under `key`. */
		widget: (key: string, width = 100) => {
			const mounted = widgets.get(key);
			return mounted && { placement: mounted.placement, lines: lines(mounted.component, width) ?? [] };
		},
		/** The open `ui.custom` view as plain lines, if one is open. */
		view: (width = 100) => lines(view, width),
		status: (key: string) => statuses.get(key),
		notifications,
		editorText: () => editor.getText(),
		/** The prompt editor as mounted, after any editor wrappers. */
		editor: () => editor,
		/** Whether the prompt editor has the keyboard. */
		editorFocused: () => !view && !focus,
		/** Feeds each key to the open view, else to the terminal input listeners and then the focused component. */
		press(...keys: string[]) {
			for (const key of keys) {
				if (view) {
					view.handleInput?.(key);
					continue;
				}
				let data: string | undefined = key;
				for (const handler of inputHandlers) {
					const result = handler(data);
					if (result?.consume) {
						data = undefined;
						break;
					}
					if (result?.data !== undefined) data = result.data;
				}
				if (data !== undefined) (focus ?? editor).handleInput?.(data);
			}
		},
		/** Moves the extension's clock on by `ms`. */
		advance(ms: number) {
			offset += ms;
		},
		dispose() {
			session.dispose();
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
		},
	};
}

export type SubagentTui = Awaited<ReturnType<typeof createSubagentTui>>;
