import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView, type PaneOps } from "../ext/agent-view/agent-view.ts";
import { withoutAgentViewCommand } from "../ext/agent-view/index.ts";
import {
	currentDaemonBuildId,
	type InstanceSummary,
	type OrchestratorClient,
	piPackageRoot,
} from "../ext/agent-view/orchestrator-client.ts";
import {
	buildBands,
	collectRows,
	compactAge,
	labelFromTask,
	queryFilter,
	rowAge,
	rowFromSummary,
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
		external: true,
		pane: "p-ask",
		activity: "awaiting_input",
		cwd: HERE,
		label: "power-up design",
		createdAt: ago(1),
		detail: "Allow bash: npm test?",
	},
	{
		id: "work",
		status: "online",
		external: true,
		pane: "p-work",
		activity: "working",
		cwd: THERE,
		label: "collision detection",
		detail: "Adding swept-AABB checks",
		createdAt: ago(2),
	},
	{
		id: "done",
		status: "online",
		external: true,
		pane: "p-done",
		activity: "idle",
		cwd: HERE,
		label: "title screen",
		outcome: "done",
		turns: 1,
		detail: "menu done",
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
		};
	return {
		list: async () => list(),
		ensureDaemon: async () => true,
		getDaemonInfo: async () => ({ running: false }),
		delete: record("delete"),
		rename: record("rename"),
		setMeta: record("setMeta"),
		send: record("send"),
	} as unknown as OrchestratorClient;
}

/** tmux stand-in: every call is recorded; `start` names panes pane-1, pane-2, … */
function fakePanes(calls: Calls): PaneOps {
	let n = 0;
	return {
		current: "pane-self",
		switchTo: (pane) => calls.push(["switchTo", pane]),
		start: (cwd, args, env) => {
			calls.push(["start", cwd, args, ...(env ? [env] : [])]);
			return `pane-${++n}`;
		},
		end: (pane) => calls.push(["end", pane]),
		kill: (pane) => calls.push(["kill", pane]),
		unlist: async () => {
			calls.push(["unlist"]);
		},
		detach: () => calls.push(["detach"]),
		startShell: () => "sh-new",
		listShells: () => [],
		stopShell: () => {},
		capture: () => [],
	};
}

function makeView(
	opts: {
		self?: InstanceSummary;
		rows?: number;
		list?: () => InstanceSummary[];
		readClipboard?: () => Promise<{ image?: { type: "image"; data: string; mimeType: string }; text?: string }>;
		mode?: string;
	} = {},
) {
	const calls: Calls = [];
	let instances = sessions;
	const opened: string[] = [];
	const resumed: boolean[] = [];
	let closed = 0;
	const ui = { terminal: { rows: opts.rows ?? 40 }, requestRender: () => {} } as unknown as TUI;
	const view = new AgentView({
		ui,
		client: fakeClient(calls, opts.list ?? (() => instances)),
		panes: fakePanes(calls),
		appName: "bluclawd",
		version: "1.0.0",
		model: { provider: "opencode-go", id: "kimi" },
		cwd: HERE,
		home: HOME,
		self: opts.self ? () => opts.self : undefined,
		onClose: () => closed++,
		readClipboard: opts.readClipboard,
		isKnownCommand: (name) => name === "compact",
		mode: opts.mode,
	});
	const setInstances = view.setInstancesForTest.bind(view);
	view.setInstancesForTest = (rows) => {
		instances = rows;
		setInstances(rows);
	};
	view.setInstancesForTest(sessions);
	const flush = () => new Promise((r) => setTimeout(r, 0));
	return { view, calls, opened, resumed, closed: () => closed, text: () => view.render(100).map(stripAnsi), flush };
}

beforeAll(() => setSharedTheme(plainTheme));
afterEach(() => vi.unstubAllEnvs());

describe("rows", () => {
	it("maps daemon state onto Claude Code's six states", () => {
		const state = (inst: Partial<InstanceSummary>) =>
			rowFromSummary({ id: "x", status: "online", cwd: HERE, ...inst }, undefined).state;
		expect(state({ activity: "working" })).toBe("working");
		expect(state({ activity: "awaiting_input" })).toBe("needs");
		expect(state({ activity: "idle", turns: 0 })).toBe("idle");
		expect(state({ activity: "idle", turns: 1 })).toBe("done");
		expect(state({ activity: "idle", outcome: "failed" })).toBe("failed");
		expect(state({ activity: "idle", outcome: "stopped", turns: 1 })).toBe("stopped");
		expect(state({ status: "stopped" })).toBe("stopped");
		expect(state({ status: "stopped", outcome: "done" })).toBe("done");
		expect(state({ status: "starting" })).toBe("working");
	});

	it("names untitled sessions from the first three words of the task", () => {
		expect(labelFromTask("fix the flaky settings test")).toBe("fix the flaky…");
		expect(labelFromTask("refactor")).toBe("refactor");
		expect(labelFromTask("   ")).toBe("untitled session");
	});

	it("bands: a blocking prompt, a turn running, or nothing running — an unprompted session is Idle", () => {
		const fresh: InstanceSummary = { id: "fresh", status: "online", activity: "idle", cwd: HERE, turns: 0 };
		const rows = collectRows([...sessions, fresh], undefined);
		const bands = buildBands(rows, "state", (p) => p);
		expect(bands.map((b) => [b.title, b.rows.map((r) => r.id).sort()])).toEqual([
			["Needs input", ["ask"]],
			["Working", ["work"]],
			["Idle", ["done", "fresh", "gone"]],
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
				{ id: "b-row", status: "stopped", cwd: HERE, sessionFile: "/b.jsonl" },
				{ id: "b-pane", status: "online", cwd: HERE, sessionFile: "/b.jsonl", external: true, pane: "p-b" },
			],
			self,
		);
		expect(rows.map((r) => r.id)).toEqual(["me", "b-pane"]);
		expect(rows[0].pinned).toBe(true);
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
		expect(rows.filter(queryFilter("s:blocked") ?? (() => false)).map((r) => r.id)).toEqual(["ask"]);
		expect(rows.filter(queryFilter("s:idle") ?? (() => false)).map((r) => r.id)).toEqual(["done", "gone"]);
		expect(queryFilter("fix the tests")).toBeUndefined();
	});
});

describe("AgentView render", () => {
	it("shows the header, the three bands and one line per session", () => {
		const text = makeView().text();
		expect(text[0]).toBe(""); // Claude Code pads the top of the list
		expect(text[1]).toContain("bluclawd");
		expect(text[2]).toContain("opencode-go/kimi · ~/proj/here");
		expect(text[3]).toContain("1 awaiting input · 1 working · 2 idle");
		const body = text.join("\n");
		expect(body).toMatch(/Needs input\n.*power-up design\s+Allow bash: npm test\?\s+1m/);
		expect(body).toMatch(/Working\n.*collision detection\s+Adding swept-AABB checks/);
		expect(body).toMatch(/Idle\n.*title screen\s+menu done\s+6m/);
		expect(body).toContain("∙ sound effects");
		expect(body).toContain("describe a task for a new session");
	});

	it("prefixes the state word in the directory view", () => {
		const { view, text } = makeView();
		view.handleInput(CTRL_S);
		const shown = text().join("\n");
		// The launcher's directory first, its sessions oldest first.
		expect(shown).toMatch(
			/~\/proj\/here\n.*sound effects\s+Idle · build broke[\s\S]*power-up design\s+Needs input · Allow bash[\s\S]*~\/proj\/there/,
		);
	});

	it("with nothing running, shows every band with what lands there, and the intro", () => {
		const { view, text } = makeView();
		view.setInstancesForTest([]);
		const shown = text().join("\n");
		expect(shown).toMatch(/Needs input\n Sessions that have a question/);
		expect(shown).toMatch(/Working\n Sessions actively working/);
		expect(shown).toMatch(/Idle\n Sessions with nothing running wait here/);
		expect(shown).toContain("A different way to work");
	});

	it("hides an empty band once anything is listed", () => {
		const { view, text } = makeView();
		view.setInstancesForTest(sessions.filter((s) => s.id !== "ask"));
		expect(text().join("\n")).not.toContain("Needs input");
	});

	it("folds completed sessions that don't fit, keeping runs that finished together", () => {
		const many: InstanceSummary[] = Array.from({ length: 30 }, (_, i) => ({
			id: `d${i}`,
			status: "stopped" as const,
			cwd: HERE,
			label: `task ${i}`,
			outcome: "done" as const,
			finishedAt: ago(i * 2 + 1),
		}));
		const { view, text } = makeView({ rows: 24 });
		view.setInstancesForTest(many);
		// 24 rows leave 12 for Completed (24 - 8 - 4).
		expect(text().join("\n")).toContain("… 18 more");
		// Finished within a minute of each other, the whole run stays together.
		view.setInstancesForTest(many.map((s, i) => ({ ...s, finishedAt: new Date(NOW - i * 30_000).toISOString() })));
		expect(text().join("\n")).not.toContain("more");
	});
});

describe("AgentView keys", () => {
	it("typing then enter starts a session in a pane of its own, the task its first prompt", async () => {
		const { view, calls, text, flush } = makeView();
		for (const ch of "fix the flaky test") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["start", HERE, ["--model", "opencode-go/kimi", "--", "fix the flaky test"]]);
		expect(text().join("\n")).toContain("fix the flaky…");
	});

	it("ctrl+j and shift+enter add lines to the task; backspace on an empty line joins them back", async () => {
		const { view, calls, text, flush } = makeView();
		for (const ch of "write the menu") view.handleInput(ch);
		view.handleInput("\n"); // ctrl+j
		for (const ch of "then the credits") view.handleInput(ch);
		expect(text().join("\n")).toMatch(/❯ write the menu\nthen the credits/);
		view.handleInput("\x1b[13;2u"); // shift+enter (kitty)
		view.handleInput("\x7f"); // backspace on the empty third line
		view.handleInput(ENTER);
		await flush();
		expect((calls[0]?.[2] as string[]).at(-1)).toBe("write the menu\nthen the credits");
	});

	it("the hint line leads with the mode new sessions start in, as Claude Code's", () => {
		const { view, text } = makeView({ mode: "⏵⏵ always" });
		for (const ch of "fix it") view.handleInput(ch);
		expect(text().at(-1)).toMatch(/^ {2}⏵⏵ always · enter to create · esc to clear/);
		expect(makeView().text().at(-1)).not.toContain("⏵⏵");
	});

	it("an s: filter's footer offers esc", () => {
		const { view, text } = makeView();
		for (const ch of "s:blocked") view.handleInput(ch);
		expect(text().at(-1)).toContain("esc to clear");
	});

	it("alt+N opens the Nth session in the focused session's directory", async () => {
		const { view, calls, flush } = makeView();
		view.setInstancesForTest([
			{ id: "a", status: "stopped", cwd: HERE, sessionFile: "/a.jsonl", outcome: "done", finishedAt: ago(1) },
			{ id: "b", status: "stopped", cwd: THERE, sessionFile: "/b.jsonl", outcome: "done", finishedAt: ago(2) },
			{ id: "c", status: "stopped", cwd: HERE, sessionFile: "/c.jsonl", outcome: "done", finishedAt: ago(3) },
		]);
		expect(view.selectedKeyForTest()).toBe("a");
		view.handleInput("\x1b2"); // alt+2
		for (let i = 0; i < 5; i++) await flush();
		expect(calls).toContainEqual(["start", HERE, ["--session", "/c.jsonl"]]);
		expect(calls).toContainEqual(["switchTo", "pane-1"]);
	});

	it("ignores a late roster response after closing rather than reading the replaced session context", async () => {
		let invalidated = false;
		let answer!: (rows: InstanceSummary[]) => void;
		const client = fakeClient([]);
		client.list = () =>
			new Promise((resolve) => {
				answer = resolve;
			});
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client,
			appName: "bluclawd",
			cwd: HERE,
			home: HOME,
			onClose: () => {},
			panes: fakePanes([]),
			self: () => {
				if (invalidated) throw new Error("stale session context");
				return undefined;
			},
		});
		const showing = view.onShow();
		await vi.waitFor(() => expect(answer).toBeDefined());
		view.close();
		invalidated = true;
		answer([]);
		await expect(showing).resolves.toBeUndefined();
	});

	it("explains how to recover a legacy Failed row that never recorded its file", () => {
		const { view, text, opened } = makeView();
		view.setInstancesForTest([{ id: "legacy", status: "stopped", outcome: "failed", cwd: HERE }]);
		view.handleInput(ENTER);
		expect(opened).toEqual([]);
		expect(text().join("\n")).toContain("/resume");
	});

	it("Ctrl+V attaches an image as an [Image #N] token, including an image-only prompt; the image goes along", async () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		const { view, calls, text, flush } = makeView({ readClipboard: async () => ({ image }) });
		view.handleInput("\x16");
		await flush();
		expect(text().join("\n")).toContain("❯ [Image #1]");
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]?.[0]).toBe("start");
		expect((calls[0]?.[2] as string[]).slice(-2)).toEqual([expect.stringMatching(/^@.*\.png$/), "[Image #1]"]);
		expect(text().join("\n")).not.toContain("❯ [Image #1]");
	});

	it("the same image again shows its file instead of the token", async () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		const { view, text, flush } = makeView({ readClipboard: async () => ({ image }) });
		view.handleInput("\x16");
		await flush();
		view.handleInput("\x16");
		await flush();
		expect(text().join("\n")).toMatch(/❯ \/\S+\.png/);
	});

	it("a long paste is a [Pasted text] token: deleted in one go, shown by pasting again, sent in full", async () => {
		const pasted = "first line\nsecond line\nthird line";
		const { view, calls, text, flush } = makeView();
		for (const ch of "fix ") view.handleInput(ch);
		view.handleInput(`\x1b[200~${pasted}\x1b[201~`);
		expect(text().join("\n")).toContain("❯ fix [Pasted text #1 +2 lines]");
		view.handleInput("\x7f");
		expect(text().join("\n")).toContain("❯ fix ");
		expect(text().join("\n")).not.toContain("[Pasted text");
		view.handleInput(`\x1b[200~${pasted}\x1b[201~`);
		view.handleInput(`\x1b[200~${pasted}\x1b[201~`);
		expect(text().join("\n")).toContain("❯ fix first line\nsecond line\nthird line");
		view.handleInput(`\x1b[200~${"x".repeat(900)}\x1b[201~`);
		view.handleInput(ENTER);
		await flush();
		expect((calls[0]?.[2] as string[]).at(-1)).toBe(`fix ${pasted}${"x".repeat(900)}`);
	});

	it("Ctrl+V only attaches images, as in Claude Code, and keeps the composer text", async () => {
		const { view, text, flush } = makeView({ readClipboard: async () => ({ text: " image" }) });
		for (const ch of "describe") view.handleInput(ch);
		view.handleInput("\x16");
		await flush();
		const shown = text().join("\n");
		expect(shown).toContain("No image found in clipboard");
		expect(shown).toContain("❯ describe");
	});

	it("Esc clears pasted images rather than unexpectedly opening the selected session", async () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		const { view, closed, text, flush } = makeView({ readClipboard: async () => ({ image }) });
		view.handleInput("\x16");
		await flush();
		view.handleInput(ESC);
		expect(closed()).toBe(0);
		expect(text().join("\n")).not.toContain("[Image #1]");
		view.handleInput(ESC);
		expect(closed()).toBe(1);
	});

	it("does not submit while clipboard image data is still loading", async () => {
		let finish!: (value: { image: { type: "image"; mimeType: string; data: string } }) => void;
		const { view, calls, flush } = makeView({
			readClipboard: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		for (const ch of "describe image") view.handleInput(ch);
		view.handleInput("\x16");
		view.handleInput(ENTER);
		expect(calls).toEqual([]);
		finish({ image: { type: "image", mimeType: "image/png", data: "aW1hZ2U=" } });
		await flush();
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]?.[0]).toBe("start");
		expect(calls[0]?.[2]).toEqual(
			expect.arrayContaining(["describe image[Image #1]", expect.stringMatching(/^@.*\.png$/)]),
		);
	});

	it("ctrl+c clears the draft and arms the exit at once; a second press leaves tmux", () => {
		const { view, calls } = makeView();
		for (const ch of "draft") view.handleInput(ch);
		view.handleInput("\x03");
		const shown = view.render(100).map(stripAnsi).join("\n");
		expect(shown).not.toContain("❯ draft");
		expect(shown).toContain("Press Ctrl-C again to exit · 2 agents will keep running");
		view.handleInput("\x03");
		expect(calls).toEqual([["detach"]]);
	});

	it("exit words quit; an unknown /command is a task, not an error", async () => {
		const { view, calls, closed, flush } = makeView();
		for (const ch of "/brainstorm a menu") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["start", HERE, ["--model", "opencode-go/kimi", "--", "/brainstorm a menu"]]);
		for (const ch of "exit") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(closed()).toBe(1);
		expect(calls.at(-1)).toEqual(["detach"]);
	});

	it("↑ wraps from the top to the bottom", () => {
		const { view } = makeView();
		view.handleInput("\x1b[H"); // home: the first band header
		view.handleInput("\x1b[A");
		expect(view.selectedKeyForTest()).toBe("gone");
	});

	it("ctrl+r renames inline in the row, with the footer saying how to finish", async () => {
		const { view, calls, text, flush } = makeView();
		view.handleInput("\x12"); // ctrl+r on "power-up design"
		for (const ch of " v2") view.handleInput(ch);
		const shown = text();
		expect(shown.join("\n")).toMatch(/✻ power-up design v2/);
		expect(shown.at(-1)).toContain("enter to save · esc to cancel");
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["send", "ask", { type: "rename", name: "power-up design v2" }]);
	});

	it("refuses a too-short task", () => {
		const { view, calls, text } = makeView();
		for (const ch of "hi") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(calls).toEqual([]);
		expect(text().join("\n")).toContain("Too short — describe the task");
	});

	it("a peek reply goes to a running session as a prompt when idle", async () => {
		const { view, calls, flush } = makeView();
		// Band headers are focusable too: ask → Working → work → Idle → title screen.
		for (let i = 0; i < 4; i++) view.handleInput(DOWN);
		expect(view.selectedKeyForTest()).toBe("done");
		view.handleInput(" ");
		for (const ch of "now add sound") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["send", "done", { type: "prompt", text: "now add sound" }]);
	});

	it("ctrl+x ends a running session's pi, which leaves a stopped row; a second press deletes that row", async () => {
		const work = { ...sessions[1], sessionFile: "/w.jsonl" };
		let instances: InstanceSummary[] = [sessions[0], work];
		const { view, calls, text, flush } = makeView({ list: () => instances });
		view.setInstancesForTest(instances);
		view.handleInput(DOWN);
		view.handleInput(DOWN); // Working header → collision detection
		view.handleInput(CTRL_X);
		await flush();
		expect(calls).toEqual([["end", "p-work"]]);
		expect(text().join("\n")).toContain("stopped · ctrl+x again to delete");
		// Its pi saved it as a stopped row on its way out.
		instances = [
			sessions[0],
			{ id: "stored-w", status: "stopped", cwd: THERE, sessionFile: "/w.jsonl", outcome: "stopped" },
		];
		view.handleInput(CTRL_X);
		await vi.waitFor(() => expect(calls.at(-1)).toEqual(["delete", "stored-w"]));
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

	it("ctrl+t pins your own session like any other: it is a pane too", async () => {
		const self: InstanceSummary = {
			id: "me",
			status: "online",
			activity: "idle",
			cwd: HERE,
			label: "current",
			turns: 1,
			external: true,
			pane: "pane-self",
		};
		const { view, calls, flush } = makeView({ self });
		expect(view.selectedKeyForTest()).toBe("me");
		view.handleInput(CTRL_T);
		await flush();
		expect(calls).toEqual([["setMeta", "me", { pinned: true }]]);
	});

	it("ctrl+x stops your own session's turn, a second press deletes it", async () => {
		const self: InstanceSummary = {
			id: "me",
			status: "online",
			activity: "working",
			cwd: HERE,
			external: true,
			pane: "pane-self",
		};
		const calls: Calls = [];
		let stopped = 0;
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client: fakeClient(calls, () => []),
			appName: "bluclawd",
			cwd: HERE,
			home: HOME,
			self: () => self,
			onClose: () => {},
			panes: fakePanes(calls),
			onStopSelf: () => stopped++,
		});
		view.setInstancesForTest([]);
		view.handleInput(CTRL_X);
		expect(stopped).toBe(1);
		expect(view.render(100).map(stripAnsi).join("\n")).toContain("ctrl+x again to delete");
		view.handleInput(CTRL_X);
		// This terminal moves to a new pane showing agent view; this one ends.
		await vi.waitFor(() => expect(calls.at(-1)).toEqual(["kill", "pane-self"]));
		expect(calls).toEqual([
			["start", HERE, [], { BLUCLAWD_OPEN_VIEW: "1" }],
			["switchTo", "pane-1"],
			["unlist"],
			["delete", "me"],
			["kill", "pane-self"],
		]);
	});

	it("enter on your own session returns to it; on another it opens there", async () => {
		const self: InstanceSummary = { id: "me", status: "online", cwd: HERE, turns: 1, external: true };
		const withSelf = makeView({ self });
		withSelf.view.handleInput(ENTER);
		expect(withSelf.closed()).toBe(1);

		const { view, calls, flush } = makeView();
		view.setInstancesForTest(sessions.map((s) => (s.id === "gone" ? { ...s, sessionFile: "/gone.jsonl" } : s)));
		for (let i = 0; i < 5; i++) view.handleInput(DOWN);
		expect(view.selectedKeyForTest()).toBe("gone");
		view.handleInput(ENTER);
		await flush();
		// Not running: it starts in a pane of its own, which replaces the stored row.
		expect(calls).toEqual([
			["start", HERE, ["--session", "/gone.jsonl"]],
			["delete", "gone"],
			["switchTo", "pane-1"],
		]);
	});

	it("/model sets the dispatch model for this view only; other slash commands point to attaching", () => {
		const { view, text } = makeView();
		for (const ch of "/model openai/gpt-5") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(text()[2]).toContain("openai/gpt-5 (session)");
		for (const ch of "/compact") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(text().join("\n")).toContain("/compact isn't available in agent view — open a session to run it");
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
	it("keeps the plumbing command out of slash autocomplete", async () => {
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

describe("daemon runtime identity", () => {
	it("detects a different Pi installation even when bluclawd source is unchanged", () => {
		vi.stubEnv("PI_PACKAGE_ROOT", "/old/pi");
		const old = currentDaemonBuildId();
		vi.stubEnv("PI_PACKAGE_ROOT", "/new/pi");
		expect(currentDaemonBuildId()).not.toBe(old);
	});
});

describe("AgentView look", () => {
	it("draws the mascot beside the header and the ? grid under the composer, list still visible", () => {
		vi.stubEnv("TERM_PROGRAM", "ghostty");
		vi.stubEnv("TERM", "xterm-ghostty");
		const { view, text } = makeView();
		expect(text().slice(1, 5)).toEqual([
			expect.stringMatching(/^ {2}▗▄▟█▙▄▖ {4}bluclawd v1\.0\.0$/),
			expect.stringMatching(/^▄██▀███▀██▄ {2}\S/),
			expect.stringMatching(/^🮂█████████🮂 {2}\d+ awaiting input/u),
			expect.stringMatching(/^ {2}🮅.{5}🮅 +$/u),
		]);
		// Claude Code drops the mascot below 70 columns.
		expect(stripAnsi(view.render(60)[1]!)).toMatch(/^bluclawd v1\.0\.0/);
		view.handleInput("?");
		const shown = text().join("\n");
		expect(shown).toContain("power-up design");
		expect(shown).toMatch(/ctrl\+r to rename\s/);
		expect(text().at(-1)).not.toContain("? for shortcuts");
		view.handleInput("?");
		expect(text().at(-1)).toContain("? for shortcuts");
	});

	it("lays the ? grid out like Claude Code: three to a column, whole phrases, alt count from the focused directory", () => {
		const { view } = makeView();
		view.handleInput("?");
		const grid = (width: number) => {
			const lines = view.render(width).map(stripAnsi);
			return lines.slice(lines.map((l) => l.startsWith("─")).lastIndexOf(true) + 1);
		};
		for (const width of [100, 120, 160]) {
			const text = grid(width).join("\n");
			for (const item of [
				"ctrl+r to rename",
				"ctrl+f to find",
				"ctrl+j for newline",
				"ctrl+x to stop", // the focused row is in Needs input, which Claude Code stops first
				"? to close",
			]) {
				expect(text).toContain(item);
			}
			expect(text).toContain("alt+1-3 to open"); // the focused row's directory holds three sessions
		}
		// Wide enough for Claude Code's three rows, filled down each column, 4 apart.
		const rows = grid(160);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatch(/^ {2}ctrl\+r to rename {6,}ctrl\+s to switch views {4}/);
		expect(rows[1]).toMatch(/^ {2}ctrl\+f to find {8,}ctrl\+j for newline {8}/);
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
