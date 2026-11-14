import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fleetState, GRID, loaderHtml, mascotHtml, mascotState } from "#remote-web/mascot.js";
import type { ChatVerdict } from "../daemon/remote/sessions.ts";
import { SOURCE } from "../ext/_shared/mascot.ts";

const session = (state: string, more: Record<string, unknown> = {}) => ({
	id: "a",
	label: "a",
	cwd: "/p",
	band: "idle",
	state,
	alive: true,
	detail: "",
	verdict: { act: true } as ChatVerdict,
	...more,
});
const live = (text: string, running: boolean[] = []) => ({ text, tools: running.map((r) => ({ running: r })) });

describe("what the phone's mascot acts out", () => {
	it("is what the reply in progress does while its session works", () => {
		expect(mascotState(session("working"), undefined, true)).toBe("thinking");
		expect(mascotState(session("working"), live(""), true)).toBe("thinking");
		expect(mascotState(session("working"), live("Let me"), true)).toBe("writing");
		// A running tool, whatever text came before it.
		expect(mascotState(session("working"), live("Let me", [false, true]), true)).toBe("tool");
		expect(mascotState(session("working"), live("Let me", [false]), true)).toBe("writing");
	});

	it("waves for an answer, and shows how a turn ended", () => {
		expect(mascotState(session("needs"), live("x", [true]), true)).toBe("needs");
		expect(mascotState(session("done"), undefined, true)).toBe("done");
		expect(mascotState(session("failed"), undefined, true)).toBe("failed");
		expect(mascotState(session("idle"), undefined, true)).toBe("idle");
	});

	it("is asleep while nothing answers for the session", () => {
		expect(mascotState(undefined, undefined, true)).toBe("asleep");
		expect(mascotState(session("working"), live("x"), false)).toBe("asleep");
		expect(mascotState(session("working", { alive: false }), undefined, true)).toBe("asleep");
		expect(mascotState(session("working", { silent: true }), undefined, true)).toBe("asleep");
		expect(mascotState(session("stopped"), undefined, true)).toBe("asleep");
	});

	it("for the whole list: asleep off the Mac, else a wave before thinking before rest", () => {
		const sessions = [session("idle"), session("working"), session("needs")];
		expect(fleetState(sessions, false)).toBe("asleep");
		expect(fleetState(sessions, true)).toBe("needs");
		expect(fleetState(sessions.slice(0, 2), true)).toBe("thinking");
		expect(fleetState([session("idle"), session("working", { alive: false })], true)).toBe("idle");
		expect(fleetState([], true)).toBe("idle");
	});
});

describe("the phone's mascot", () => {
	const views = (html: string) => [...html.matchAll(/<g class="view (\w)"/g)].map((m) => m[1]);

	it("is mascot.svg's grid from the front, its two eyes a group of their own", () => {
		expect(GRID).toEqual(SOURCE);
		expect(loaderHtml()).toContain(
			`<g class="eyes"><rect x="5" y="4" width="2" height="2"/><rect x="13" y="4" width="2" height="2"/></g>`,
		);
		expect(loaderHtml()).toContain("Loading…");
	});

	it("turns only in the states that turn, the view it holds still first", () => {
		expect(views(mascotHtml("idle"))).toEqual(["f", "l", "r"]);
		expect(views(mascotHtml("loading"))).toEqual(["f", "l", "r"]);
		expect(views(mascotHtml("thinking"))).toEqual(["r", "l"]);
		expect(views(mascotHtml("tool"))).toEqual(["r"]);
		for (const state of ["writing", "needs", "done", "failed", "asleep", "wave"] as const) {
			expect(views(mascotHtml(state))).toEqual(["f"]);
		}
	});

	it("has the same parts in every view, facing right the mirror of facing left", () => {
		const html = mascotHtml("idle");
		const [front, left, right] = html.split('<g class="view ').slice(1);
		for (const view of [front, left, right]) {
			for (const part of ['class="arm l"', 'class="upper"', 'class="body"', 'class="eyes"', 'class="lids"']) {
				expect(view).toContain(part);
			}
			expect(view?.match(/class="legs/g)?.length).toBeGreaterThan(0);
		}
		expect(right).toContain('transform="matrix(-1 0 0 1 20 0)"');
		expect(right?.slice(right.indexOf(">"))).toContain(left?.slice(left.indexOf(">") + 1, left.lastIndexOf("</g>")));
	});

	it("stands on four legs in every view", () => {
		const [front, left, right] = mascotHtml("idle").split('<g class="view ').slice(1);
		// The front's legs are one path, a rectangle per leg and row.
		expect(front?.match(/<path class="legs" d="([^"]*)"/)?.[1]?.match(/M\d+ 12h2/g)).toHaveLength(4);
		for (const view of [left, right])
			expect(view?.match(/<rect[^>]* y="12" width="2" height="3"\/>/g)).toHaveLength(4);
	});

	it("moves by keyframes style.css defines, and stops for reduced motion", () => {
		const css = readFileSync(new URL("../daemon/remote/web/style.css", import.meta.url), "utf8");
		const defined = new Set([...css.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]));
		const rules = [...css.matchAll(/^\s*(\.mascot[^{]*)\{ animation: ([\w-]+) /gm)];
		expect(rules.length).toBeGreaterThan(20);
		for (const [, , name] of rules) expect(defined).toContain(name);
		// Every state's motion is inside the no-preference block; only the loader moves outside it.
		const motion = css.slice(
			css.indexOf("@media (prefers-reduced-motion: no-preference) {\n\t.mascot"),
			css.indexOf("/* Something still moves while it loads"),
		);
		const outside = css.replace(motion, "");
		expect([...outside.matchAll(/^\s*\.mascot\.(\w+)[^{]*\{ animation:/gm)].map((m) => m[1])).toEqual([
			"loading",
			"loading",
			"loading",
		]);
	});
});
