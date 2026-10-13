import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";
import { PANE_ENV } from "../ext/agent-view/tmux.ts";
import remoteFactory from "../ext/remote/index.ts";
import { applyPaneMessage, buildReport, navigate } from "../ext/remote/report.ts";

const model = (provider: string, id: string, name?: string, reasoning = false) => ({ provider, id, name, reasoning });

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	cost: { total },
});

function fakes(
	options: {
		current?: ReturnType<typeof model>;
		available?: ReturnType<typeof model>[];
		idle?: boolean;
		commands?: string[];
	} = {},
) {
	const available = options.available ?? [];
	const ctx = {
		model: options.current,
		modelRegistry: {
			getAvailable: () => available,
			find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id),
		},
		getContextUsage: () => ({ tokens: 12_000, contextWindow: 200_000, percent: 6 }),
		sessionManager: {
			getEntries: () => [
				{ type: "message", message: { role: "user", content: "hi" } },
				{ type: "message", message: { role: "assistant", usage: usage(100, 20, 1000, 200, 0.5) } },
				{ type: "model_change" },
				{ type: "message", message: { role: "assistant", usage: usage(50, 5, 0, 0, 0.25) } },
				// Counted as pi's footer counts them: usage entries, tool results and summaries too.
				{ type: "usage", usage: usage(10, 2, 0, 0, 0.125) },
				{ type: "message", message: { role: "toolResult", usage: usage(5, 1, 0, 0, 0.0625) } },
				{ type: "message", message: { role: "toolResult" } },
				{ type: "compaction", usage: usage(3, 1, 0, 30, 0.03125) },
				{ type: "compaction" },
				{ type: "branch_summary", usage: usage(2, 1, 0, 0, 0.015625) },
			],
		},
		isIdle: () => options.idle ?? true,
		compact: vi.fn(),
	};
	const pi = {
		getThinkingLevel: () => "high",
		setModel: vi.fn(async () => true),
		sendUserMessage: vi.fn(),
		getCommands: () => (options.commands ?? ["remote-control"]).map((name) => ({ name, source: "extension" })),
	};
	return { ctx, pi };
}

describe("buildReport", () => {
	it("reports the model, the models to pick from, thinking, context and session usage", () => {
		const opus = model("anthropic", "claude-opus", "Opus", true);
		const { ctx, pi } = fakes({
			current: opus,
			available: [
				model("openai", "gpt-5", "GPT-5"),
				model("anthropic", "claude-sonnet", "Sonnet"),
				opus,
				model("anthropic", "claude-sonnet", "Sonnet"),
			],
		});
		expect(buildReport(ctx as never, pi as never)).toEqual({
			model: { provider: "anthropic", id: "claude-opus", name: "Opus" },
			models: [
				{ provider: "anthropic", id: "claude-opus", name: "Opus" },
				{ provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
				{ provider: "openai", id: "gpt-5", name: "GPT-5" },
			],
			thinkingLevel: "high",
			context: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
			usage: { input: 170, output: 30, cacheRead: 1000, cacheWrite: 230, cost: 0.984375 },
		});
	});

	it("lists the current model even when it is not available, and no thinking for a model without it", () => {
		const { ctx, pi } = fakes({ current: model("local", "llama") });
		const report = buildReport(ctx as never, pi as never);
		expect(report.models).toEqual([{ provider: "local", id: "llama" }]);
		expect(report.thinkingLevel).toBeUndefined();
	});

	it("has no model before one is selected", () => {
		const { ctx, pi } = fakes();
		const report = buildReport(ctx as never, pi as never);
		expect(report.model).toBeUndefined();
		expect(report.models).toEqual([]);
	});
});

describe("applyPaneMessage", () => {
	it("switches to a model the registry knows, and ignores one it does not", () => {
		const sonnet = model("anthropic", "claude-sonnet", "Sonnet");
		const { ctx, pi } = fakes({ available: [sonnet] });
		applyPaneMessage({ type: "set_model", provider: "anthropic", id: "claude-sonnet" }, ctx as never, pi as never);
		expect(pi.setModel).toHaveBeenCalledWith(sonnet);
		applyPaneMessage({ type: "set_model", provider: "anthropic", id: "nope" }, ctx as never, pi as never);
		expect(pi.setModel).toHaveBeenCalledTimes(1);
	});

	it("compacts, and reports again when pi refuses, so the phone stops showing it as compacting", () => {
		const { ctx, pi } = fakes();
		const reportAgain = vi.fn();
		applyPaneMessage({ type: "compact" }, ctx as never, pi as never, reportAgain);
		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(reportAgain).not.toHaveBeenCalled();
		const [options] = ctx.compact.mock.calls[0] as unknown as [{ onError: (error: Error) => void }];
		options.onError(new Error("Nothing to compact (session too small)"));
		expect(reportAgain).toHaveBeenCalledTimes(1);
	});

	it("does not compact a session that is not idle, since compacting aborts its turn, and reports again", () => {
		const { ctx, pi } = fakes({ idle: false });
		const reportAgain = vi.fn();
		applyPaneMessage({ type: "compact" }, ctx as never, pi as never, reportAgain);
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(reportAgain).toHaveBeenCalledTimes(1);
	});

	it("ignores messages it does not handle", () => {
		const { ctx, pi } = fakes();
		applyPaneMessage({ type: "rename", name: "x" }, ctx as never, pi as never);
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});

describe("tree, fork and clone from the phone", () => {
	it("dispatches each as a /remote-control command, which pi runs without writing a message", () => {
		const { ctx, pi } = fakes();
		applyPaneMessage({ type: "tree", entryId: "1a2b3c4d" }, ctx as never, pi as never);
		applyPaneMessage({ type: "fork", entryId: "1a2b3c4d" }, ctx as never, pi as never);
		applyPaneMessage({ type: "clone" }, ctx as never, pi as never);
		expect(pi.sendUserMessage.mock.calls).toEqual([
			["/remote-control tree 1a2b3c4d", { expandPromptTemplates: true }],
			["/remote-control fork 1a2b3c4d", { expandPromptTemplates: true }],
			["/remote-control clone", { expandPromptTemplates: true }],
		]);
	});

	// Two extensions with the command make pi name them remote-control:1 and :2: the text would reach the model.
	it("dispatches nothing when /remote-control is not this extension's command by that name", () => {
		for (const commands of [["remote-control:1", "remote-control:2"], []]) {
			const { ctx, pi } = fakes({ commands });
			applyPaneMessage({ type: "clone" }, ctx as never, pi as never);
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		}
		const { ctx, pi } = fakes();
		pi.getCommands = () => [{ name: "remote-control", source: "prompt" }];
		applyPaneMessage({ type: "clone" }, ctx as never, pi as never);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("dispatches nothing while the session is not idle", () => {
		const { ctx, pi } = fakes({ idle: false });
		applyPaneMessage({ type: "tree", entryId: "1a2b3c4d" }, ctx as never, pi as never);
		applyPaneMessage({ type: "fork", entryId: "1a2b3c4d" }, ctx as never, pi as never);
		applyPaneMessage({ type: "clone" }, ctx as never, pi as never);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});

describe("navigate", () => {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-navigate-"));
	const saved = join(dir, "saved.jsonl");
	writeFileSync(saved, "");
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	function command(options: { file?: string; leaf?: string | null; draft?: string } = {}) {
		const entries = new Map<string, unknown>([
			["aaaa0001", { type: "message", id: "aaaa0001", message: { role: "user", content: "hi" } }],
			["aaaa0002", { type: "message", id: "aaaa0002", message: { role: "assistant", content: [] } }],
		]);
		return {
			sessionManager: {
				getEntry: (id: string) => entries.get(id),
				getLeafId: () => (options.leaf === undefined ? "aaaa0002" : options.leaf),
				getSessionFile: () => options.file ?? saved,
			},
			navigateTree: vi.fn(async () => ({ cancelled: false })),
			fork: vi.fn(async () => ({ cancelled: false })),
			ui: { getEditorText: () => options.draft ?? "" },
		};
	}

	it("goes back to an entry, forks before a user message, and clones at the leaf", async () => {
		const ctx = command();
		expect(await navigate("tree aaaa0002", ctx as never)).toBe(true);
		expect(await navigate("fork aaaa0001", ctx as never)).toBe(true);
		expect(await navigate(" clone ", ctx as never)).toBe(true);
		expect(ctx.navigateTree.mock.calls).toEqual([["aaaa0002"]]);
		expect(ctx.fork.mock.calls).toEqual([
			["aaaa0001", { position: "before" }],
			["aaaa0002", { position: "at" }],
		]);
	});

	it("does not fork or clone over a draft in the pane's editor, which pi would replace", async () => {
		const ctx = command({ draft: "half a thought" });
		expect(await navigate("fork aaaa0001", ctx as never)).toBe(true);
		expect(await navigate("clone", ctx as never)).toBe(true);
		expect(ctx.fork).not.toHaveBeenCalled();
		// pi fills only an empty editor on a tree move.
		expect(await navigate("tree aaaa0002", ctx as never)).toBe(true);
		expect(ctx.navigateTree).toHaveBeenCalledTimes(1);
	});

	it("leaves anything else to the public subcommands", async () => {
		const ctx = command();
		for (const args of ["", "pair", "devices", "tree", "fork", "tree a b", "fork aaaa0001 x", "clone x", "treex"]) {
			expect(await navigate(args, ctx as never)).toBe(false);
		}
		expect(ctx.navigateTree).not.toHaveBeenCalled();
		expect(ctx.fork).not.toHaveBeenCalled();
	});

	// pi ends the pane when a fork throws, so none of these may reach it.
	it("does nothing for an unknown entry, a fork from a reply, an empty session or an unsaved file", async () => {
		const ctx = command();
		expect(await navigate("tree ffff0000", ctx as never)).toBe(true);
		expect(await navigate("fork ffff0000", ctx as never)).toBe(true);
		expect(await navigate("fork aaaa0002", ctx as never)).toBe(true);
		const empty = command({ leaf: null });
		expect(await navigate("clone", empty as never)).toBe(true);
		const unsaved = command({ file: join(dir, "unsaved.jsonl") });
		expect(await navigate("fork aaaa0001", unsaved as never)).toBe(true);
		expect(await navigate("clone", unsaved as never)).toBe(true);
		for (const c of [ctx, empty, unsaved]) {
			expect(c.navigateTree).not.toHaveBeenCalled();
			expect(c.fork).not.toHaveBeenCalled();
		}
	});
});

describe("/remote-control", () => {
	function register() {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			on: () => {},
			events: { on: () => {} },
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		};
		remoteFactory(pi as never);
		if (!handler) throw new Error("not registered");
		return handler;
	}

	it("shows the same usage for an unknown or malformed subcommand, internal ones included", async () => {
		const handler = register();
		for (const args of ["nope", "tree", "fork a b", "clone x"]) {
			const notify = vi.fn();
			await handler(args, { ui: { notify } });
			expect(notify.mock.calls).toEqual([["Usage: /remote-control [pair | devices | autostart]", "warning"]]);
		}
	});

	it("reports at once when the daemon asks for it, as a restarted one does", async () => {
		const sent = vi.spyOn(OrchestratorClient.prototype, "remoteReport").mockResolvedValue();
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
			events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
			registerCommand: () => {},
			getThinkingLevel: () => "off",
		};
		process.env[PANE_ENV] = "pi-report";
		try {
			remoteFactory(pi as never);
		} finally {
			delete process.env[PANE_ENV];
		}
		const { ctx } = fakes({ current: model("openai", "gpt-5") });
		handlers.get("session_start")?.({}, { ...ctx, mode: "tui" });
		handlers.get("bluclawd:remote-want-report")?.(true);
		await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
		expect(sent.mock.calls.map(([pane]) => pane)).toEqual(["pi-report", "pi-report"]);
		sent.mockRestore();
	});

	it("runs the phone's tree, fork and clone without a word to the user", async () => {
		const handler = register();
		const notify = vi.fn();
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const entry = { type: "message", id: "aaaa0001", message: { role: "user", content: "hi" } };
		const sessionManager = { getEntry: () => entry, getSessionFile: () => undefined, getLeafId: () => "aaaa0001" };
		await handler("tree aaaa0001", { ui: { notify }, sessionManager, navigateTree });
		expect(navigateTree).toHaveBeenCalledWith("aaaa0001");
		expect(notify).not.toHaveBeenCalled();
	});
});
