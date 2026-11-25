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

const ORCHESTRATOR_PANE = "pi-orchestrator";

type Rendered = Component & { dispose?(): void; focused?: boolean };
type InputHandler = Parameters<ExtensionUIContext["onTerminalInput"]>[0];

const plainTheme = new Proxy(
	{},
	{ get: (_target, prop) => (prop === "then" ? undefined : (...args: unknown[]) => args.at(-1)) },
) as ExtensionUIContext["theme"];

const pistatusline: ExtensionFactory = (pi) => {
	pi.registerCommand("pistatusline", { description: "pistatusline", handler: async () => {} });
};

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

function isSideContext(context: TranscriptContext): boolean {
	const sys = context.messages.find((m) => m.role === "system");
	return /^(Predict the next short message|Name this coding session)/.test(
		sys?.role === "system" ? getSystemMessageText(sys) : "",
	);
}

export function gate(): { wait: Promise<void>; open: () => void } {
	let open!: () => void;
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

export async function createSubagentTui(
	options: {
		extensions?: ExtensionFactory[];
		extensionsBefore?: ExtensionFactory[];
		extraTools?: Parameters<typeof createParentSessionWithSubagents>[0]["extraTools"];
		builtinTools?: string[];
		batchWindowMs?: number;
		pistatusline?: boolean;
		outsideTmux?: boolean;
	} = {},
) {
	initTheme("dark");
	const dirs = [mkdtempSync(join(tmpdir(), "bluclawd-tui-cwd-")), mkdtempSync(join(tmpdir(), "bluclawd-tui-agent-"))];
	const [cwd, agentDir] = dirs;
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagents: { panes: false } }));
	let offset = 0;

	const widgets = new Map<string, { component: Rendered; placement: string }>();
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	const inputHandlers = new Set<InputHandler>();
	let view: Rendered | undefined;
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
		script(parent: Turn[], side: Turn = () => fauxAssistantMessage("")) {
			let turn = 0;
			const next = (context: TranscriptContext) => {
				if (isSideContext(context)) return side(context);
				return (parent[turn++] ?? (() => fauxAssistantMessage("Done.")))(context);
			};
			faux.setResponses(Array.from({ length: 50 }, () => next));
		},
		runs,
		started: (name: string) => waitFor(() => runs.some((run) => run.name === name)),
		switched,
		report,
		progress,
		panel: () => {
			const text = statuses.get(STATUS_KEYS.subagents);
			return text?.includes("\n")
				? stripAnsi(text)
						.split("\n")
						.filter((line) => line !== "")
				: [];
		},
		widget: (key: string, width = 100) => {
			const mounted = widgets.get(key);
			return mounted && { placement: mounted.placement, lines: lines(mounted.component, width) ?? [] };
		},
		view: (width = 100) => lines(view, width),
		status: (key: string) => statuses.get(key),
		notifications,
		editorText: () => editor.getText(),
		editor: () => editor,
		setOverlay(shown: boolean) {
			overlayShown = shown;
		},
		editorFocused: () => !view && !focus,
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
