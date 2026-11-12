import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionFactory,
	type ExtensionUIContext,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { stripAnsi } from "../../daemon/ansi.ts";
import { PANE_ENV, Tmux } from "../../daemon/tmux.ts";
import { STATUS_KEYS } from "../../ext/_shared/status-keys.ts";
import { fakeRunHosts } from "./fake-run-hosts.ts";
import { createParentSessionWithSubagents } from "./subagent-session.ts";
import { waitFor } from "./wait-for.ts";

/** The orchestrator's own tmux session in these tests. */
const ORCHESTRATOR_PANE = "pi-orchestrator";

type Rendered = Component & { dispose?(): void; focused?: boolean };
type InputHandler = Parameters<ExtensionUIContext["onTerminalInput"]>[0];

/** Every style is a no-op, so rendered lines are plain text. */
const plainTheme = new Proxy(
	{},
	{ get: (_target, prop) => (prop === "then" ? undefined : (...args: unknown[]) => args.at(-1)) },
) as ExtensionUIContext["theme"];

/** Stands in for pistatusline, which draws the footer and each multi-line status as a block below its chips. */
const pistatusline: ExtensionFactory = (pi) => {
	pi.registerCommand("pistatusline", { description: "pistatusline", handler: async () => {} });
};

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
export async function createSubagentTui(
	options: {
		extensions?: ExtensionFactory[];
		/** Extensions loaded before subagents, whose key listeners see each key first. */
		extensionsBefore?: ExtensionFactory[];
		/** Tools the orchestrator has besides the subagent tools, and can give its runs. */
		extraTools?: Parameters<typeof createParentSessionWithSubagents>[0]["extraTools"];
		/** Pi built-in tools the orchestrator has, and can give its runs; none when omitted. */
		builtinTools?: string[];
		batchWindowMs?: number;
		/** Whether pistatusline draws the footer; on by default. */
		pistatusline?: boolean;
		/** Whether the orchestrator runs outside tmux, in no pane of its own. */
		outsideTmux?: boolean;
	} = {},
) {
	initTheme("dark");
	const dirs = [mkdtempSync(join(tmpdir(), "bluclawd-tui-cwd-")), mkdtempSync(join(tmpdir(), "bluclawd-tui-agent-"))];
	const [cwd, agentDir] = dirs;
	// Runs on pi's RPC: none of these tests drives a run in a pane (ADR-0013).
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagents: { panes: false } }));
	let offset = 0;

	const widgets = new Map<string, { component: Rendered; placement: string }>();
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	const inputHandlers = new Set<InputHandler>();
	let view: Rendered | undefined;
	/** The component that has the keyboard when no view is open; the editor when unset. */
	let focus: Rendered | undefined;
	let overlayShown = false;
	let viewIsOverlay = false;
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
		hasOverlay: () => overlayShown || viewIsOverlay,
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
		// As in pi: an overlay hands the keyboard back to whoever had it, any other view to the prompt.
		custom: (factory: (...args: unknown[]) => Rendered | Promise<Rendered>, customOptions?: { overlay?: boolean }) =>
			new Promise((resolve) => {
				const overlay = customOptions?.overlay ?? false;
				let closed = false;
				const done = (result: unknown) => {
					if (closed) return;
					closed = true;
					if (view) view.focused = false;
					view?.dispose?.();
					view = undefined;
					viewIsOverlay = false;
					if (!overlay) tui.setFocus(editor);
					(focus ?? editor).focused = true;
					resolve(result);
				};
				void Promise.resolve(factory(tui, plainTheme, keybindings, done)).then((component) => {
					if (closed) return;
					(focus ?? editor).focused = false;
					component.focused = true;
					view = component;
					viewIsOverlay = overlay;
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

	// The orchestrator runs in a pane of its own; each run it starts is a fake host, which the test speaks for, given
	// its turn at once by a daemon that is never asked.
	const previousPane = process.env[PANE_ENV];
	process.env[PANE_ENV] = options.outsideTmux ? "" : ORCHESTRATOR_PANE;
	const hosts = fakeRunHosts();
	const { runs, report, progress } = hosts;
	const switched: string[] = [];
	const spies = [
		vi.spyOn(Tmux.prototype, "switchTo").mockImplementation((pane) => {
			switched.push(pane);
		}),
	];
	const eventBus = createEventBus();

	const { session, faux } = await createParentSessionWithSubagents({
		cwd,
		agentDir,
		extensions: [...(options.pistatusline === false ? [] : [pistatusline]), ...(options.extensions ?? [])],
		extensionsBefore: options.extensionsBefore,
		extraTools: options.extraTools,
		builtinTools: options.builtinTools,
		batchWindowMs: options.batchWindowMs ?? 15,
		now: () => Date.now() + offset,
		eventBus,
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
		 * Scripts the faux provider: the orchestrator's turns answer with `parent` in order, then "Done.". Prompt
		 * assistance's suggestion and session name requests answer with `side`, by default nothing.
		 */
		script(parent: Turn[], side: Turn = () => fauxAssistantMessage("")) {
			let turn = 0;
			const next = (context: TranscriptContext) => {
				if (isSideContext(context)) return side(context);
				return (parent[turn++] ?? (() => fauxAssistantMessage("Done.")))(context);
			};
			faux.setResponses(Array.from({ length: 50 }, () => next));
		},
		/** The runs started so far, as fake hosts, oldest first. */
		runs,
		/** Resolves once a run of that name has started. */
		started: (name: string) => waitFor(() => runs.some((run) => run.name === name)),
		/** The panes the terminal was switched to. */
		switched,
		/** The run reports `text` and its process ends, as an RPC run's does once its work settled. */
		report,
		progress,
		/** The subagent panel, the multi-line status pistatusline draws below its chips, as plain lines; empty when none. */
		panel: () => {
			const text = statuses.get(STATUS_KEYS.subagents);
			return text?.includes("\n")
				? stripAnsi(text)
						.split("\n")
						.filter((line) => line !== "")
				: [];
		},
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
		/** Shows or hides an overlay that leaves the keyboard where it is. */
		setOverlay(shown: boolean) {
			overlayShown = shown;
		},
		/** Whether the prompt editor has the keyboard. */
		editorFocused: () => !view && !focus,
		/** Feeds each key to the terminal input listeners, then to the open view or else the focused component. */
		press(...keys: string[]) {
			for (const key of keys) {
				let data: string | undefined = key;
				for (const handler of inputHandlers) {
					const result = handler(data);
					if (result?.consume) {
						data = undefined;
						break;
					}
					if (result?.data !== undefined) data = result.data;
				}
				if (data !== undefined) (view ?? focus ?? editor).handleInput?.(data);
			}
		},
		/** Moves the extension's clock on by `ms`. */
		advance(ms: number) {
			offset += ms;
		},
		dispose() {
			session.dispose();
			hosts.dispose();
			for (const spy of spies) spy.mockRestore();
			if (previousPane === undefined) delete process.env[PANE_ENV];
			else process.env[PANE_ENV] = previousPane;
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
		},
	};
}

export type SubagentTui = Awaited<ReturnType<typeof createSubagentTui>>;
