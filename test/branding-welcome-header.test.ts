import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { FRAME_MS, SEQUENCES } from "../ext/branding/mascot.ts";
import {
	type Clock,
	elidePath,
	MascotPlayer,
	pickEntrance,
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
		const lines = welcomeLines(info, 120, 12);
		expect(lines.map(plain)).toEqual([
			"bluclawd v0.84.3",
			"Kimi K2.6 with high effort · OpenCode Go",
			"~/Desktop/Project/bluclawd",
		]);
		expect(lines[0]).toBe("\x1b[1mbluclawd\x1b[22m \x1b[2mv0.84.3\x1b[22m");
		expect(lines[1]!.startsWith("\x1b[2m")).toBe(true);
	});

	it("splits model and billing when they do not fit on one line, then elides the cwd", () => {
		// width = max(50 - 17, 20) = 33 < 26 + 3 + 11 (a 12-cell mascot box, then a 1-cell gap)
		const lines = welcomeLines(info, 50, 12).map(plain);
		expect(lines).toEqual([
			"bluclawd v0.84.3",
			"Kimi K2.6 with high effort",
			"OpenCode Go",
			"~/Desktop/Project/bluclawd",
		]);
		expect(
			welcomeLines({ ...info, cwd: "~/a/very/long/path/to/some/deep/project" }, 30, 12)
				.map(plain)
				.at(-1),
		).toBe("~/…/deep/project");
	});

	it("leaves out the effort without a thinking level and the model line without a model", () => {
		expect(welcomeLines({ ...info, effort: undefined }, 120, 12).map(plain)[1]).toBe("Kimi K2.6 · OpenCode Go");
		expect(welcomeLines({ ...info, model: undefined }, 120, 12).map(plain)).toEqual([
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
	const base = { fullscreen: true, reducedMotion: false, startup: true, random: () => 0 };

	it("plays on every launch from the terminal, in the fullscreen renderer, without reduced motion", () => {
		expect(pickEntrance(base)).toBe("skip");
		expect(pickEntrance({ ...base, startup: false })).toBeUndefined();
		expect(pickEntrance({ ...base, fullscreen: false })).toBeUndefined();
		expect(pickEntrance({ ...base, reducedMotion: true })).toBeUndefined();
	});

	it("picks among skip, jump, look, spin and wave", () => {
		const picks = [0, 0.2, 0.4, 0.6, 0.8].map((r) => pickEntrance({ ...base, random: () => r }));
		expect(picks).toEqual(["skip", "jump", "look", "spin", "wave"]);
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
		expect(renders).toBe(seen.length - 1);
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
