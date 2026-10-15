import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { PANE_ENV, Tmux } from "../daemon/tmux.ts";
import { type BackgroundExec, backgroundBashJobs } from "../ext/background-bash/background-bash.ts";
import { detachableExec, runningForegroundShells } from "../ext/background-bash/foreground-shells.ts";
import { projectTrust, TRUST_CHANGED } from "../ext/permissions/index.ts";
import remoteFactory, { USAGE } from "../ext/remote/index.ts";
import {
	applyPaneMessage,
	BUSY_NOTICE,
	buildReport,
	DIALOG_NOTICE,
	DRAFT_NOTICE,
	navigate,
	paneTasks,
	submitCommand,
	watchTasks,
} from "../ext/remote/report.ts";

const model = (provider: string, id: string, name?: string, reasoning = false) => ({ provider, id, name, reasoning });
/** The trust mode, without reading the developer's own settings. */
const ask = () => "ask" as const;

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
		cwd?: string;
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
			getSessionId: () => "report-session",
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
		cwd: options.cwd ?? "/proj",
		isProjectTrusted: () => true,
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
			theme: { fg: (_color: string, text: string) => text, getColorMode: () => "256" },
			// The TUI a widget is drawn in: its prompt has the keyboard.
			setWidget: (_key: string, factory?: (tui: unknown) => unknown) =>
				factory?.({ hasOverlay: () => false, getFocusedComponent: () => ({ getText: () => "" }) }),
		},
	};
	const pi = {
		getThinkingLevel: vi.fn(() => "high"),
		setThinkingLevel: vi.fn(),
		events: { emit: vi.fn() },
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
		const { commands, ...report } = buildReport(ctx as never, pi as never, ask);
		expect(commands?.length).toBeGreaterThan(0);
		expect(report).toEqual({
			model: { provider: "anthropic", id: "claude-opus", name: "Opus" },
			models: [
				{ provider: "anthropic", id: "claude-opus", name: "Opus" },
				{ provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
				{ provider: "openai", id: "gpt-5", name: "GPT-5" },
			],
			thinkingLevel: "high",
			thinkingLevels: ["off", "minimal", "low", "medium", "high"],
			context: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
			usage: { input: 170, output: 30, cacheRead: 1000, cacheWrite: 230, cost: 0.984375 },
			trust: "ask",
			tasks: [],
		});
	});

	it("offers only the scoped models when pi has a scope (enabledModels, --models), as its /model does", () => {
		const opus = model("anthropic", "claude-opus", "Opus", true);
		const sonnet = model("anthropic", "claude-sonnet", "Sonnet");
		const gpt = model("openai", "gpt-5", "GPT-5");
		const { ctx, pi } = fakes({ current: opus, available: [opus, sonnet, gpt] });
		const scopedCtx = { ...ctx, scopedModels: [{ model: gpt }, { model: sonnet, thinkingLevel: "low" }] };
		expect(buildReport(scopedCtx as never, pi as never, ask).models).toEqual([
			{ provider: "anthropic", id: "claude-opus", name: "Opus" },
			{ provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
			{ provider: "openai", id: "gpt-5", name: "GPT-5" },
		]);
		// An empty scope is no scope: every available model.
		const unscoped = { ...ctx, scopedModels: [] };
		expect(buildReport(unscoped as never, pi as never, ask).models).toHaveLength(3);
		const narrow = { ...ctx, current: undefined, model: sonnet, scopedModels: [{ model: sonnet }] };
		expect(buildReport(narrow as never, pi as never, ask).models).toEqual([
			{ provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
		]);
	});

	it("lists the current model even when it is not available, and no thinking for a model without it", () => {
		const { ctx, pi } = fakes({ current: model("local", "llama") });
		const report = buildReport(ctx as never, pi as never, ask);
		expect(report.models).toEqual([{ provider: "local", id: "llama" }]);
		expect(report.thinkingLevel).toBeUndefined();
		expect(report.thinkingLevels).toBeUndefined();
	});

	it("offers the thinking levels pi offers for the model: xhigh and max only where it maps them", () => {
		const gpt = { ...model("openai", "gpt-5", "GPT-5", true), thinkingLevelMap: { minimal: null, xhigh: "xhigh" } };
		const { ctx, pi } = fakes({ current: gpt });
		expect(buildReport(ctx as never, pi as never, ask).thinkingLevels).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	it("lists the slash commands for the phone's autocomplete: pi's own, then the rest, but for the Mac-only ones", () => {
		const { ctx, pi } = fakes();
		const commands = [
			{ name: "remote-control", source: "extension", description: "Control your sessions from your phone" },
			{ name: "agent-view", source: "extension" },
			{ name: "tasks", source: "extension", description: "View and manage everything running in the background" },
			{ name: "review", source: "prompt", description: `  ${"Review the diff. ".repeat(20)}` },
			{ name: "skill:pdf", source: "skill", description: "" },
		];
		const report = buildReport(ctx as never, { ...pi, getCommands: () => commands } as never, ask);
		const names = report.commands!.map((c) => c.name);
		expect(names.slice(0, 3)).toEqual(["settings", "model", "tree"]);
		expect(names).toContain("compact");
		expect(names).not.toContain("remote-control");
		expect(names).not.toContain("agent-view");
		expect(report.commands!.slice(-3)).toEqual([
			{ name: "tasks", description: "View and manage everything running in the background", source: "extension" },
			{ name: "review", description: `${"Review the diff. ".repeat(20).trim().slice(0, 99)}…`, source: "prompt" },
			{ name: "skill:pdf", source: "skill" },
		]);
		expect(report.commands!.find((c) => c.name === "compact")).toEqual({
			name: "compact",
			description: "Manually compact the session context",
			source: "builtin",
		});
	});

	it("has no model before one is selected", () => {
		const { ctx, pi } = fakes();
		const report = buildReport(ctx as never, pi as never, ask);
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

/** pi's settings in a temporary home, never the developer's own. */
function tempHome(): { settings: () => string; dir: () => string } {
	let home = "";
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-remote-home-"));
		for (const key of Object.keys(process.env)) if (key.endsWith("_CODING_AGENT_DIR")) vi.stubEnv(key, undefined);
		vi.stubEnv("HOME", home);
		expect(getAgentDir().startsWith(home)).toBe(true);
		mkdirSync(getAgentDir(), { recursive: true });
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));
	return { settings: () => join(getAgentDir(), "settings.json"), dir: () => home };
}

describe("thinking level and trust mode from the phone", () => {
	const home = tempHome();
	const opus = model("anthropic", "claude-opus", "Opus", true);

	it("sets a thinking level pi offers for the model, which pi reports", () => {
		const { ctx, pi } = fakes({ current: opus });
		const reportAgain = vi.fn();
		applyPaneMessage({ type: "set_thinking", level: "low" }, ctx as never, pi as never, reportAgain);
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("low");
		expect(reportAgain).not.toHaveBeenCalled();
	});

	it("reports again, changing nothing, for a level the model lacks, its level already, or a model without thinking", () => {
		for (const [current, level] of [
			[opus, "xhigh"],
			[opus, "high"],
			[opus, "turbo"],
			[model("local", "llama"), "low"],
		] as const) {
			const { ctx, pi } = fakes({ current });
			const reportAgain = vi.fn();
			applyPaneMessage({ type: "set_thinking", level }, ctx as never, pi as never, reportAgain);
			expect(pi.setThinkingLevel).not.toHaveBeenCalled();
			expect(reportAgain).toHaveBeenCalledTimes(1);
		}
	});

	it("sets the trust mode as Alt+M does: saved to global settings, the badge redrawn, and announced", async () => {
		writeFileSync(home.settings(), JSON.stringify({ defaultProjectTrust: "always" }));
		const { ctx, pi } = fakes({ cwd: home.dir() });
		applyPaneMessage({ type: "set_trust", trust: "never" }, ctx as never, pi as never);
		await vi.waitFor(() => expect(pi.events.emit).toHaveBeenCalledWith(TRUST_CHANGED, "never"));
		expect(JSON.parse(readFileSync(home.settings(), "utf8")).defaultProjectTrust).toBe("never");
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("1-mode", "✕ never (alt+m to cycle)");
		expect(projectTrust(ctx as never)).toBe("never");
	});

	it("ignores a trust mode Alt+M does not cycle through", () => {
		writeFileSync(home.settings(), JSON.stringify({ defaultProjectTrust: "ask" }));
		const { ctx, pi } = fakes({ cwd: home.dir() });
		applyPaneMessage({ type: "set_trust", trust: "sometimes" as never }, ctx as never, pi as never);
		expect(pi.events.emit).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(home.settings(), "utf8")).defaultProjectTrust).toBe("ask");
	});

	it("reports the trust mode in pi's settings", () => {
		writeFileSync(home.settings(), JSON.stringify({ defaultProjectTrust: "never" }));
		const { ctx, pi } = fakes({ cwd: home.dir() });
		expect(buildReport(ctx as never, pi as never).trust).toBe("never");
	});
});

describe("tree, fork and clone from the phone", () => {
	it("dispatches each as a /remote-control command, which pi runs without writing a message", () => {
		const { ctx, pi } = fakes();
		const dispatched = new Set<string>();
		const reportAgain = () => {};
		applyPaneMessage({ type: "tree", entryId: "1a2b3c4d" }, ctx as never, pi as never, reportAgain, dispatched);
		applyPaneMessage({ type: "fork", entryId: "1a2b3c4d" }, ctx as never, pi as never, reportAgain, dispatched);
		applyPaneMessage({ type: "clone" }, ctx as never, pi as never, reportAgain, dispatched);
		expect(pi.sendUserMessage.mock.calls).toEqual([
			["/remote-control tree 1a2b3c4d", { expandPromptTemplates: true }],
			["/remote-control fork 1a2b3c4d", { expandPromptTemplates: true }],
			["/remote-control clone", { expandPromptTemplates: true }],
		]);
		// What the command runs: the same line typed is not the phone's.
		expect([...dispatched]).toEqual(["tree 1a2b3c4d", "fork 1a2b3c4d", "clone"]);
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

describe("slash commands from the phone", () => {
	const setup = (options: { idle?: boolean; draft?: string; overlay?: boolean; focused?: unknown } = {}) => {
		const editor = { text: options.draft ?? "" };
		const ctx = {
			isIdle: () => options.idle ?? true,
			ui: {
				getEditorText: () => editor.text,
				setEditorText: vi.fn((text: string) => {
					editor.text = text;
				}),
			},
		};
		const tui = {
			hasOverlay: () => options.overlay ?? false,
			getFocusedComponent: () => ("focused" in options ? options.focused : { getText: () => editor.text }),
		};
		return { ctx, tui, editor, enter: vi.fn(), refuse: vi.fn() };
	};

	it("puts the command in the empty prompt and presses Enter there, as typed on the Mac", () => {
		const { ctx, tui, editor, enter, refuse } = setup();
		submitCommand("/compact keep the API notes", ctx as never, tui as never, enter, refuse);
		expect(editor.text).toBe("/compact keep the API notes");
		expect(enter).toHaveBeenCalledTimes(1);
		expect(refuse).not.toHaveBeenCalled();
	});

	it("refuses, saying why, while a turn runs, a dialog has the keyboard, or the prompt holds a draft", () => {
		const cases: Array<[Parameters<typeof setup>[0], string]> = [
			[{ idle: false }, BUSY_NOTICE],
			[{ overlay: true }, DIALOG_NOTICE],
			// A selector pi shows in the prompt's place, such as /model's.
			[{ focused: { handleInput: () => {} } }, DIALOG_NOTICE],
			[{ draft: "half a thought" }, DRAFT_NOTICE],
		];
		for (const [options, notice] of cases) {
			const { ctx, tui, editor, enter, refuse } = setup(options);
			const before = editor.text;
			submitCommand("/model", ctx as never, tui as never, enter, refuse);
			expect(refuse).toHaveBeenCalledWith(notice);
			expect(enter).not.toHaveBeenCalled();
			expect(editor.text).toBe(before);
		}
		const { ctx, enter, refuse } = setup();
		submitCommand("/model", ctx as never, undefined, enter, refuse);
		expect(refuse).toHaveBeenCalledWith(DIALOG_NOTICE);
	});

	it("takes the command back out of the prompt when Enter cannot be pressed", () => {
		const { ctx, tui, editor, refuse } = setup();
		const enter = vi.fn(() => {
			throw new Error("tmux: no server running");
		});
		submitCommand("/new", ctx as never, tui as never, enter, refuse);
		expect(editor.text).toBe("");
		expect(refuse).toHaveBeenCalledTimes(1);
	});
});

describe("background tasks for the phone", () => {
	const forever: BackgroundExec = (_c, _w, { signal }) =>
		new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
	let owner = 0;
	const session = () => `phone-tasks-${++owner}`;
	afterEach(() => {
		for (const job of backgroundBashJobs.list()) backgroundBashJobs.kill(job.id);
	});

	it("lists the session's running tasks as /tasks does, bounded, with where a shell writes its output", async () => {
		const me = session();
		backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever });
		backgroundBashJobs.start({ command: `echo ${"x".repeat(300)}`, cwd: "/", owner: me, exec: forever });
		backgroundBashJobs.start({ command: "true", cwd: "/", owner: me, exec: async () => ({ exitCode: 0 }) });
		backgroundBashJobs.start({ command: "someone else's", cwd: "/", owner: session(), exec: forever });
		await new Promise((r) => setTimeout(r, 0));
		const tasks = paneTasks(me);
		expect(tasks.map((t) => [t.kind, t.label.slice(0, 11)])).toEqual([
			["shell", "echo xxxxxx"],
			["shell", "npm run dev"],
		]);
		expect(tasks[0]!.label).toHaveLength(200);
		const job = backgroundBashJobs.get(tasks[1]!.id)!;
		expect(tasks[1]).toEqual({
			id: job.id,
			kind: "shell",
			label: "npm run dev",
			startedAt: job.startedAt,
			...(job.outputFile ? { outputFile: job.outputFile } : {}),
		});
	});

	it("stops one as the user, whether a turn runs or not, and reports again for one that is gone", async () => {
		const me = session();
		const id = backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever }).id;
		const { ctx, pi } = fakes({ idle: false });
		const busy = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => me } };
		const reportAgain = vi.fn();
		applyPaneMessage({ type: "stop_task", id }, busy as never, pi as never, reportAgain);
		await new Promise((r) => setTimeout(r, 0));
		expect(backgroundBashJobs.get(id)).toMatchObject({ killed: true, stoppedByUser: true });
		expect(reportAgain).not.toHaveBeenCalled();
		applyPaneMessage({ type: "stop_task", id: "b-gone" }, busy as never, pi as never, reportAgain);
		expect(reportAgain).toHaveBeenCalledTimes(1);
	});

	it("looks again once tasks start or end, and once the model's bash has run 2s in the foreground", async () => {
		vi.useFakeTimers();
		try {
			const check = vi.fn();
			const stop = watchTasks(check);
			const job = backgroundBashJobs.start({ command: "npm run dev", cwd: "/", exec: forever });
			backgroundBashJobs.start({ command: "tail -f log", cwd: "/", exec: forever });
			await vi.advanceTimersByTimeAsync(300);
			// Two starts this close: one look.
			expect(check).toHaveBeenCalledTimes(1);
			backgroundBashJobs.kill(job.id);
			await vi.advanceTimersByTimeAsync(300);
			expect(check).toHaveBeenCalledTimes(2);
			const run = detachableExec(forever)("sleep 60", "/", { onData: () => {} });
			await vi.advanceTimersByTimeAsync(300);
			expect(check).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(2000);
			expect(check).toHaveBeenCalledTimes(4);
			stop();
			for (const shell of runningForegroundShells()) shell.stop();
			await run.catch(() => {});
			backgroundBashJobs.start({ command: "after", cwd: "/", exec: forever });
			await vi.advanceTimersByTimeAsync(3000);
			expect(check).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
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

	it("does not fork or clone over a draft in the pane's editor, which pi would replace, and says why", async () => {
		const ctx = command({ draft: "half a thought" });
		const refuse = vi.fn();
		expect(await navigate("fork aaaa0001", ctx as never, refuse)).toBe(true);
		expect(await navigate("clone", ctx as never, refuse)).toBe(true);
		expect(ctx.fork).not.toHaveBeenCalled();
		expect(refuse.mock.calls).toEqual([[DRAFT_NOTICE], [DRAFT_NOTICE]]);
		// pi fills only an empty editor on a tree move.
		expect(await navigate("tree aaaa0002", ctx as never, refuse)).toBe(true);
		expect(ctx.navigateTree).toHaveBeenCalledTimes(1);
		expect(refuse).toHaveBeenCalledTimes(2);
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
	tempHome();

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

	it("shows the same usage for an unknown or malformed subcommand, and for the phone's own typed by hand", async () => {
		const handler = register();
		const navigateTree = vi.fn();
		const fork = vi.fn();
		for (const args of ["nope", "tree", "fork a b", "clone x", "clone", "tree aaaa0001", "fork aaaa0001"]) {
			const notify = vi.fn();
			await handler(args, { ui: { notify, getEditorText: () => "" }, navigateTree, fork });
			expect(notify.mock.calls).toEqual([[USAGE, "warning"]]);
		}
		expect(navigateTree).not.toHaveBeenCalled();
		expect(fork).not.toHaveBeenCalled();
	});

	it("reports at once when the daemon asks for it, as a restarted one does, and when the trust mode changes", async () => {
		const sent = vi.spyOn(OrchestratorClient.prototype, "remoteReport").mockResolvedValue();
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
			events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
			registerCommand: () => {},
			getThinkingLevel: () => "off",
			getCommands: () => [],
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
		// Alt+M on the Mac, or the phone's picker: the phone's bar shows the new mode.
		handlers.get(TRUST_CHANGED)?.("never");
		await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(3));
		sent.mockRestore();
	});

	it("lets go at session end: no report from the bus, and no live snapshot left to send", async () => {
		const reported = vi.spyOn(OrchestratorClient.prototype, "remoteReport").mockResolvedValue();
		const live = vi.spyOn(OrchestratorClient.prototype, "remoteLive").mockResolvedValue();
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
			events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
			registerCommand: () => {},
			getThinkingLevel: () => "off",
			getCommands: () => [],
		};
		process.env[PANE_ENV] = "pi-report";
		try {
			remoteFactory(pi as never);
		} finally {
			delete process.env[PANE_ENV];
		}
		const { ctx } = fakes({ current: model("openai", "gpt-5") });
		handlers.get("session_start")?.({}, { ...ctx, mode: "tui" });
		handlers.get("bluclawd:remote-watched")?.(true);
		const said = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });
		handlers.get("message_update")?.(said("a"));
		// Within the interval: held for a timer, which the session's end must not leave behind.
		handlers.get("message_update")?.(said("ab"));
		handlers.get("session_shutdown")?.({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(live.mock.calls.map(([, snapshot]) => snapshot === null)).toEqual([false, true]);
		const reports = reported.mock.calls.length;
		handlers.get("bluclawd:remote-want-report")?.(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(reported.mock.calls.length).toBe(reports);
		reported.mockRestore();
		live.mockRestore();
	});

	it("runs the phone's tree, fork and clone without a word to the user, and tells the phone why one did not", async () => {
		const sent = vi.spyOn(OrchestratorClient.prototype, "remoteReport").mockResolvedValue();
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const { ctx: base, pi: fake } = fakes({ current: model("openai", "gpt-5") });
		const entry = { type: "message", id: "aaaa0001", message: { role: "user", content: "hi" } };
		let draft = "";
		const ctx = {
			...base,
			mode: "tui",
			sessionManager: {
				...base.sessionManager,
				getEntry: () => entry,
				getSessionFile: () => undefined,
				getLeafId: () => "aaaa0001",
			},
			navigateTree: vi.fn(async () => ({ cancelled: false })),
			fork: vi.fn(async () => ({ cancelled: false })),
			ui: { ...base.ui, getEditorText: () => draft },
		};
		const pi = {
			...fake,
			on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
			events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
			registerCommand: (_name: string, registered: { handler: typeof command }) => {
				command = registered.handler;
			},
			// As pi does with expandPromptTemplates: the line runs the extension's command.
			sendUserMessage: vi.fn((text: string) => void command?.(text.slice("/remote-control ".length), ctx)),
		};
		process.env[PANE_ENV] = "pi-nav";
		try {
			remoteFactory(pi as never);
		} finally {
			delete process.env[PANE_ENV];
		}
		handlers.get("session_start")?.({}, ctx);
		await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
		handlers.get("bluclawd:pane-message")?.({ type: "tree", entryId: "aaaa0001" });
		await vi.waitFor(() => expect(ctx.navigateTree).toHaveBeenCalledWith("aaaa0001"));
		// A draft in the Mac's prompt: no fork, and the next report says why, that once.
		draft = "half a thought";
		handlers.get("bluclawd:pane-message")?.({ type: "fork", entryId: "aaaa0001" });
		await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
		expect(ctx.fork).not.toHaveBeenCalled();
		expect(sent.mock.calls[1]![1]).toMatchObject({ notice: { text: DRAFT_NOTICE, at: expect.any(Number) } });
		expect(sent.mock.calls[0]![1]).not.toHaveProperty("notice");
		draft = "";
		handlers.get("bluclawd:pane-message")?.({ type: "clone" });
		await vi.waitFor(() => expect(ctx.fork).toHaveBeenCalledWith("aaaa0001", { position: "at" }));
		expect(base.ui.notify).not.toHaveBeenCalled();
		sent.mockRestore();
	});

	it("types the phone's slash command into its own pane's prompt and presses Enter in that tmux session", async () => {
		const sent = vi.spyOn(OrchestratorClient.prototype, "remoteReport").mockResolvedValue();
		const pressed = vi.spyOn(Tmux.prototype, "sendKeys").mockImplementation(() => {});
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
		const { ctx: base, pi: fake } = fakes({ current: model("openai", "gpt-5") });
		let prompt = "";
		const ctx = {
			...base,
			mode: "tui",
			ui: {
				...base.ui,
				getEditorText: () => prompt,
				setEditorText: (text: string) => {
					prompt = text;
				},
			},
		};
		const pi = {
			...fake,
			on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
			events: { on: (name: string, handler: (data: unknown) => void) => handlers.set(name, handler) },
			registerCommand: () => {},
		};
		process.env[PANE_ENV] = "pi-cmd";
		try {
			remoteFactory(pi as never);
		} finally {
			delete process.env[PANE_ENV];
		}
		handlers.get("session_start")?.({}, ctx);
		await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
		handlers.get("bluclawd:pane-message")?.({ type: "command", text: "/compact" });
		expect(prompt).toBe("/compact");
		expect(pressed.mock.calls).toEqual([["pi-cmd", ["Enter"]]]);
		// Not idle: refused, and the phone told why.
		prompt = "";
		ctx.isIdle = () => false;
		handlers.get("bluclawd:pane-message")?.({ type: "command", text: "/compact" });
		await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
		expect(sent.mock.calls[1]![1]).toMatchObject({ notice: { text: BUSY_NOTICE } });
		expect(pressed).toHaveBeenCalledTimes(1);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		pressed.mockRestore();
		sent.mockRestore();
	});
});
