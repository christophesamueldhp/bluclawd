import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { FRAME_MS, SEQUENCES } from "../ext/branding/mascot.ts";
import {
	CLICK_SEQUENCES,
	type Clock,
	elidePath,
	keepInputListenerFirst,
	loadEntranceVersion,
	MascotPlayer,
	olderVersion,
	parseLeftPress,
	pickEntrance,
	removeInputListener,
	saveEntranceVersion,
	WelcomeHeader,
	type WelcomeHeaderInfo,
	welcomeLines,
} from "../ext/branding/welcome-header.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const info: WelcomeHeaderInfo = {
	version: "0.84.3",
	model: "Kimi K2.6",
	effort: "high",
	provider: "OpenCode Go",
	cwd: "~/Desktop/Project/bluclawd",
};

describe("welcomeLines", () => {
	it("draws Claude Code's three lines: bold name + faint version, model · billing, cwd", () => {
		const lines = welcomeLines(info, 120, 11);
		expect(lines.map(plain)).toEqual([
			"bluclawd v0.84.3",
			"Kimi K2.6 with high effort · OpenCode Go",
			"~/Desktop/Project/bluclawd",
		]);
		expect(lines[0]).toBe("\x1b[1mbluclawd\x1b[22m \x1b[2mv0.84.3\x1b[22m");
		expect(lines[1]!.startsWith("\x1b[2m")).toBe(true);
	});

	it("splits model and billing when they do not fit on one line, then elides the cwd", () => {
		// width = max(50 - 17, 20) = 33 < 26 + 3 + 11
		const lines = welcomeLines(info, 50, 11).map(plain);
		expect(lines).toEqual([
			"bluclawd v0.84.3",
			"Kimi K2.6 with high effort",
			"OpenCode Go",
			"~/Desktop/Project/bluclawd",
		]);
		expect(
			welcomeLines({ ...info, cwd: "~/a/very/long/path/to/some/deep/project" }, 30, 11)
				.map(plain)
				.at(-1),
		).toBe("~/…/deep/project");
	});

	it("leaves out the effort without a thinking level and the model line without a model", () => {
		expect(welcomeLines({ ...info, effort: undefined }, 120, 11).map(plain)[1]).toBe("Kimi K2.6 · OpenCode Go");
		expect(welcomeLines({ ...info, model: undefined }, 120, 11).map(plain)).toEqual([
			"bluclawd v0.84.3",
			"~/Desktop/Project/bluclawd",
		]);
	});
});

describe("elidePath", () => {
	it("keeps the first and last segments and as many middle ones as fit", () => {
		expect(elidePath("~/Desktop/Project/bluclawd", 40)).toBe("~/Desktop/Project/bluclawd");
		expect(elidePath("~/Desktop/Project/bluclawd", 22)).toBe("~/…/Project/bluclawd");
		expect(elidePath("~/Desktop/Project/bluclawd", 15)).toBe("~/…/bluclawd");
		expect(elidePath("~/Desktop/Project/bluclawd", 10)).toBe("…/bluclawd");
		expect(elidePath("/usr/local/share/a-very-long-leaf", 12)).toBe("/a-very-lon…");
	});
});

describe("entrance", () => {
	const base = { fullscreen: true, reducedMotion: false, force: false, version: "0.84.3", random: () => 0 };

	it("plays once per version, in the fullscreen renderer, without reduced motion", () => {
		expect(pickEntrance({ ...base, lastVersion: undefined })).toBe("skip");
		expect(pickEntrance({ ...base, lastVersion: "0.84.2" })).toBe("skip");
		expect(pickEntrance({ ...base, lastVersion: "0.84.3" })).toBeUndefined();
		expect(pickEntrance({ ...base, lastVersion: "0.84.3", force: true })).toBe("skip");
		expect(pickEntrance({ ...base, lastVersion: undefined, fullscreen: false })).toBeUndefined();
		expect(pickEntrance({ ...base, lastVersion: undefined, reducedMotion: true, force: true })).toBeUndefined();
	});

	it("picks among skip, jump, look and spin", () => {
		const picks = [0, 0.3, 0.6, 0.9].map((r) => pickEntrance({ ...base, lastVersion: undefined, random: () => r }));
		expect(picks).toEqual(["skip", "jump", "look", "spin"]);
	});

	it("compares versions numerically", () => {
		expect(olderVersion("0.9.0", "0.10.0")).toBe(true);
		expect(olderVersion("1.0.0", "0.10.0")).toBe(false);
		expect(olderVersion("0.84.3", "0.84.3")).toBe(false);
	});

	it("remembers the version it played for", () => {
		const dir = mkdtempSync(join(tmpdir(), "branding-"));
		expect(loadEntranceVersion(dir)).toBeUndefined();
		saveEntranceVersion(dir, "0.84.3");
		expect(loadEntranceVersion(dir)).toBe("0.84.3");
	});
});

function fakeClock() {
	const pending = new Map<number, { fn: () => void; ms: number }>();
	let next = 0;
	const clock: Clock = {
		setTimeout: (fn, ms) => {
			pending.set(++next, { fn, ms });
			return next;
		},
		clearTimeout: (handle) => pending.delete(handle as number),
	};
	const tick = () => {
		const [id, timer] = [...pending.entries()][0] ?? [];
		if (id === undefined || !timer) return false;
		pending.delete(id);
		expect(timer.ms).toBe(FRAME_MS);
		timer.fn();
		return true;
	};
	return { clock, tick, pending };
}

describe("MascotPlayer", () => {
	it("holds two frames, plays the sequence once at 60 ms a frame, then rests on its last frame", () => {
		const { clock, tick } = fakeClock();
		let renders = 0;
		const player = new MascotPlayer("jump", () => renders++, clock);
		const seen = [player.frame];
		while (tick()) seen.push(player.frame);
		expect(seen).toEqual([{ pose: "default", offset: 0 }, { pose: "default", offset: 0 }, ...SEQUENCES.jump]);
		expect(renders).toBe(seen.length); // one repaint per frame, the first included
		expect(player.playing).toBe(false);
	});

	it("stays at rest without a sequence, and stops on dispose", () => {
		const { clock, pending } = fakeClock();
		expect(new MascotPlayer(undefined, () => {}, clock).playing).toBe(false);
		const player = new MascotPlayer("look", () => {}, clock);
		expect(pending.size).toBe(1);
		player.dispose();
		expect(pending.size).toBe(0);
		expect(player.playing).toBe(false);
	});
});

describe("WelcomeHeader", () => {
	const header = (glyphs: "octant" | "halfblock") =>
		new WelcomeHeader(
			glyphs,
			new MascotPlayer(undefined, () => {}),
			() => info,
			(t) => t,
		);

	it("centers three text lines on the 4-line octant mascot, rounding half up like Yoga", () => {
		const lines = header("octant")
			.render(120)
			.map((line) => plain(line).trimEnd());
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe("   ▗▄▟█▙▄▖");
		expect(lines[1]).toBe(" ▄██▀███▀██▄  bluclawd v0.84.3");
		expect(lines[3]).toBe("   🮅𜴡𜴍 𜴡𜴍🮅    ~/Desktop/Project/bluclawd");
	});

	it("centers them on the 8-line half-block mascot too, and never exceeds the width", () => {
		const lines = header("halfblock").render(120).map(plain);
		expect(lines).toHaveLength(8);
		expect(lines.findIndex((line) => line.includes("bluclawd v"))).toBe(3);
		for (const width of [30, 20, 12]) {
			for (const line of header("octant").render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("clicking the mascot", () => {
	it("plays jump or look at once, without the entrance hold, and not while something is playing", () => {
		const { clock, tick } = fakeClock();
		const header = new WelcomeHeader(
			"octant",
			new MascotPlayer(undefined, () => {}, clock),
			() => info,
			(t) => t,
		);
		expect(CLICK_SEQUENCES).toEqual(["jump", "look"]);
		expect(header.click(() => 0)).toBe(true);
		const player = (header as unknown as { player: MascotPlayer }).player;
		expect(player.frame).toEqual(SEQUENCES.jump[0]);
		expect(header.click(() => 0.9)).toBe(false);
		while (tick());
		expect(header.click(() => 0.9)).toBe(true);
		expect(player.frame).toEqual(SEQUENCES.look[0]);
	});

	it("hits only the cells the mascot was drawn in", () => {
		const header = new WelcomeHeader(
			"octant",
			new MascotPlayer(undefined, () => {}),
			() => info,
			(t) => t,
		);
		header.render(120);
		expect(header.hitsMascot(0, 1)).toBe(true);
		expect(header.hitsMascot(3, 11)).toBe(true);
		expect(header.hitsMascot(0, 0)).toBe(false);
		expect(header.hitsMascot(1, 14)).toBe(false);
		expect(header.hitsMascot(4, 5)).toBe(false);
		expect(header.hitsMascot(-1, 5)).toBe(false);
	});

	it("reads SGR left presses only", () => {
		expect(parseLeftPress("\x1b[<0;6;3M")).toEqual({ x: 5, y: 2 });
		expect(parseLeftPress("\x1b[<0;6;3m")).toBeUndefined();
		expect(parseLeftPress("\x1b[<2;6;3M")).toBeUndefined();
		expect(parseLeftPress("\x1b[<32;6;3M")).toBeUndefined();
		expect(parseLeftPress("a")).toBeUndefined();
	});

	it("puts its listener ahead of the renderer's, and takes it out again", () => {
		const viewport = () => ({ consume: true });
		const ours = () => undefined;
		const tui = { inputListeners: new Set([viewport]) };
		expect(keepInputListenerFirst(tui, ours)).toBe(true);
		expect([...tui.inputListeners]).toEqual([ours, viewport]);
		expect(keepInputListenerFirst(tui, ours)).toBe(true);
		expect([...tui.inputListeners]).toEqual([ours, viewport]);
		removeInputListener(tui, ours);
		expect([...tui.inputListeners]).toEqual([viewport]);
		expect(keepInputListenerFirst({}, ours)).toBe(false);
	});

	it("still matches pi-tui: a private listener set the fullscreen renderer registers into first", () => {
		// If this fails after a pi update, keepInputListenerFirst no longer reaches clicks.
		const require = createRequire(import.meta.url);
		const dist = require.resolve("@earendil-works/pi-tui").replace(/index\.js$/, "");
		expect(readFileSync(`${dist}tui.js`, "utf8")).toContain("inputListeners = new Set()");
		expect(readFileSync(`${dist}tui-alt-screen.js`, "utf8")).toContain(
			"this.addInputListener((data) => this.handleViewportInput(data))",
		);
	});
});
