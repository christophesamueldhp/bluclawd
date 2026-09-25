import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView } from "../ext/agent-view/agent-view.ts";
import { withoutAgentViewCommand } from "../ext/agent-view/index.ts";
import { type InstanceSummary, type OrchestratorClient, piPackageRoot } from "../ext/agent-view/orchestrator-client.ts";
import {
	buildBands,
	collectRows,
	compactAge,
	labelFromTask,
	rowAge,
	rowFromSummary,
	stateFilter,
} from "../ext/agent-view/rows.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A theme whose styling is the identity, so assertions read plain text. */
const plainTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	getBgAnsi: () => "",
	getColorMode: () => "truecolor",
} as unknown as Theme;

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const HOME = "/home/me";
const HERE = `${HOME}/proj/here`;
const THERE = `${HOME}/proj/there`;

const ENTER = "\r";
const ESC = "\x1b";
const CTRL_X = "\x18";
const CTRL_S = "\x13";
const CTRL_T = "\x14";
const DOWN = "\x1b[B";

const sessions: InstanceSummary[] = [
	{
		id: "ask",
		status: "online",
		activity: "awaiting_input",
		cwd: HERE,
		label: "power-up design",
		createdAt: ago(1),
		needs: { requestId: "q1", method: "select", title: "Allow bash: npm test?", options: ["Yes", "No"] },
	},
	{
		id: "work",
		status: "online",
		activity: "working",
		cwd: THERE,
		label: "collision detection",
		detail: "Adding swept-AABB checks",
		createdAt: ago(2),
	},
	{
		id: "done",
		status: "online",
		activity: "idle",
		cwd: HERE,
		label: "title screen",
		outcome: "done",
		turns: 1,
		detail: "result: menu done",
		createdAt: ago(9),
		finishedAt: ago(3),
	},
	{
		id: "gone",
		status: "stopped",
		cwd: HERE,
		label: "sound effects",
		outcome: "failed",
		detail: "build broke",
		createdAt: ago(240),
		finishedAt: ago(200),
	},
];

type Calls = Array<[string, ...unknown[]]>;

function fakeClient(calls: Calls, list: () => InstanceSummary[] = () => sessions): OrchestratorClient {
	const record =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push([name, ...args]);
			return name === "spawn" ? { id: "new", status: "online", cwd: HERE } : undefined;
		};
	return {
		list: async () => list(),
		ensureDaemon: async () => true,
		getDaemonInfo: async () => ({ running: false }),
		stop: record("stop"),
		delete: record("delete"),
		rename: record("rename"),
		setMeta: record("setMeta"),
		answer: record("answer"),
		reply: record("reply"),
		spawn: record("spawn"),
	} as unknown as OrchestratorClient;
}

function makeView(opts: { self?: InstanceSummary; rows?: number; mode?: "ask" | "edits" | "auto" } = {}) {
	const calls: Calls = [];
	const opened: string[] = [];
	let closed = 0;
	const ui = { terminal: { rows: opts.rows ?? 40 }, requestRender: () => {} } as unknown as TUI;
	const view = new AgentView({
		ui,
		client: fakeClient(calls),
		appName: "bluclawd",
		version: "1.0.0",
		model: { provider: "opencode-go", id: "kimi" },
		cwd: HERE,
		home: HOME,
		self: opts.self ? () => opts.self : undefined,
		onClose: () => closed++,
		onOpen: (file) => opened.push(file),
		fileExists: () => true,
		permissionMode: opts.mode ? () => opts.mode : undefined,
	});
	view.setInstancesForTest(sessions);
	const flush = () => new Promise((r) => setTimeout(r, 0));
	return { view, calls, opened, closed: () => closed, text: () => view.render(100).map(stripAnsi), flush };
}

beforeAll(() => setSharedTheme(plainTheme));
afterEach(() => vi.unstubAllEnvs());

describe("rows", () => {
	it("maps daemon state onto Claude Code's six states", () => {
		const state = (inst: Partial<InstanceSummary>) =>
			rowFromSummary({ id: "x", status: "online", cwd: HERE, ...inst }, undefined).state;
		expect(state({ activity: "working" })).toBe("working");
		expect(state({ activity: "awaiting_input" })).toBe("needs");
		expect(state({ activity: "idle", question: "which one?" })).toBe("needs");
		expect(state({ activity: "idle", turns: 0 })).toBe("idle");
		expect(state({ activity: "idle", turns: 1 })).toBe("done");
		expect(state({ activity: "idle", outcome: "failed" })).toBe("failed");
		expect(state({ status: "stopped" })).toBe("stopped");
		expect(state({ status: "stopped", outcome: "done" })).toBe("done");
		expect(state({ status: "starting" })).toBe("working");
	});

	it("names untitled sessions from the first three words of the task", () => {
		expect(labelFromTask("fix the flaky settings test")).toBe("fix the flaky…");
		expect(labelFromTask("refactor")).toBe("refactor");
		expect(labelFromTask("   ")).toBe("untitled session");
	});

	it("bands put what needs you first; idle sessions wait with the blocked ones", () => {
		const rows = collectRows(sessions, undefined);
		const bands = buildBands(rows, "state", (p) => p);
		expect(bands.map((b) => [b.title, b.rows.map((r) => r.id)])).toEqual([
			["Needs input", ["ask"]],
			["Working", ["work"]],
			["Completed", ["done", "gone"]],
		]);
	});

	it("pinned sessions get their own band on top; the directory view groups by cwd", () => {
		const pinned = sessions.map((s) => (s.id === "gone" ? { ...s, pinned: true } : s));
		const bands = buildBands(collectRows(pinned, undefined), "directory", (p) => p.replace(HOME, "~"));
		expect(bands.map((b) => b.title)).toEqual(["Pinned", "~/proj/here", "~/proj/there"]);
	});

	it("keeps one row per session file: this window's, then a live one, over a stored twin", () => {
		const self: InstanceSummary = { id: "me", status: "online", cwd: HERE, sessionFile: "/a.jsonl", external: true };
		const rows = collectRows(
			[
				{ id: "stored", status: "stopped", cwd: HERE, sessionFile: "/a.jsonl", pinned: true },
				{ id: "other-window", status: "online", cwd: HERE, sessionFile: "/b.jsonl", external: true },
				{ id: "b-row", status: "stopped", cwd: HERE, sessionFile: "/b.jsonl" },
			],
			self,
		);
		expect(rows.map((r) => r.id)).toEqual(["me", "b-row"]);
		expect(rows[0].pinned).toBe(true);
		expect(rows[1].elsewhere).toBe(true);
	});

	it("ages count from creation and freeze when a run finishes", () => {
		const done = rowFromSummary(
			{ id: "d", status: "online", cwd: HERE, turns: 1, createdAt: ago(9), finishedAt: ago(3) },
			undefined,
		);
		expect(rowAge(done, NOW)).toBe("6m");
		expect(compactAge(42_000)).toBe("42s");
		expect(compactAge(3 * 3_600_000)).toBe("3h");
	});

	it("s:<state> filters; plain text is a task, not a filter", () => {
		const rows = collectRows(sessions, undefined);
		expect(rows.filter(stateFilter("s:blocked") ?? (() => false)).map((r) => r.id)).toEqual(["ask"]);
		expect(rows.filter(stateFilter("s:completed") ?? (() => false)).map((r) => r.id)).toEqual(["done", "gone"]);
		expect(stateFilter("fix the tests")).toBeUndefined();
	});
});

describe("AgentView render", () => {
	it("shows the header, the three bands and one line per session", () => {
		const text = makeView().text();
		expect(text[0]).toContain("bluclawd");
		expect(text[1]).toContain("opencode-go/kimi · ~/proj/here");
		expect(text[2]).toContain("1 awaiting input · 1 working · 2 completed");
		const body = text.join("\n");
		expect(body).toMatch(/Needs input\n.*power-up design\s+Allow bash: npm test\?\s+1m/);
		expect(body).toMatch(/Working\n.*collision detection\s+Adding swept-AABB checks/);
		expect(body).toMatch(/Completed\n.*title screen\s+result: menu done\s+6m/);
		expect(body).toContain("∙ sound effects");
		expect(body).toContain("describe a task for a new session");
	});

	it("prefixes the state word in the directory view", () => {
		const { view, text } = makeView();
		view.handleInput(CTRL_S);
		expect(text().join("\n")).toMatch(/~\/proj\/here\n.*power-up design\s+Needs input · Allow bash/);
	});

	it("says so when nothing runs yet", () => {
		const { view, text } = makeView();
		view.setInstancesForTest([]);
		expect(text().join("\n")).toContain("Nothing running in the background.");
	});

	it("folds completed sessions that don't fit, but keeps failures visible", () => {
		const many: InstanceSummary[] = Array.from({ length: 30 }, (_, i) => ({
			id: `d${i}`,
			status: "stopped" as const,
			cwd: HERE,
			label: `task ${i}`,
			outcome: "done" as const,
			finishedAt: ago(i + 1),
		}));
		many.push({ id: "bad", status: "stopped", cwd: HERE, label: "broken", outcome: "failed", finishedAt: ago(100) });
		const { view, text } = makeView({ rows: 24 });
		view.setInstancesForTest(many);
		const body = text().join("\n");
		expect(body).toMatch(/… \d+ more/);
		expect(body).toContain("broken");
	});
});

describe("AgentView keys", () => {
	it("typing then enter dispatches a background session named from the task", async () => {
		const { view, calls, flush } = makeView();
		for (const ch of "fix the flaky test") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual([
			"spawn",
			{
				cwd: HERE,
				label: "fix the flaky…",
				prompt: "fix the flaky test",
				model: { provider: "opencode-go", id: "kimi" },
			},
		]);
	});

	it("new sessions run in the mode of the session the view was opened from", async () => {
		const { view, calls, flush } = makeView({ mode: "auto" });
		for (const ch of "fix it") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]?.[1]).toMatchObject({ permissionMode: "auto" });
	});

	it("ctrl+j and shift+enter add lines to the task; backspace on an empty line joins them back", async () => {
		const { view, calls, text, flush } = makeView();
		for (const ch of "write the menu") view.handleInput(ch);
		view.handleInput("\n"); // ctrl+j
		for (const ch of "then the credits") view.handleInput(ch);
		expect(text().join("\n")).toMatch(/❯ write the menu\n\s+then the credits/);
		view.handleInput("\x1b[13;2u"); // shift+enter (kitty)
		view.handleInput("\x7f"); // backspace on the empty third line
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]?.[1]).toMatchObject({ prompt: "write the menu\nthen the credits" });
	});

	it("an s: filter's footer offers esc", () => {
		const { view, text } = makeView();
		for (const ch of "s:blocked") view.handleInput(ch);
		expect(text().at(-1)).toContain("esc to clear");
	});

	it("alt+N opens the Nth session in the focused session's directory", async () => {
		const { view, opened, flush } = makeView();
		view.setInstancesForTest([
			{ id: "a", status: "stopped", cwd: HERE, sessionFile: "/a.jsonl", outcome: "done", finishedAt: ago(1) },
			{ id: "b", status: "stopped", cwd: THERE, sessionFile: "/b.jsonl", outcome: "done", finishedAt: ago(2) },
			{ id: "c", status: "stopped", cwd: HERE, sessionFile: "/c.jsonl", outcome: "done", finishedAt: ago(3) },
		]);
		expect(view.selectedKeyForTest()).toBe("a");
		view.handleInput("\x1b2"); // alt+2
		for (let i = 0; i < 5; i++) await flush();
		expect(opened).toEqual(["/c.jsonl"]);
	});

	it("refuses a too-short task", () => {
		const { view, calls, text } = makeView();
		for (const ch of "hi") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(calls).toEqual([]);
		expect(text().join("\n")).toContain("Too short — describe the task");
	});

	it("space peeks; a number answers the pending question without attaching", async () => {
		const { view, calls, text, flush } = makeView();
		expect(view.selectedKeyForTest()).toBe("ask");
		view.handleInput(" ");
		const peek = text().join("\n");
		expect(peek).toContain("Allow bash: npm test?");
		expect(peek).toContain("│ 1. Yes");
		expect(peek).toContain("│ 2. No");
		view.handleInput("1");
		await flush();
		expect(calls[0]).toEqual(["answer", "ask", "q1", { value: "Yes" }]);
	});

	it("a peek reply goes to a running session as a prompt when idle", async () => {
		const { view, calls, flush } = makeView();
		// Band headers are focusable too: ask → Working → work → Completed → title screen.
		for (let i = 0; i < 4; i++) view.handleInput(DOWN);
		expect(view.selectedKeyForTest()).toBe("done");
		view.handleInput(" ");
		for (const ch of "now add sound") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["reply", "done", "now add sound", false]);
	});

	it("ctrl+x stops a running session, a second press deletes it", async () => {
		const { view, calls, text, flush } = makeView();
		view.handleInput(DOWN);
		view.handleInput(DOWN); // Working header → collision detection
		view.handleInput(CTRL_X);
		await flush();
		expect(calls).toEqual([["stop", "work"]]);
		expect(text().join("\n")).toContain("ctrl+x again to delete");
		view.handleInput(CTRL_X);
		await flush();
		expect(calls[1]).toEqual(["delete", "work"]);
	});

	it("esc dismisses an armed delete instead of closing", () => {
		const { view, closed } = makeView();
		for (let i = 0; i < 5; i++) view.handleInput(DOWN); // sound effects (stopped)
		view.handleInput(CTRL_X);
		view.handleInput(ESC);
		expect(closed()).toBe(0);
		view.handleInput(ESC);
		expect(closed()).toBe(1);
	});

	it("ctrl+t pins; your own session cannot be stopped or pinned", async () => {
		const self: InstanceSummary = {
			id: "me",
			status: "online",
			activity: "idle",
			cwd: HERE,
			label: "current",
			turns: 1,
			external: true,
		};
		const { view, calls, text, flush } = makeView({ self });
		expect(view.selectedKeyForTest()).toBe("me");
		view.handleInput(CTRL_X);
		expect(text().join("\n")).toContain("this is the session you're in");
		view.handleInput(CTRL_T);
		await flush();
		expect(calls).toEqual([]);
		view.handleInput(ENTER);
		expect(calls).toEqual([]);
	});

	it("enter on your own session returns to it; on another it opens there", async () => {
		const self: InstanceSummary = { id: "me", status: "online", cwd: HERE, turns: 1, external: true };
		const withSelf = makeView({ self });
		withSelf.view.handleInput(ENTER);
		expect(withSelf.closed()).toBe(1);

		const { view, opened, calls, flush } = makeView();
		view.setInstancesForTest(sessions.map((s) => (s.id === "gone" ? { ...s, sessionFile: "/gone.jsonl" } : s)));
		for (let i = 0; i < 5; i++) view.handleInput(DOWN);
		expect(view.selectedKeyForTest()).toBe("gone");
		view.handleInput(ENTER);
		await flush();
		expect(opened).toEqual(["/gone.jsonl"]);
		expect(calls).toEqual([]); // not running: nothing to stop
	});

	it("/model sets the dispatch model for this view only; other slash commands point to attaching", () => {
		const { view, text } = makeView();
		for (const ch of "/model openai/gpt-5") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(text()[1]).toContain("openai/gpt-5 (session)");
		for (const ch of "/compact") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(text().join("\n")).toContain("/compact isn't available in agent view — attach to a session to run it");
	});
});

describe("piPackageRoot", () => {
	it("finds the running pi's package root from its entry script, or nothing outside pi", () => {
		const piRoot = resolve("node_modules/@earendil-works/pi-coding-agent");
		expect(piPackageRoot(join(piRoot, "dist", "bundle", "cli.js"))).toBe(piRoot);
		expect(piPackageRoot(resolve("bin.mjs"))).toBeUndefined();
		expect(piPackageRoot(undefined)).toBeUndefined();
		expect(piPackageRoot("/nonexistent/pi")).toBeUndefined();
		// argv[1] is the bin symlink as invoked, e.g. /opt/homebrew/bin/pi — must follow it.
		const link = join(mkdtempSync(join(tmpdir(), "pi-bin-")), "pi");
		symlinkSync(join(piRoot, "dist", "bundle", "cli.js"), link);
		expect(piPackageRoot(link)).toBe(realpathSync(piRoot));
	});
});

describe("withoutAgentViewCommand", () => {
	it("keeps the ←← plumbing command out of slash autocomplete", async () => {
		const base = {
			getSuggestions: async () => ({
				prefix: "/a",
				items: [
					{ value: "agent-view", label: "agent-view" },
					{ value: "agents", label: "agents" },
				],
			}),
			applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
		} as unknown as AutocompleteProvider;
		const got = await withoutAgentViewCommand(base).getSuggestions(["/a"], 0, 2, { force: false } as never);
		expect(got?.items.map((i) => i.value)).toEqual(["agents"]);
	});
});

describe("AgentView look", () => {
	it("draws the mascot beside the header and the ? grid under the composer, list still visible", () => {
		vi.stubEnv("TERM_PROGRAM", "ghostty");
		vi.stubEnv("TERM", "xterm-ghostty");
		const { view, text } = makeView();
		expect(text().slice(0, 4)).toEqual([
			expect.stringMatching(/^ {2}▗▄▟█▙▄▖ {4}bluclawd v1\.0\.0$/),
			expect.stringMatching(/^▄██▀███▀██▄ {2}\S/),
			expect.stringMatching(/^🮂█████████🮂 {2}\d+ awaiting input/u),
			expect.stringMatching(/^ {2}🮅.{5}🮅 +$/u),
		]);
		// Claude Code drops the mascot below 70 columns.
		expect(stripAnsi(view.render(60)[0]!)).toMatch(/^bluclawd v1\.0\.0/);
		view.handleInput("?");
		const shown = text().join("\n");
		expect(shown).toContain("power-up design");
		expect(shown).toMatch(/shift\+↑↓ to\s/);
		expect(text().at(-1)).not.toContain("? for shortcuts");
		view.handleInput("?");
		expect(text().at(-1)).toContain("? for shortcuts");
	});

	it("leads the hints with the mode new sessions inherit, in Claude Code's badge colors", () => {
		const auto = makeView({ mode: "auto" });
		const raw = auto.view.render(100).at(-1)!;
		expect(stripAnsi(raw)).toBe(
			"  ⏵⏵ auto mode · enter to open · space to reply · ctrl+x to delete · ? for shortcuts",
		);
		expect(raw).toContain("\x1b[38;2;255;193;7m⏵⏵ auto mode");
		for (const ch of "fix it") auto.view.handleInput(ch);
		expect(auto.text().at(-1)).toBe("  ⏵⏵ auto mode · enter to create · esc to clear");

		const edits = makeView({ mode: "edits" }).view.render(100).at(-1)!;
		expect(edits).toContain("\x1b[38;2;175;135;255m⏵⏵ edits mode");
		// ask is Claude Code's default, which it leaves unlabeled.
		expect(makeView({ mode: "ask" }).text().at(-1)).toBe(
			"  enter to open · space to reply · ctrl+x to delete · ? for shortcuts",
		);
	});

	it("lays the ? grid out like Claude Code: two to a column, whole phrases, alt count from the focused directory", () => {
		const { view } = makeView();
		view.handleInput("?");
		const grid = (width: number) => {
			const lines = view.render(width).map(stripAnsi);
			return lines.slice(lines.map((l) => l.startsWith("─")).lastIndexOf(true) + 1);
		};
		for (const width of [100, 120, 160]) {
			const text = grid(width).join("\n");
			for (const item of [
				"shift+↑↓ to reorder",
				"ctrl+j for newline",
				"ctrl+enter to start and open",
				"? to close",
			]) {
				expect(text).toContain(item);
			}
			expect(text).toContain("alt+1-3 to open"); // the focused row's directory holds three sessions
		}
		// Wide enough for Claude Code's two rows: its first column is reorder over rename, 4 apart.
		expect(grid(160)).toEqual([
			expect.stringMatching(/^ {2}shift\+↑↓ to reorder {4}ctrl\+s to switch views {4}/),
			expect.stringMatching(/^ {2}ctrl\+r to rename {7}ctrl\+j for newline {8}/),
		]);
	});

	it("keeps the mode off the shortcut grid, the peek box and rename", () => {
		const { view, text } = makeView({ mode: "auto" });
		view.handleInput("?");
		expect(text().join("\n")).not.toContain("auto mode");
		view.handleInput("?");
		view.handleInput(" ");
		expect(text().join("\n")).not.toContain("auto mode");
		view.handleInput(ESC);
		view.handleInput("\x12"); // ctrl+r
		expect(text().join("\n")).not.toContain("auto mode");
	});

	it("with only this session listed, explains the view just above the composer", () => {
		const self: InstanceSummary = { id: "me", status: "online", cwd: HERE, label: "current session", external: true };
		const { view, text } = makeView({ self });
		view.setInstancesForTest([]);
		const lines = text();
		const rule = lines.findIndex((l) => l.startsWith("─"));
		expect(lines[rule - 1]).toBe("");
		expect(
			lines
				.slice(0, rule - 1)
				.join(" ")
				.replace(/\s+/g, " "),
		).toMatch(/ A different way to work: .* in the sections above so you know when it needs you\./);
		expect(lines.slice(0, 8).join("\n")).not.toContain("different way");
	});
});
