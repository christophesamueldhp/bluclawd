import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ageAt, STATE_WORDS, sessionGroups, statusGlyph, successor, viewMode } from "#remote-web/list.js";
import { STATE_WORDS as TERMINAL_STATE_WORDS } from "../daemon/rows.ts";

const row = (id: string, state: string, more: Record<string, unknown> = {}) => ({
	id,
	label: id,
	cwd: "/p",
	band: state === "needs" || state === "working" ? state : "idle",
	state,
	alive: true,
	resumable: false,
	detail: "",
	...more,
});
const createdAt = "2026-10-15T10:00:00.000Z";
const finishedAt = "2026-10-15T11:00:00.000Z";

describe("session grouping on the phone", () => {
	const sessions = [
		row("working", "working", { cwd: "/z/project" }),
		row("pinned", "needs", { cwd: "/z/project", band: "pinned" }),
		row("done", "done", { cwd: "/a/project" }),
		row("needs", "needs", { cwd: "/z/project" }),
	];

	it("defaults to status unless the saved preference is directory", () => {
		for (const value of [null, "", "state", "invalid"]) expect(viewMode(value)).toBe("state");
		expect(viewMode("directory")).toBe("directory");
	});

	it("keeps the existing status bands and their row order", () => {
		expect(sessionGroups(sessions, "state")).toEqual([
			{ title: "Pinned", rows: [sessions[1]] },
			{ title: "Needs input", rows: [sessions[3]] },
			{ title: "Working", rows: [sessions[0]] },
			{ title: "Idle", rows: [sessions[2]] },
		]);
	});

	it("groups by full path alphabetically, keeping pinned sessions separate", () => {
		expect(sessionGroups(sessions, "directory")).toEqual([
			{ title: "Pinned", rows: [sessions[1]] },
			{ title: "/a/project", rows: [sessions[2]] },
			{ title: "/z/project", rows: [sessions[0], sessions[3]] },
		]);
	});

	it("omits empty groups and groups only the sessions provided by search", () => {
		for (const mode of ["state", "directory"] as const) {
			expect(sessionGroups([], mode)).toEqual([]);
			expect(sessionGroups([sessions[1]!], mode)).toEqual([{ title: "Pinned", rows: [sessions[1]] }]);
		}
		expect(sessionGroups([sessions[3]!], "directory")).toEqual([{ title: "/z/project", rows: [sessions[3]] }]);
	});
});

describe("session status on the phone", () => {
	it("uses the same state names as terminal agent view", () => {
		expect(STATE_WORDS).toEqual(TERMINAL_STATE_WORDS);
	});

	it("matches terminal agent view's spinner frames and timing", () => {
		const terminal = readFileSync(new URL("../ext/agent-view/agent-view.ts", import.meta.url), "utf8");
		const css = readFileSync(new URL("../daemon/remote/web/style.css", import.meta.url), "utf8");
		const frames = JSON.parse(terminal.match(/const FRAMES = (\[[^;]+\]);/)![1]) as string[];
		const animation = css.match(/@keyframes session-spin \{([\s\S]*?)\n\}/)![1];
		const steps = [...animation.matchAll(/([\d.]+)% \{ content: "([^"]+)"; \}/g)];
		expect(steps.map((step) => step[2]?.replaceAll("\uFE0E", ""))).toEqual([...frames, ...[...frames].reverse()]);
		// iOS otherwise renders this frame as a white asterisk in a green emoji box.
		expect(steps.filter((step) => step[2]?.startsWith("✳")).map((step) => step[2])).toEqual(["✳\uFE0E", "✳\uFE0E"]);
		steps.forEach((step, i) => {
			expect(Number(step[1])).toBeCloseTo((i * 100) / steps.length, 5);
		});
		expect(terminal).toContain("}, 120);");
		expect(css).toContain("animation: session-spin 1.44s steps(1, end) infinite");
		expect(css).toContain('.session-spinner::before { content: "✻"; animation: none; }');
	});

	it("animates only live working sessions and keeps the terminal glyphs for other states", () => {
		for (const state of Object.keys(STATE_WORDS)) {
			expect(statusGlyph(row("a", state))).toBe(state === "working" ? "" : "✻");
			expect(statusGlyph(row("a", state, { alive: false }))).toBe("∙");
		}
	});
});

describe("a row's age on the phone", () => {
	it("counts from its last entry once it is quiet", () => {
		for (const state of ["idle", "done", "failed", "stopped"]) {
			expect(ageAt(row("a", state, { createdAt, finishedAt })), state).toBe(finishedAt);
		}
		// A pinned row is in the pinned band, and quiet all the same.
		expect(ageAt(row("a", "idle", { band: "pinned", createdAt, finishedAt }))).toBe(finishedAt);
	});

	it("counts from its start while it works or waits on an answer", () => {
		expect(ageAt(row("a", "working", { createdAt, finishedAt }))).toBe(createdAt);
		expect(ageAt(row("a", "needs", { createdAt, finishedAt }))).toBe(createdAt);
	});

	it("falls back on its start, and on nothing", () => {
		expect(ageAt(row("a", "idle", { createdAt }))).toBe(createdAt);
		expect(ageAt(row("a", "idle"))).toBeUndefined();
	});
});

describe("an open chat whose row is gone", () => {
	const sessions = [row("pi-2", "idle", { sessionId: "s1" }), row("pi-3", "idle", { sessionId: "s2" })];

	it("moves to the row with the same pi session", () => {
		expect(successor(sessions, "pi-1", "s1")).toBe("pi-2");
	});

	it("stays while its own row is listed", () => {
		expect(successor([...sessions, row("pi-1", "idle", { sessionId: "s1" })], "pi-1", "s1")).toBeUndefined();
	});

	it("stays when no row has its session, or its session is not known", () => {
		expect(successor(sessions, "pi-1", "s9")).toBeUndefined();
		expect(successor(sessions, "pi-1", undefined)).toBeUndefined();
		expect(successor([row("pi-4", "idle")], "pi-1", undefined)).toBeUndefined();
	});
});
