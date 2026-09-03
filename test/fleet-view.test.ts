import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { BranchCache } from "../ext/fleet/branch-cache.ts";
import { matchesQuery, relativeTime, sortForRoster } from "../ext/fleet/fleet-status.ts";
import { FleetView } from "../ext/fleet/fleet-view.ts";
import { type InstanceSummary, type OrchestratorClient, piPackageRoot } from "../ext/fleet/orchestrator-client.ts";
import { sessionInfoToSummary } from "../ext/fleet/saved-sessions.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A theme whose styling is the identity, so assertions read plain text. */
const plainTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
} as unknown as Theme;

/** render() reads the wall clock, so timestamps are relative to now; a few seconds of drift
 *  stays inside the same minute bucket. */
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const HOME = "/home/me";
const HERE = `${HOME}/proj/here`;
const THERE = `${HOME}/proj/there`;

const rows: InstanceSummary[] = [
	{ id: "saved:old", status: "stopped", cwd: HERE, label: "old refactor", lastSeenAt: ago(600), messageCount: 8 },
	{ id: "live:work", status: "online", activity: "working", cwd: THERE, label: "port footer", lastSeenAt: ago(1) },
	{ id: "saved:new", status: "stopped", cwd: HERE, label: "fix theme", lastSeenAt: ago(30), messageCount: 21 },
	{ id: "live:ask", status: "online", activity: "awaiting_input", cwd: HERE, label: "deploy", lastSeenAt: ago(5) },
];

function makeView(opts: { cwd?: string } = {}) {
	let renders = 0;
	const ui = { terminal: { rows: 40 }, requestRender: () => renders++ } as unknown as TUI;
	const view = new FleetView({
		ui,
		client: {} as OrchestratorClient,
		appName: "pi",
		cwd: opts.cwd ?? HERE,
		home: HOME,
		mascotLines: null,
		onClose: () => {
			closed++;
		},
		onJumpIn: () => {},
	});
	let closed = 0;
	view.setInstancesForTest(rows);
	return { view, text: () => view.render(80).map(stripAnsi), closed: () => closed, renders: () => renders };
}

beforeAll(() => setSharedTheme(plainTheme));

describe("roster helpers", () => {
	it("formats relative time in Claude Code's narrow form", () => {
		expect(relativeTime(ago(0), NOW)).toBe("0s ago");
		expect(relativeTime(ago(5), NOW)).toBe("5m ago");
		expect(relativeTime(ago(180), NOW)).toBe("3h ago");
		expect(relativeTime(ago(60 * 48), NOW)).toBe("2d ago");
		expect(relativeTime(undefined, NOW)).toBe("");
	});

	it("sorts live sessions first (needs input, working, idle), then by recency", () => {
		expect(sortForRoster(rows).map((r) => r.id)).toEqual(["live:ask", "live:work", "saved:new", "saved:old"]);
	});

	it("matches a query case-insensitively across every given field", () => {
		expect(matchesQuery(["Fix Theme", HERE, "main"], "theme")).toBe(true);
		expect(matchesQuery(["fix theme", HERE, "main"], "MAIN")).toBe(true);
		expect(matchesQuery(["fix theme", HERE, undefined], "proj/here")).toBe(true);
		expect(matchesQuery(["fix theme", HERE, undefined], "nope")).toBe(false);
		expect(matchesQuery([undefined], "   ")).toBe(true);
	});

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

	it("carries the message count from pi's session index into a saved row", () => {
		const row = sessionInfoToSummary({
			path: "/s.jsonl",
			id: "abc",
			cwd: HERE,
			created: new Date(NOW),
			modified: new Date(NOW),
			messageCount: 12,
			firstMessage: "hello",
		});
		expect(row.messageCount).toBe(12);
		expect(row.label).toBe("hello");
	});

	it("resolves a branch once per cwd and notifies when it lands", async () => {
		const calls: string[] = [];
		let changes = 0;
		const cache = new BranchCache(
			() => changes++,
			async (cwd) => {
				calls.push(cwd);
				return cwd === "/repo" ? "main" : "";
			},
		);
		expect(cache.get("/repo")).toBeUndefined();
		expect(cache.get("/repo")).toBeUndefined(); // still in flight — no second lookup
		await new Promise((r) => setTimeout(r, 0));
		expect(cache.get("/repo")).toBe("main");
		expect(cache.get("/plain")).toBeUndefined();
		await new Promise((r) => setTimeout(r, 0));
		expect(cache.get("/plain")).toBeUndefined(); // non-repo: cached as "no branch"
		expect(calls).toEqual(["/repo", "/plain"]);
		expect(changes).toBe(2);
	});
});

describe("FleetView roster (Claude Code /resume style)", () => {
	it("renders two lines per session: cursor + title + badge, then dim details", () => {
		const { text } = makeView();
		const lines = text();
		const title = lines.find((l) => l.includes("deploy"));
		expect(title).toMatch(/^› deploy\s+Needs input$/);
		expect(lines[lines.indexOf(title as string) + 1]).toBe("    5m ago · ~/proj/here");
		const saved = lines.find((l) => l.includes("fix theme"));
		expect(saved).toMatch(/^ {2}fix theme\s+Done$/);
		expect(lines[lines.indexOf(saved as string) + 1]).toBe("    30m ago · 21 messages · ~/proj/here");
	});

	it("shows the search placeholder and the all-projects scope by default", () => {
		const { text } = makeView();
		const lines = text();
		expect(lines).toContain("  Type to search");
		expect(lines.some((l) => l.includes("all projects"))).toBe(true);
		expect(lines.some((l) => l.includes("ctrl+a current project"))).toBe(true);
	});

	it("filters as you type, shows the query, and esc clears it before closing", () => {
		const { view, text, closed } = makeView();
		for (const ch of "fix") view.handleInput(ch);
		expect(view.orderedIdsForTest()).toEqual(["saved:new"]);
		expect(text().some((l) => l.includes("1 of 4"))).toBe(true);
		expect(text().some((l) => l.includes("esc clear"))).toBe(true);
		view.handleInput("\x7f"); // backspace
		view.handleInput("\x7f");
		view.handleInput("\x7f");
		expect(view.orderedIdsForTest()).toHaveLength(4);
		for (const ch of "zzz") view.handleInput(ch);
		expect(text()).toContain('  No sessions match "zzz".');
		view.handleInput("\x1b"); // esc: clears the query, does not close
		expect(closed()).toBe(0);
		expect(view.orderedIdsForTest()).toHaveLength(4);
		view.handleInput("\x1b"); // esc again: closes
		expect(closed()).toBe(1);
	});

	it("ctrl+a narrows to the current project and drops the path from the details line", () => {
		const { view, text } = makeView();
		view.handleInput("\x01"); // ctrl+a
		expect(view.orderedIdsForTest()).toEqual(["live:ask", "saved:new", "saved:old"]);
		const lines = text();
		expect(lines.some((l) => l.includes("current project"))).toBe(true);
		expect(lines.some((l) => l.includes("3 of 4"))).toBe(true);
		expect(lines).toContain("    5m ago");
		view.handleInput("\x01");
		expect(view.orderedIdsForTest()).toHaveLength(4);
	});

	it("says how to widen the scope when the current project has nothing", () => {
		const { view, text } = makeView({ cwd: "/elsewhere" });
		view.handleInput("\x01");
		expect(text()).toContain("  No sessions in this project — ctrl+a shows all projects");
	});

	it("ctrl+n opens the new-session panel; typing never does", () => {
		const { view, text } = makeView();
		view.handleInput("a");
		expect(text().some((l) => l.startsWith("New session"))).toBe(false);
		view.handleInput("\x1b");
		view.handleInput("\x0e"); // ctrl+n
		expect(text().some((l) => l.startsWith("New session"))).toBe(true);
	});

	it("shows unnamed sessions by the first 8 characters of their id", () => {
		const { view, text } = makeView();
		view.setInstancesForTest([
			{ id: "ext:1", status: "online", activity: "idle", cwd: HERE, sessionId: "01a067e4-c59a-71c7" },
		]);
		expect(text()).toContain("› 01a067e4                                                                  Idle");
	});

	it("stays on the top row until the user moves, even when live rows arrive above saved ones", () => {
		const { view } = makeView();
		view.setInstancesForTest(rows.filter((r) => r.status === "stopped"));
		expect(view.selectedIdForTest()).toBe("saved:new");
		view.setInstancesForTest(rows); // live rows now sort above
		expect(view.selectedIdForTest()).toBe("live:ask");
	});

	it("explains why ctrl+t cannot peek at a saved or externally-open session", () => {
		const attached: string[] = [];
		const withAttach = new FleetView({
			ui: { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
			client: {} as OrchestratorClient,
			appName: "pi",
			cwd: HERE,
			home: HOME,
			mascotLines: null,
			selfId: "ext:me",
			onClose: () => {},
			onJumpIn: () => {},
			onAttach: (id) => attached.push(id),
		});
		withAttach.setInstancesForTest([
			{ id: "child:1", status: "online", activity: "working", cwd: HERE, label: "child" },
			{ id: "ext:me", status: "online", activity: "idle", cwd: HERE, label: "me", external: true },
			{ id: "saved:x", status: "stopped", cwd: HERE, label: "old", sessionFile: "/x.jsonl" },
		]);
		withAttach.handleInput("\x14"); // ctrl+t on the running child → attaches
		expect(attached).toEqual(["child:1"]);
		withAttach.handleInput("\x1b[B");
		withAttach.handleInput("\x14");
		expect(withAttach.render(80).map(stripAnsi).join("\n")).toContain("you're in this session already");
		withAttach.handleInput("\x1b[B");
		withAttach.handleInput("\x14");
		expect(withAttach.render(80).map(stripAnsi).join("\n")).toContain("peek needs a running session");
		expect(attached).toEqual(["child:1"]);
	});

	it("keeps the selection anchored to the same session across a refresh that reorders", () => {
		const { view } = makeView();
		view.handleInput("\x1b[B"); // down → live:work
		expect(view.selectedIdForTest()).toBe("live:work");
		view.setInstancesForTest([...rows].reverse());
		expect(view.selectedIdForTest()).toBe("live:work");
	});
});
