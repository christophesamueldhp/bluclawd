import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudePasteEditor } from "../ext/paste/index.ts";
import { attachSuggestions } from "../ext/prompt-assist/editor.ts";
import promptAssist, { conversation } from "../ext/prompt-assist/index.ts";
import {
	DEFAULT_MODEL,
	loadAssistEnabled,
	loadAssistModel,
	saveAssistEnabled,
	saveAssistModel,
} from "../ext/prompt-assist/prefs.ts";

vi.mock("../ext/prompt-assist/prefs.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ext/prompt-assist/prefs.ts")>();
	return {
		...actual,
		loadAssistModel: vi.fn(() => actual.DEFAULT_MODEL),
		saveAssistModel: vi.fn(),
		loadAssistEnabled: vi.fn(() => true),
		saveAssistEnabled: vi.fn(),
	};
});

beforeEach(() => {
	vi.mocked(loadAssistModel).mockReturnValue(DEFAULT_MODEL);
	vi.mocked(saveAssistModel).mockReset();
	vi.mocked(loadAssistEnabled).mockReturnValue(true);
	vi.mocked(saveAssistEnabled).mockReset();
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
	const emit = (event: string, data = { prompt: "Fix login validation" } as any) => handlers.get(event)?.(data, ctx);
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

	it("accepts the displayed next-prompt suggestion with Right arrow without submitting", async () => {
		vi.useFakeTimers();
		const { editor, assist } = makeEditor(vi.fn(async () => "oke susun spec N5"));
		const submit = vi.fn();
		editor.onSubmit = submit;
		assist.schedule(0);
		await vi.advanceTimersByTimeAsync(0);
		editor.handleInput("\x1b[C");
		expect(editor.getText()).toBe("oke susun spec N5");
		expect(submit).not.toHaveBeenCalled();
		editor.handleInput("\r");
		expect(submit).toHaveBeenCalledWith("oke susun spec N5");
	});

	it("accepts a continuation with Right arrow only at the end, preserving ordinary cursor movement", async () => {
		vi.useFakeTimers();
		const { editor } = makeEditor();
		editor.handleInput("write");
		await vi.advanceTimersByTimeAsync(700);
		editor.handleInput("\x1b[C");
		expect(editor.getText()).toBe("write tests");
		editor.handleInput("\x1b[D");
		const cursor = editor.getCursor();
		editor.handleInput("\x1b[C");
		expect(editor.getCursor().col).toBe(cursor.col + 1);
		expect(editor.getText()).toBe("write tests");
	});

	it("does not let Right arrow accept a prompt suggestion while command/file completion is visible", async () => {
		vi.useFakeTimers();
		const { editor } = makeEditor();
		editor.handleInput("write");
		await vi.advanceTimersByTimeAsync(700);
		editor.isShowingAutocomplete = () => true;
		editor.handleInput("\x1b[C");
		expect(editor.getText()).toBe("write");
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

	it("does not impose arbitrary character cutoffs on drafts or returned suggestions", async () => {
		vi.useFakeTimers();
		const suggestion = ` inspect ${"component".repeat(40)}`;
		const { editor, assist, generate } = makeEditor(vi.fn(async () => suggestion));
		const draft = `review ${"x".repeat(2100)}`;
		editor.setText(draft);
		assist.schedule();
		await vi.advanceTimersByTimeAsync(700);
		expect(generate).toHaveBeenCalledWith(draft, expect.any(AbortSignal));
		editor.handleInput("\x1b[C");
		expect(editor.getText()).toBe(draft + suggestion);
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

describe("next-prompt display and early naming", () => {
	it("shows the next prompt on an empty editor only after final settlement, without typing", async () => {
		vi.useFakeTimers();
		const h = harness({ name: "knowledge-graph-ceiba" });
		const editor = h.factory()(tui, theme, keys);
		editor.focused = true;
		h.ctx.isIdle = () => false;
		h.emit("agent_end");
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.stream).not.toHaveBeenCalled();
		h.ctx.isIdle = () => true;
		h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.stream).toHaveBeenCalledOnce();
		expect(JSON.parse((h.stream.mock.calls[0][1] as any).messages[0].content).draft).toBe("");
		expect((h.stream.mock.calls[0][1] as any).systemPrompt).toContain("2-12 words");
		h.response.resolve(answer("oke susun spec N5"));
		await vi.advanceTimersByTimeAsync(0);
		expect(editor.render(100)[0]).toContain("knowledge-graph-ceiba");
		expect(stripTerminalSequences(editor.render(100).join("\n"))).toContain("oke susun spec N5");
		expect(editor.getText()).toBe("");
		const submit = vi.fn();
		editor.onSubmit = submit;
		editor.handleInput("\t");
		expect(editor.getText()).toBe("oke susun spec N5");
		expect(submit).not.toHaveBeenCalled();
		h.emit("session_shutdown");
	});

	it("starts naming from the first prompt before the main response is complete", async () => {
		const h = harness();
		h.emit("before_agent_start", { messageType: "user", prompt: "Build a login form" });
		h.emit("agent_start");
		expect(h.stream).toHaveBeenCalledOnce();
		expect((h.stream.mock.calls[0][1] as any).messages[0].content).toBe("Build a login form");
		h.response.resolve(answer("Build Login Form"));
		await vi.waitFor(() => expect(h.pi.getSessionName()).toBe("Build Login Form"));
		h.emit("before_agent_start", { messageType: "user", prompt: "Add tests too" });
		expect(h.stream).toHaveBeenCalledOnce();
	});

	it("requests a 2-5 word topic title without cutting identifying names at 80 characters", async () => {
		const h = harness();
		h.emit("before_agent_start");
		expect((h.stream.mock.calls[0][1] as any).systemPrompt).toContain("2-5 words");
		const title = `${"Component".repeat(12)} regression`;
		h.response.resolve(answer(title));
		await vi.waitFor(() => expect(h.pi.getSessionName()).toBe(title));
	});

	it("does not name a session from custom messages or empty input", () => {
		const h = harness();
		h.emit("before_agent_start", { messageType: "custom" });
		h.emit("before_agent_start", { messageType: "user", prompt: "   " });
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("requests a next-prompt suggestion on resume or reload with an existing conversation", async () => {
		vi.useFakeTimers();
		const h = harness({ name: "Existing session" });
		h.factory()(tui, theme, keys);
		h.emit("session_start");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.stream).toHaveBeenCalledOnce();
		h.emit("session_shutdown");
		h.response.resolve(answer("Run the tests"));
	});

	it("shows the current name on the border, fits narrow widths, and preserves working status", () => {
		const editor = new ClaudePasteEditor(tui as never, theme as never, keys as never);
		let name = "knowledge-graph-ceiba-修正";
		let idle = true;
		const assist = attachSuggestions(
			editor,
			async () => "",
			() => idle,
			tui.requestRender,
			(text) => text,
			() => name,
		);
		expect(editor.render(80)[0]).toContain(name);
		for (const width of [1, 5, 12, 20, 80]) {
			expect(editor.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		name = "My manual title";
		assist.refresh();
		expect(editor.render(80)[0]).toContain(name);
		idle = false;
		expect(editor.render(80)[0]).not.toContain(name);
	});
});

describe("prompt assist enable/disable", () => {
	it("restores disabled state and does not infer on typing, settlement, reload, or first prompt", async () => {
		vi.useFakeTimers();
		vi.mocked(loadAssistEnabled).mockReturnValue(false);
		const h = harness();
		const editor = h.factory()(tui, theme, keys);
		editor.handleInput("write tests");
		h.emit("before_agent_start");
		h.emit("agent_settled");
		await vi.advanceTimersByTimeAsync(700);
		h.emit("session_start");
		await vi.advanceTimersByTimeAsync(700);
		expect(h.stream).not.toHaveBeenCalled();
		expect(h.ctx.modelRegistry.find).not.toHaveBeenCalled();
		h.emit("session_shutdown");
	});

	it("can turn assistance off without model credentials and saves the choice", async () => {
		const h = harness();
		h.ctx.modelRegistry.getAvailable.mockReturnValue([]);
		await h.command("off");
		expect(saveAssistEnabled).toHaveBeenCalledWith(expect.any(String), false);
		expect(h.ctx.modelRegistry.getAvailable).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("disabled"), "info");
		expect(h.completions("off")).toContainEqual({ value: "off", label: "off" });
	});

	it("enables suggestions immediately and saves the choice", async () => {
		vi.useFakeTimers();
		vi.mocked(loadAssistEnabled).mockReturnValue(false);
		const h = harness({ name: "Existing title" });
		const editor = h.factory()(tui, theme, keys);
		editor.focused = true;
		await h.command("on");
		await vi.advanceTimersByTimeAsync(0);
		expect(saveAssistEnabled).toHaveBeenCalledWith(expect.any(String), true);
		expect(h.stream).toHaveBeenCalledOnce();
		h.response.resolve(answer("Run the tests"));
		await vi.advanceTimersByTimeAsync(0);
		editor.handleInput("\x1b[C");
		expect(editor.getText()).toBe("Run the tests");
		h.emit("session_shutdown");
	});

	it("aborts a pending suggestion, clears ghost text, and preserves the draft and session name", async () => {
		vi.useFakeTimers();
		const h = harness({ name: "Manual title" });
		const editor = h.factory()(tui, theme, keys);
		editor.focused = true;
		editor.handleInput("write");
		await vi.advanceTimersByTimeAsync(700);
		const options = h.stream.mock.calls[0][2] as { signal: AbortSignal };
		await h.command("off");
		expect(options.signal.aborted).toBe(true);
		h.response.resolve(answer(" obsolete suggestion"));
		await vi.advanceTimersByTimeAsync(0);
		expect(editor.render(100).join("\n")).not.toContain("obsolete suggestion");
		expect(editor.render(100)[0]).toContain("Manual title");
		expect(editor.getText()).toBe("write");
		expect(h.pi.getSessionName()).toBe("Manual title");
		h.emit("session_shutdown");
	});

	it("discards an in-flight automatic name when disabled", async () => {
		const h = harness();
		h.emit("before_agent_start");
		await h.command("off");
		h.response.resolve(answer("Obsolete title"));
		await new Promise((done) => setTimeout(done, 0));
		expect(h.pi.setSessionName).not.toHaveBeenCalled();
	});

	it("keeps assistance disabled when selecting a different model", async () => {
		vi.mocked(loadAssistEnabled).mockReturnValue(false);
		const h = harness();
		await h.command("custom/vendor/fast-model");
		h.emit("before_agent_start");
		expect(saveAssistModel).toHaveBeenCalledWith(expect.any(String), "custom/vendor/fast-model");
		expect(saveAssistEnabled).not.toHaveBeenCalled();
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("applies the toggle for this session even if saving fails", async () => {
		const h = harness();
		vi.mocked(saveAssistEnabled).mockImplementation(() => {
			throw new Error("read-only");
		});
		await h.command("off");
		h.emit("before_agent_start");
		expect(h.stream).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("could not save"), "warning");
	});
});

describe("prompt assist model selection", () => {
	it("selects any available Pi model, saves it, and uses it for naming without MiMo-specific parameters", async () => {
		const h = harness();
		await h.command("custom/vendor/fast-model");
		expect(saveAssistModel).toHaveBeenCalledWith(expect.any(String), "custom/vendor/fast-model");
		h.emit("before_agent_start");
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
		h.emit("before_agent_start");
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
		h.emit("before_agent_start");
		expect(h.ctx.modelRegistry.find).toHaveBeenCalledWith("custom", "vendor/fast-model");
		h.emit("session_shutdown");
		h.response.resolve(answer("Ignored"));
	});
});

describe("session assistance", () => {
	it("names once in the background, uses MiMo with session affinity, and allows subsequent manual rename", async () => {
		const h = harness();
		expect(h.emit("before_agent_start")).toBeUndefined();
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
		h.emit("before_agent_start");
		expect(h.pi.getSessionName()).toBe("My custom title");
		expect(h.stream).toHaveBeenCalledTimes(1);
	});

	it("never overwrites a manual rename during generation", async () => {
		const h = harness();
		h.emit("before_agent_start");
		h.pi.setSessionName("Manual title");
		h.response.resolve(answer("Automatic title"));
		await new Promise((done) => setTimeout(done, 0));
		expect(h.pi.getSessionName()).toBe("Manual title");
		expect(h.pi.setSessionName).toHaveBeenCalledTimes(1);
	});

	it("skips named sessions and previously cleared names", () => {
		for (const options of [{ name: "Existing" }, { entries: [{ type: "session_info", name: "" }] }]) {
			const h = harness(options);
			h.emit("before_agent_start");
			expect(h.stream).not.toHaveBeenCalled();
		}
	});

	it("discards naming after switching sessions or shutting down", async () => {
		for (const event of ["session_start", "session_shutdown"]) {
			const h = harness();
			h.emit("before_agent_start");
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
		h.emit("before_agent_start");
		h.emit("before_agent_start");
		expect(h.stream).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledOnce();
	});
});
