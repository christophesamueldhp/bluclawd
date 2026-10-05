import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView } from "../ext/agent-view/agent-view.ts";
import { CONTINUE_PROMPT, handOff } from "../ext/agent-view/hand-off.ts";
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

function fakeClient(calls: Calls, list: () => InstanceSummary[] = () => sessions, releases = true): OrchestratorClient {
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
		release: async (sessionFile: string) => {
			calls.push(["release", sessionFile]);
			return releases;
		},
	} as unknown as OrchestratorClient;
}

function makeView(
	opts: {
		self?: InstanceSummary;
		rows?: number;
		list?: () => InstanceSummary[];
		releases?: boolean;
		currentId?: string;
		onDeleted?: (id: string) => void;
		readClipboard?: () => Promise<{ image?: { type: "image"; data: string; mimeType: string }; text?: string }>;
	} = {},
) {
	const calls: Calls = [];
	const opened: string[] = [];
	const resumed: boolean[] = [];
	let closed = 0;
	const ui = { terminal: { rows: opts.rows ?? 40 }, requestRender: () => {} } as unknown as TUI;
	const view = new AgentView({
		ui,
		client: fakeClient(calls, opts.list, opts.releases),
		appName: "bluclawd",
		version: "1.0.0",
		model: { provider: "opencode-go", id: "kimi" },
		cwd: HERE,
		home: HOME,
		self: opts.self ? () => opts.self : undefined,
		onClose: () => closed++,
		currentId: () => opts.currentId,
		onDeleted: opts.onDeleted,
		onOpen: async (target) => {
			opened.push("sessionFile" in target ? target.sessionFile : `/${target.instanceId}.jsonl`);
			resumed.push(false);
			return true;
		},
		fileExists: () => true,
		readClipboard: opts.readClipboard,
		onCreateAndOpen: async (...args) => {
			calls.push(["createAndOpen", ...args]);
			return true;
		},
	});
	view.setInstancesForTest(sessions);
	const flush = () => new Promise((r) => setTimeout(r, 0));
	return { view, calls, opened, resumed, closed: () => closed, text: () => view.render(100).map(stripAnsi), flush };
}

beforeAll(() => setSharedTheme(plainTheme));
it("compatible daemon metadata does not restart the roster service", async () => {
	const calls: Calls = [];
	const client = fakeClient(calls, () => []);
	client.getDaemonInfo = async () => ({ running: true, viewProtocol: 1, buildId: "different-compatible-build" });
	const restart = vi.fn(async () => ({ restarted: true }));
	client.restartDaemon = restart;
	const view = new AgentView({
		ui: { terminal: { rows: 40 }, requestRender: () => {} } as TUI,
		client,
		appName: "test",
		cwd: HERE,
		home: HOME,
		onClose: () => {},
		onOpen: async () => true,
	});
	await view.onShow();
	expect(restart).not.toHaveBeenCalled();
	view.dispose();
});
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

	it("live open selects without stop", async () => {
		const { view, calls, opened, resumed, flush } = makeView();
		view.setInstancesForTest([
			{ id: "w", status: "online", activity: "working", cwd: HERE, sessionFile: "/w.jsonl", createdAt: ago(1) },
		]);
		view.handleInput(ENTER);
		for (let i = 0; i < 5; i++) await flush();
		expect(calls).toEqual([]);
		expect(opened).toEqual(["/w.jsonl"]);
		expect(resumed).toEqual([false]);
	});

	it("failed open retains usable roster", async () => {
		const calls: Calls = [];
		const client = fakeClient(calls);
		client.stop = async () => {
			throw new Error("stop timed out");
		};
		const opened = false;
		let closed = false;
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client,
			appName: "bluclawd",
			cwd: HERE,
			home: HOME,
			onClose: () => {
				closed = true;
			},
			onOpen: async () => {
				throw new Error("attach timed out");
			},
			fileExists: () => true,
		});
		view.setInstancesForTest([
			{ id: "w", status: "online", activity: "working", cwd: HERE, sessionFile: "/w.jsonl" },
		]);
		view.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(opened).toBe(false);
		expect(view.render(100).map(stripAnsi).join("\n")).toContain("attach timed out");
		view.handleInput(ESC);
		expect(closed).toBe(true);
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
			onOpen: async () => true,
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

	it("cancel pending selection", async () => {
		let finish!: () => void;
		const client = fakeClient([]);
		client.stop = () =>
			new Promise<void>((resolve) => {
				finish = resolve;
			});
		let opened = false;
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client,
			appName: "bluclawd",
			cwd: HERE,
			home: HOME,
			onClose: () => {},
			onOpen: (_target, signal) =>
				new Promise((resolve) => {
					finish = () => {
						if (!signal?.aborted) opened = true;
						resolve(!signal?.aborted);
					};
				}),
			fileExists: () => true,
		});
		view.setInstancesForTest([
			{ id: "w", status: "online", activity: "working", cwd: HERE, sessionFile: "/w.jsonl" },
		]);
		view.handleInput(ENTER);
		view.handleInput(ESC);
		finish();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(opened).toBe(false);
	});

	it("explains how to recover a legacy Failed row that never recorded its file", () => {
		const { view, text, opened } = makeView();
		view.setInstancesForTest([{ id: "legacy", status: "stopped", outcome: "failed", cwd: HERE }]);
		view.handleInput(ENTER);
		expect(opened).toEqual([]);
		expect(text().join("\n")).toContain("/resume");
	});

	it("opening a finished live session preserves its process", async () => {
		const { view, calls, resumed, flush } = makeView();
		view.setInstancesForTest([
			{ id: "d", status: "online", activity: "idle", cwd: HERE, sessionFile: "/d.jsonl", outcome: "done", turns: 1 },
		]);
		view.handleInput(ENTER);
		for (let i = 0; i < 5; i++) await flush();
		expect(calls).toEqual([]);
		expect(resumed).toEqual([false]);
	});

	describe("a session open in another terminal", () => {
		const stored: InstanceSummary = {
			id: "s",
			status: "stopped",
			cwd: HERE,
			sessionFile: "/x.jsonl",
			outcome: "done",
		};
		const holder = (activity: InstanceSummary["activity"]): InstanceSummary => ({
			id: "other-window",
			status: "online",
			activity,
			cwd: HERE,
			sessionFile: "/x.jsonl",
			external: true,
		});

		it("unmanaged elsewhere remains protected", async () => {
			const held = true;
			const { view, calls, opened, resumed, flush } = makeView({
				list: () => (held ? [stored, holder("idle")] : [stored]),
			});
			view.setInstancesForTest([stored, holder("idle")]);
			view.handleInput(ENTER);
			await flush();
			expect(calls).toEqual([]);
			expect(opened).toEqual([]);
			expect(resumed).toEqual([]);
		});

		it("does not take over a working native writer", async () => {
			const { view, opened, resumed } = makeView({ list: () => [stored] });
			view.setInstancesForTest([stored, holder("working")]);
			view.handleInput(ENTER);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(opened).toEqual([]);
			expect(resumed).toEqual([]);
		});

		it("says so when the daemon cannot pass the request on", async () => {
			const { view, opened, text, flush } = makeView({ releases: false });
			view.setInstancesForTest([stored, holder("idle")]);
			view.handleInput(ENTER);
			for (let i = 0; i < 5; i++) await flush();
			expect(opened).toEqual([]);
			expect(text().join("\n")).toContain("another terminal");
		});

		it("gives up when the other terminal never lets go", async () => {
			vi.useFakeTimers();
			try {
				const { view, opened, text } = makeView({ list: () => [stored, holder("idle")] });
				view.setInstancesForTest([stored, holder("idle")]);
				view.handleInput(ENTER);
				await vi.advanceTimersByTimeAsync(15_500);
				expect(opened).toEqual([]);
				expect(text().join("\n")).toContain("another terminal");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	it("Ctrl+V attaches an image to a new background session, including an image-only prompt", async () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		const { view, calls, text, flush } = makeView({ readClipboard: async () => ({ image }) });
		view.handleInput("\x16");
		await flush();
		expect(text().join("\n")).toContain("1 image attached");
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["spawn", expect.objectContaining({ prompt: "", images: [image] })]);
		expect(text().join("\n")).not.toContain("image attached");
	});

	it("Ctrl+Enter carries pasted images into the new foreground session", async () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		const { view, calls, flush } = makeView({ readClipboard: async () => ({ image }) });
		for (const ch of "describe this") view.handleInput(ch);
		view.handleInput("\x16");
		await flush();
		view.handleInput("\x1b[13;5u");
		expect(calls).toEqual([
			["createAndOpen", HERE, { provider: "opencode-go", id: "kimi" }, "describe this", [image]],
		]);
	});

	it("Ctrl+V falls back to clipboard text without stripping existing composer text", async () => {
		const { view, calls, flush } = makeView({ readClipboard: async () => ({ text: " image" }) });
		for (const ch of "describe") view.handleInput(ch);
		view.handleInput("\x16");
		await flush();
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["spawn", expect.objectContaining({ prompt: "describe image" })]);
	});

	it("Esc clears pasted images rather than unexpectedly opening the selected session", async () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		const { view, closed, text, flush } = makeView({ readClipboard: async () => ({ image }) });
		view.handleInput("\x16");
		await flush();
		view.handleInput(ESC);
		expect(closed()).toBe(0);
		expect(text().join("\n")).not.toContain("image attached");
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
		expect(calls[0]).toEqual([
			"spawn",
			expect.objectContaining({ images: [expect.objectContaining({ type: "image" })] }),
		]);
	});

	it("retains the task and images if starting a new session fails", async () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "AQID" };
		const client = fakeClient([]);
		client.spawn = async () => {
			throw new Error("startup unavailable");
		};
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client,
			appName: "bluclawd",
			cwd: HERE,
			home: HOME,
			onClose: () => {},
			onOpen: async () => true,
			readClipboard: async () => ({ image }),
		});
		for (const ch of "describe image") view.handleInput(ch);
		view.handleInput("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		view.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const shown = view.render(100).map(stripAnsi).join("\n");
		expect(shown).toContain("describe image");
		expect(shown).toContain("1 image attached");
		expect(shown).toContain("startup unavailable");
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

	it("current managed row can be deleted", async () => {
		const onDeleted = vi.fn();
		let listed: InstanceSummary[] = [
			{ id: "selected", status: "online", activity: "working", cwd: HERE, sessionFile: "/selected.jsonl" },
		];
		const f = makeView({
			currentId: "selected",
			list: () => listed,
			onDeleted: (id) => {
				onDeleted(id);
				listed = [];
			},
		});
		f.view.setInstancesForTest(listed);
		expect(collectRows(listed, undefined, "selected")[0]).toMatchObject({ current: true, self: false });
		f.view.handleInput(CTRL_X);
		await f.flush();
		f.view.handleInput(CTRL_X);
		await f.flush();
		expect(onDeleted).toHaveBeenCalledWith("selected");
		expect(f.calls).toEqual([
			["stop", "selected"],
			["delete", "selected"],
		]);
	});
	it("bulk delete includes current", async () => {
		const onDeleted = vi.fn();
		const listed: InstanceSummary[] = [
			{ id: "selected", status: "online", activity: "working", cwd: HERE, sessionFile: "/selected.jsonl" },
		];
		const f = makeView({ currentId: "selected", list: () => listed, onDeleted });
		f.view.setInstancesForTest(listed);
		f.view.handleInput("\x1b[A");
		f.view.handleInput(CTRL_X);
		await f.flush();
		f.view.handleInput(CTRL_X);
		await f.flush();
		expect(onDeleted).toHaveBeenCalledWith("selected");
		expect(f.calls).toContainEqual(["delete", "selected"]);
	});
	it("delete error retains selection", async () => {
		const onDeleted = vi.fn();
		const listed: InstanceSummary[] = [
			{ id: "selected", status: "stopped", cwd: HERE, sessionFile: "/selected.jsonl" },
		];
		const client = fakeClient([], () => listed);
		client.delete = async () => {
			throw new Error("delete refused");
		};
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as TUI,
			client,
			appName: "bluclawd",
			cwd: HERE,
			home: HOME,
			currentId: () => "selected",
			onDeleted,
			onClose: () => {},
			onOpen: async () => true,
		});
		view.setInstancesForTest(listed);
		view.handleInput(CTRL_X);
		view.handleInput(CTRL_X);
		await new Promise((r) => setTimeout(r, 0));
		expect(onDeleted).not.toHaveBeenCalled();
		expect(view.selectedKeyForTest()).toBe("selected");
		expect(view.render(100).map(stripAnsi).join("\n")).toContain("delete refused");
		view.close();
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

	it("legacy self remains protected from stopping and pinning", async () => {
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

describe("handOff", () => {
	const outgoing = { cwd: HERE, sessionFile: "/s.jsonl", model: { provider: "p", id: "m" } };
	const spy = () => {
		const spawned: unknown[] = [];
		const client = { spawn: async (opts: unknown) => void spawned.push(opts) } as Pick<OrchestratorClient, "spawn">;
		return { spawned, client };
	};

	it("resumes a session that was working with the continue prompt", async () => {
		const { spawned, client } = spy();
		await handOff({ ...outgoing, working: true }, client);
		expect(spawned).toEqual([expect.objectContaining({ sessionFile: "/s.jsonl", prompt: CONTINUE_PROMPT })]);
	});

	it("resumes an idle session without a prompt", async () => {
		const { spawned, client } = spy();
		await handOff({ ...outgoing, working: false }, client);
		expect(spawned).toEqual([expect.objectContaining({ sessionFile: "/s.jsonl", prompt: undefined })]);
	});

	it("swallows a daemon failure", async () => {
		const client = { spawn: async () => Promise.reject(new Error("no daemon")) } as Pick<OrchestratorClient, "spawn">;
		await expect(handOff({ ...outgoing, working: true }, client)).resolves.toBeUndefined();
	});
});

describe("withoutAgentViewCommand", () => {
	it("keeps the plumbing commands out of slash autocomplete", async () => {
		const base = {
			getSuggestions: async () => ({
				prefix: "/a",
				items: [
					{ value: "agent-view", label: "agent-view" },
					{ value: "agent-view-release", label: "agent-view-release" },
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
