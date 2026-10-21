import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudePasteEditor } from "../ext/paste/index.ts";
import { attachSuggestions } from "../ext/prompt-assist/editor.ts";
import promptAssist, { conversation } from "../ext/prompt-assist/index.ts";
import { DEFAULT_MODEL, loadAssistModel, saveAssistModel } from "../ext/prompt-assist/prefs.ts";

vi.mock("../ext/prompt-assist/prefs.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ext/prompt-assist/prefs.ts")>();
	return { ...actual, loadAssistModel: vi.fn(() => actual.DEFAULT_MODEL), saveAssistModel: vi.fn() };
});

beforeEach(() => {
	vi.mocked(loadAssistModel).mockReturnValue(DEFAULT_MODEL);
	vi.mocked(saveAssistModel).mockReset();
});

const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 100 } };
const theme = { borderColor: (text: string) => text, selectList: {} };
const keys = { matches: () => false, getKeys: () => [] };

function makeEditor(generate = vi.fn(async (_draft: string, _signal: AbortSignal) => " tests")) {
	const editor = new ClaudePasteEditor(tui as never, theme as never, keys as never);
	editor.focused = true;
	const assist = attachSuggestions(
		editor,
		generate,
		() => true,
		tui.requestRender,
		(text) => text,
	);
	return { editor, assist, generate };
}

function deferred<T>() {
	let resolve: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve: (value: T) => resolve(value) };
}

function harness(options: { name?: string; entries?: unknown[]; mode?: string; factory?: unknown } = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	let name = options.name;
	let factory: any = options.factory;
	const response = deferred<any>();
	const models = [
		{ provider: "opencode-go", id: "mimo-v2.6-flash" },
		{ provider: "custom", id: "vendor/fast-model" },
	];
	const stream = vi.fn((_model: unknown, _context: unknown, _options: unknown) => ({
		result: () => response.promise,
	}));
	const entries = options.entries ?? [{ type: "message", message: { role: "user", content: "Fix login validation" } }];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		isIdle: () => true,
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (value: unknown) => {
				factory = value;
			},
			notify: vi.fn(),
			select: vi.fn(async (_title: string, _choices: string[]) => undefined as string | undefined),
			theme: { fg: (_color: string, text: string) => text },
		},
		modelRegistry: {
			find: vi.fn((provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
			),
			getAvailable: vi.fn(() => models),
			hasConfiguredAuth: () => true,
			streamSimple: stream,
		},
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionId: () => "session-1" },
	};
	const pi = {
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		on: (event: string, handler: (...args: any[]) => any) => {
			handlers.set(event, handler);
		},
		getSessionName: () => name,
		setSessionName: vi.fn((value: string) => {
			name = value;
			handlers.get("session_info_changed")?.({ name }, ctx);
		}),
	};
	promptAssist(pi as never);
	const emit = (event: string) => handlers.get(event)?.({}, ctx);
	emit("session_start");
	return {
		ctx,
		pi,
		emit,
		stream,
		response,
		factory: () => factory,
		command: (args = "") => commands.get("prompt-assist").handler(args, ctx),
		completions: (prefix: string) => commands.get("prompt-assist").getArgumentCompletions(prefix),
	};
}

const answer = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }] });

afterEach(() => vi.useRealTimers());

describe("prompt suggestions", () => {
	it("debounces typing, renders ghost text, accepts Tab without submitting, and preserves undo", async () => {
		vi.useFakeTimers();
		const { editor, generate } = makeEditor();
		const submit = vi.fn();
		editor.onSubmit = submit;
		editor.handleInput("write");
		await vi.advanceTimersByTimeAsync(600);
		editor.handleInput(" unit");
		await vi.advanceTimersByTimeAsync(700);
		expect(generate).toHaveBeenCalledTimes(1);
		expect(generate.mock.calls[0][0]).toBe("write unit");
		expect(editor.render(40).join("\n")).toContain("tests");
		expect(editor.getText()).toBe("write unit");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("write unit tests");
		expect(submit).not.toHaveBeenCalled();
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe("write unit");
	});

	it("ignores stale responses after further typing and clears on Escape", async () => {
		vi.useFakeTimers();
		const pending = deferred<string>();
		const generate = vi.fn(async (_draft: string, _signal: AbortSignal) => pending.promise);
		const { editor } = makeEditor(generate);
		editor.handleInput("write");
		await vi.advanceTimersByTimeAsync(700);
		editor.handleInput(" better");
		pending.resolve(" stale");
		await Promise.resolve();
		expect(editor.render(40).join("\n")).not.toContain("stale");
		expect(generate.mock.calls[0][1].aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(700);
		editor.handleInput("\x1b");
		expect(editor.render(40).join("\n")).not.toContain("stale");
	});

	it("does not call the model for commands, shell input, paste tokens, or autocomplete menus", async () => {
		vi.useFakeTimers();
		const { editor, assist, generate } = makeEditor();
		for (const text of ["/model", "!ls", "[Pasted text #1 +4 lines]", "[Image #1]"]) {
			editor.setText(text);
			assist.schedule();
			await vi.advanceTimersByTimeAsync(700);
		}
		editor.setText("write");
		editor.isShowingAutocomplete = () => true;
		assist.schedule();
		await vi.advanceTimersByTimeAsync(700);
		expect(generate).not.toHaveBeenCalled();
	});

	it("supports empty next-prompt suggestions and narrow Unicode rendering without changing the draft", async () => {
		vi.useFakeTimers();
		const { editor, assist } = makeEditor(vi.fn(async () => "修正 login 🔧 tests"));
		assist.schedule();
		await vi.advanceTimersByTimeAsync(700);
		for (const width of [1, 5, 12, 40]) {
			const lines = editor.render(width);
			expect(lines.map((line) => [visibleWidth(line), line]).filter(([size]) => Number(size) > width)).toEqual([]);
			expect(lines.join("")).toContain(CURSOR_MARKER);
		}
		expect(editor.getText()).toBe("");
		assist.clear();
	});

	it("waits for the agent to become idle before requesting suggestions", async () => {
		vi.useFakeTimers();
		let idle = false;
		const editor = new ClaudePasteEditor(tui as never, theme as never, keys as never);
		const generate = vi.fn(async () => "Run the tests");
		const assist = attachSuggestions(
			editor,
			generate,
			() => idle,
			tui.requestRender,
			(text) => text,
		);
		assist.schedule();
		await vi.advanceTimersByTimeAsync(700);
		expect(generate).not.toHaveBeenCalled();
		assist.schedule();
		idle = true;
		await vi.advanceTimersByTimeAsync(700);
		expect(generate).toHaveBeenCalledOnce();
		assist.clear();
	});

	it("clears pending requests on shutdown-style disposal and does not interfere with input", async () => {
		vi.useFakeTimers();
		const { editor, assist, generate } = makeEditor();
		editor.handleInput("write");
		assist.clear();
		await vi.advanceTimersByTimeAsync(700);
		expect(generate).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("write");
	});

	it("keeps collapsed paste expansion intact", () => {
		const { editor } = makeEditor();
		const text = "one\ntwo\nthree\nfour\nfive";
		const submit = vi.fn();
		editor.onSubmit = submit;
		editor.handleInput(`\x1b[200~${text}\x1b[201~`);
		expect(editor.getText()).toContain("[Pasted text");
		editor.handleInput("\r");
		expect(submit).toHaveBeenCalledWith(text);
	});
});

describe("prompt assist model selection", () => {
	it("selects any available Pi model, saves it, and uses it for naming without MiMo-specific parameters", async () => {
		const h = harness();
		await h.command("custom/vendor/fast-model");
		expect(saveAssistModel).toHaveBeenCalledWith(expect.any(String), "custom/vendor/fast-model");
		h.emit("agent_end");
		expect(h.ctx.modelRegistry.find).toHaveBeenCalledWith("custom", "vendor/fast-model");
		expect(h.stream.mock.calls[0][2]).not.toHaveProperty("samplingParams");
		h.response.resolve(answer("Custom model title"));
		await vi.waitFor(() => expect(h.pi.getSessionName()).toBe("Custom model title"));
	});

	it("uses the selected model for prompt suggestions too", async () => {
		vi.useFakeTimers();
		const h = harness();
		await h.command("custom/vendor/fast-model");
		const editor = h.factory()(tui, theme, keys);
		editor.handleInput("write tests");
		await vi.advanceTimersByTimeAsync(700);
		expect(h.ctx.modelRegistry.find).toHaveBeenCalledWith("custom", "vendor/fast-model");
		expect(h.stream.mock.calls[0][2]).toHaveProperty("maxTokens", 64);
		h.emit("session_shutdown");
		h.response.resolve(answer(" for login"));
	});

	it("restores the saved model on session start and can reset to MiMo", async () => {
		vi.mocked(loadAssistModel).mockReturnValue("custom/vendor/fast-model");
		const h = harness();
		h.emit("agent_end");
		expect(h.ctx.modelRegistry.find).toHaveBeenCalledWith("custom", "vendor/fast-model");
		await h.command("default");
		expect(saveAssistModel).toHaveBeenCalledWith(expect.any(String), DEFAULT_MODEL);
		h.response.resolve(answer("Stale title"));
		await new Promise((done) => setTimeout(done, 0));
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
	});

	it("opens a picker and supports argument completion", async () => {
		const h = harness();
		h.ctx.ui.select.mockResolvedValue("custom/vendor/fast-model");
		await h.command();
		expect(h.ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_MODEL), [
			"custom/vendor/fast-model",
			DEFAULT_MODEL,
		]);
		expect(saveAssistModel).toHaveBeenCalledWith(expect.any(String), "custom/vendor/fast-model");
		expect(h.completions("FAST")).toEqual([{ value: "custom/vendor/fast-model", label: "custom/vendor/fast-model" }]);
	});

	it("does not change the preference when the picker is cancelled or the model is unavailable", async () => {
		const h = harness();
		await h.command();
		await h.command("unknown/model");
		expect(saveAssistModel).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("not available"), "error");
	});

	it("reports save failures but still applies the model to the current session", async () => {
		const h = harness();
		vi.mocked(saveAssistModel).mockImplementation(() => {
			throw new Error("read-only");
		});
		await h.command("custom/vendor/fast-model");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("could not save"), "warning");
		h.emit("agent_end");
		expect(h.ctx.modelRegistry.find).toHaveBeenCalledWith("custom", "vendor/fast-model");
		h.emit("session_shutdown");
		h.response.resolve(answer("Ignored"));
	});
});

describe("session assistance", () => {
	it("names once in the background, uses MiMo with session affinity, and allows subsequent manual rename", async () => {
		const h = harness();
		expect(h.emit("agent_end")).toBeUndefined();
		expect(h.ctx.modelRegistry.find).toHaveBeenCalledWith("opencode-go", "mimo-v2.6-flash");
		expect(h.stream.mock.calls[0][2]).toMatchObject({
			sessionId: "session-1",
			maxTokens: 32,
			maxRetries: 0,
			samplingParams: { thinking: { type: "disabled" } },
		});
		h.response.resolve(answer("Fix Login Validation"));
		await vi.waitFor(() => expect(h.pi.setSessionName).toHaveBeenCalledWith("Fix Login Validation"));
		h.pi.setSessionName("My custom title");
		h.emit("agent_end");
		expect(h.pi.getSessionName()).toBe("My custom title");
		expect(h.stream).toHaveBeenCalledTimes(1);
	});

	it("never overwrites a manual rename during generation", async () => {
		const h = harness();
		h.emit("agent_end");
		h.pi.setSessionName("Manual title");
		h.response.resolve(answer("Automatic title"));
		await new Promise((done) => setTimeout(done, 0));
		expect(h.pi.getSessionName()).toBe("Manual title");
		expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
	});

	it("skips named sessions and previously cleared names", () => {
		for (const options of [{ name: "Existing" }, { entries: [{ type: "session_info", name: "" }] }]) {
			const h = harness(options);
			h.emit("agent_end");
			expect(h.stream).not.toHaveBeenCalled();
		}
	});

	it("discards naming after switching sessions or shutting down", async () => {
		for (const event of ["session_start", "session_shutdown"]) {
			const h = harness();
			h.emit("agent_end");
			h.emit(event);
			h.response.resolve(answer("Old session title"));
			await new Promise((done) => setTimeout(done, 0));
			expect(h.pi.setSessionName).not.toHaveBeenCalled();
		}
	});

	it("composes the existing editor factory and does not stack wrappers on session changes", () => {
		const original = vi.fn(() => new ClaudePasteEditor(tui as never, theme as never, keys as never));
		const h = harness({ factory: original });
		const factory = h.factory();
		expect(factory(tui, theme, keys)).toBeInstanceOf(ClaudePasteEditor);
		expect(original).toHaveBeenCalledOnce();
		h.emit("session_start");
		expect(h.factory()).toBe(factory);
	});

	it("uses the stock custom editor when no paste editor is installed, and leaves non-TUI modes alone", () => {
		const h = harness();
		expect(h.factory()(tui, theme, keys)).toBeInstanceOf(CustomEditor);
		expect(harness({ mode: "json" }).factory()).toBeUndefined();
	});

	it("keeps tool output, thinking, and images out of the bounded conversation", () => {
		const h = harness({
			entries: [
				{
					type: "message",
					message: { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] },
				},
				{
					type: "message",
					message: {
						role: "user",
						content: [
							{ type: "image", data: "bytes" },
							{ type: "text", text: "hello" },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "private reasoning" },
							{ type: "text", text: "hi" },
						],
					},
				},
			],
		});
		expect(conversation(h.ctx as never)).toBe("user: hello\nassistant: hi");
	});

	it("fails softly without model access and warns only once", () => {
		const h = harness();
		h.ctx.modelRegistry.find.mockReturnValue(undefined);
		h.emit("agent_end");
		h.emit("agent_end");
		expect(h.stream).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledOnce();
	});
});
