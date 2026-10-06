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
		// A working session's turn is still in progress once its tools finish.
		handOver: async (id: string) => {
			calls.push(["handOver", id]);
			return list().find((i) => i.id === id)?.activity === "working";
		},
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
		client: fakeClient(calls, opts.list ?? (() => instances), opts.releases),
		appName: "bluclawd",
		version: "1.0.0",
		model: { provider: "opencode-go", id: "kimi" },
		cwd: HERE,
		home: HOME,
		self: opts.self ? () => opts.self : undefined,
		onClose: () => closed++,
		onOpen: (file, _cwd, resume) => {
			opened.push(file);
			resumed.push(resume);
		},
		fileExists: () => true,
		readClipboard: opts.readClipboard,
		onCreateAndOpen: (...args) => {
			calls.push(["createAndOpen", ...args]);
		},
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
		expect(text().join("\n")).toMatch(/❯ write the menu\nthen the credits/);
		view.handleInput("\x1b[13;2u"); // shift+enter (kitty)
		view.handleInput("\x7f"); // backspace on the empty third line
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]?.[1]).toMatchObject({ prompt: "write the menu\nthen the credits" });
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

	it("opening a working session moves it into this window, where its turn carries on", async () => {
		const { view, calls, opened, resumed, flush } = makeView();
		view.setInstancesForTest([
			{ id: "w", status: "online", activity: "working", cwd: HERE, sessionFile: "/w.jsonl", createdAt: ago(1) },
		]);
		view.handleInput(ENTER);
		for (let i = 0; i < 5; i++) await flush();
		expect(calls).toEqual([["handOver", "w"]]);
		expect(opened).toEqual(["/w.jsonl"]);
		expect(resumed).toEqual([true]);
	});

	it("a row drawn idle whose session has since started working still carries the turn over", async () => {
		const writer: InstanceSummary = {
			id: "w",
			status: "online",
			activity: "working",
			cwd: HERE,
			sessionFile: "/w.jsonl",
		};
		const { view, calls, resumed, flush } = makeView({ list: () => [writer] });
		view.setInstancesForTest([{ ...writer, activity: "idle" }]);
		view.handleInput(ENTER);
		for (let i = 0; i < 5; i++) await flush();
		expect(calls).toEqual([["handOver", "w"]]);
		expect(resumed).toEqual([true]);
	});

	it("does not open a live session if stopping its writer fails, and keeps the view usable", async () => {
		const calls: Calls = [];
		const row: InstanceSummary = { id: "w", status: "online", activity: "idle", cwd: HERE, sessionFile: "/w.jsonl" };
		const client = fakeClient(calls, () => [row]);
		client.handOver = async () => {
			throw new Error("stop timed out");
		};
		let opened = false;
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
			onOpen: () => {
				opened = true;
			},
			fileExists: () => true,
		});
		view.setInstancesForTest([row]);
		view.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(opened).toBe(false);
		expect(view.render(100).map(stripAnsi).join("\n")).toContain("stop timed out");
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
			onOpen: () => {},
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

	it("Esc during a hand-over leaves a turn in progress running in the background", async () => {
		let finish!: (working: boolean) => void;
		const calls: Calls = [];
		const row: InstanceSummary = {
			id: "w",
			status: "online",
			activity: "working",
			cwd: HERE,
			sessionFile: "/w.jsonl",
		};
		const client = fakeClient(calls, () => [row]);
		client.handOver = () =>
			new Promise<boolean>((resolve) => {
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
			onOpen: () => {
				opened = true;
			},
			fileExists: () => true,
		});
		view.setInstancesForTest([row]);
		view.handleInput(ENTER);
		await vi.waitFor(() => expect(finish).toBeDefined());
		view.handleInput(ESC);
		finish(true);
		await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
		expect(opened).toBe(false);
		expect(calls[0]).toEqual([
			"spawn",
			expect.objectContaining({ sessionFile: "/w.jsonl", prompt: CONTINUE_PROMPT }),
		]);
	});

	it("explains how to recover a legacy Failed row that never recorded its file", () => {
		const { view, text, opened } = makeView();
		view.setInstancesForTest([{ id: "legacy", status: "stopped", outcome: "failed", cwd: HERE }]);
		view.handleInput(ENTER);
		expect(opened).toEqual([]);
		expect(text().join("\n")).toContain("/resume");
	});

	it("opening a finished live session releases its idle writer without a prompt", async () => {
		const { view, calls, resumed, flush } = makeView();
		view.setInstancesForTest([
			{ id: "d", status: "online", activity: "idle", cwd: HERE, sessionFile: "/d.jsonl", outcome: "done", turns: 1 },
		]);
		view.handleInput(ENTER);
		for (let i = 0; i < 5; i++) await flush();
		expect(calls).toEqual([["handOver", "d"]]);
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

		it("enter asks that terminal to let go, then opens it here", async () => {
			let held = true;
			const { view, calls, opened, resumed, flush } = makeView({
				list: () => (held ? [stored, holder("idle")] : [stored]),
			});
			view.setInstancesForTest([stored, holder("idle")]);
			view.handleInput(ENTER);
			await flush();
			expect(calls).toEqual([["release", "/x.jsonl"]]);
			expect(opened).toEqual([]);
			held = false;
			await vi.waitFor(() => expect(opened).toEqual(["/x.jsonl"]));
			expect(resumed).toEqual([false]);
		});

		it("does not request release while the other terminal is still working", async () => {
			const { view, calls, opened, resumed, flush } = makeView({ list: () => [stored, holder("working")] });
			view.setInstancesForTest([stored, holder("working")]);
			view.handleInput(ENTER);
			await flush();
			expect(calls).toEqual([]);
			expect(opened).toEqual([]);
			expect(resumed).toEqual([]);
			view.handleInput(ESC);
		});

		it("says so when the daemon cannot pass the request on", async () => {
			const { view, opened, text, flush } = makeView({ releases: false, list: () => [stored, holder("idle")] });
			view.setInstancesForTest([stored, holder("idle")]);
			view.handleInput(ENTER);
			for (let i = 0; i < 5; i++) await flush();
			expect(opened).toEqual([]);
			expect(text().join("\n")).toContain("close pi there");
		});

		it("gives up when the other terminal never lets go", async () => {
			vi.useFakeTimers();
			try {
				const { view, opened, text } = makeView({ list: () => [stored, holder("idle")] });
				view.setInstancesForTest([stored, holder("idle")]);
				view.handleInput(ENTER);
				await vi.advanceTimersByTimeAsync(15_500);
				expect(opened).toEqual([]);
				expect(text().join("\n")).toContain("didn't let go");
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
			onOpen: () => {},
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

	it("ctrl+c clears the draft and arms the exit at once; a second press quits pi", () => {
		let quit = 0;
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client: fakeClient([]),
			appName: "bluclawd",
			cwd: HERE,
			home: HOME,
			onClose: () => {},
			onOpen: () => {},
			onQuit: () => quit++,
		});
		view.setInstancesForTest(sessions);
		for (const ch of "draft") view.handleInput(ch);
		view.handleInput("\x03");
		const shown = view.render(100).map(stripAnsi).join("\n");
		expect(shown).not.toContain("❯ draft");
		expect(shown).toContain("Press Ctrl-C again to exit · 2 agents will keep running");
		view.handleInput("\x03");
		expect(quit).toBe(1);
	});

	it("exit words quit; an unknown /command is a task, not an error", async () => {
		const { view, calls, closed, flush } = makeView();
		for (const ch of "/brainstorm a menu") view.handleInput(ch);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["spawn", expect.objectContaining({ prompt: "/brainstorm a menu" })]);
		for (const ch of "exit") view.handleInput(ch);
		view.handleInput(ENTER);
		expect(closed()).toBe(1);
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
		expect(calls[0]).toEqual(["rename", "ask", "power-up design v2"]);
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
		expect(peek).toContain("│   1. Yes");
		expect(peek).toContain("│   2. No");
		// A number fills in that option; enter sends it.
		view.handleInput("1");
		expect(text().join("\n")).toContain("❯ Yes");
		expect(calls).toEqual([]);
		view.handleInput(ENTER);
		await flush();
		expect(calls[0]).toEqual(["answer", "ask", "q1", { value: "Yes" }]);
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

	it("ctrl+t cannot pin your own session", async () => {
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
		view.handleInput(CTRL_T);
		expect(text().join("\n")).toContain("Only background sessions can be pinned");
		await flush();
		expect(calls).toEqual([]);
		view.handleInput(ENTER);
		expect(calls).toEqual([]);
	});

	it("ctrl+x stops your own session's turn, a second press deletes it", async () => {
		const self: InstanceSummary = { id: "me", status: "online", activity: "working", cwd: HERE, external: true };
		let stopped = 0;
		let deleted = 0;
		const view = new AgentView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client: fakeClient([], () => []),
			appName: "bluclawd",
			cwd: HERE,
			home: HOME,
			self: () => self,
			onClose: () => {},
			onOpen: () => {},
			onStopSelf: () => stopped++,
			onDeleteSelf: () => deleted++,
		});
		view.setInstancesForTest([]);
		view.handleInput(CTRL_X);
		expect(stopped).toBe(1);
		expect(view.render(100).map(stripAnsi).join("\n")).toContain("ctrl+x again to delete");
		view.handleInput(CTRL_X);
		await vi.waitFor(() => expect(deleted).toBe(1));
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
