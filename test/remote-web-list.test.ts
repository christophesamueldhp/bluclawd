import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ageAt,
	ageText,
	isUnseen,
	paneUp,
	replyBox,
	STATE_WORDS,
	sessionGroups,
	sharedWarning,
	statusGlyph,
	viewMode,
} from "#remote-web/list.js";
import type { ChatVerdict } from "../daemon/remote/sessions.ts";
import { livePanesWarning, STATE_WORDS as TERMINAL_STATE_WORDS } from "../daemon/rows.ts";

const row = (id: string, state: string, more: Record<string, unknown> = {}) => ({
	id,
	label: id,
	cwd: "/p",
	band: state === "needs" || state === "working" ? state : "idle",
	state,
	alive: true,
	resumable: false,
	detail: "",
	verdict: { act: true } as ChatVerdict,
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

	it.each([
		[{ act: true }, true, { open: true, placeholder: "Reply" }],
		// No terminal on the Mac shows pi: read only, whatever the row.
		[{ act: true }, false, { open: false, placeholder: "Read only" }],
		[{ act: false, reason: "silent" }, true, { open: false, placeholder: "Not responding" }],
		[{ act: false, reason: "silent" }, false, { open: false, placeholder: "Not responding" }],
		[{ act: false, reason: "not_running" }, true, { open: false, placeholder: "Disconnected" }],
		[{ act: false, reason: "starting" }, true, { open: false, placeholder: "Starting…" }],
	])(
		"takes prompts and actions only as the daemon's verdict %j says, with a terminal open: %s",
		(verdict, terminalOpen, shown) => {
			expect(replyBox(row("a", "idle", { verdict }), terminalOpen)).toEqual(shown);
		},
	);

	it("warns, as the terminal does, when several panes run one session file", () => {
		expect(sharedWarning(row("a", "working", { livePanes: 2 }))).toBe(livePanesWarning(2));
		expect(sharedWarning(row("a", "working"))).toBe("");
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

describe("a session started from the phone", () => {
	it("is up once its row is listed and no longer starting", () => {
		expect(paneUp([], "r1")).toBe(false);
		expect(paneUp([row("r1", "working", { starting: true })], "r1")).toBe(false);
		expect(paneUp([row("r2", "working")], "r1")).toBe(false);
		expect(paneUp([row("r1", "working")], "r1")).toBe(true);
	});
});

describe("a row's age as the phone writes it", () => {
	const now = Date.parse(finishedAt);
	const ago = (ms: number) => new Date(now - ms).toISOString();

	it("reads just now, then minutes, hours and days", () => {
		expect(ageText(ago(20_000), now)).toBe("just now");
		expect(ageText(ago(5 * 60_000), now)).toBe("5m");
		expect(ageText(ago(3 * 3_600_000), now)).toBe("3h");
		expect(ageText(ago(2 * 86_400_000), now)).toBe("2d");
		expect(ageText(undefined, now)).toBe("");
	});
});

describe("an Unseen session on the phone", () => {
	const since = createdAt;

	it("finished a turn since its Chat was last opened here", () => {
		const seen = { since, at: { a: "2026-10-15T10:30:00.000Z" } };
		expect(isUnseen(row("a", "done", { finishedAt }), seen)).toBe(true);
		expect(isUnseen(row("a", "done", { finishedAt }), { since, at: { a: finishedAt } })).toBe(false);
	});

	it("counts from when this phone began keeping track for a Chat never opened here", () => {
		expect(isUnseen(row("a", "failed", { finishedAt }), { since, at: {} })).toBe(true);
		expect(isUnseen(row("a", "stopped", { finishedAt }), { since: finishedAt, at: {} })).toBe(false);
	});

	it("is never a session that works, waits on an answer, or has not finished a turn", () => {
		const seen = { since, at: {} };
		expect(isUnseen(row("a", "working", { finishedAt }), seen)).toBe(false);
		expect(isUnseen(row("a", "needs", { finishedAt }), seen)).toBe(false);
		expect(isUnseen(row("a", "idle"), seen)).toBe(false);
	});
});
