import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { loadPhoton } from "../ext/_shared/photon.ts";
import {
	BODY_COLOR,
	cellValues,
	EYE_COLOR,
	frameCanvas,
	type Glyphs,
	glyphFor,
	type MascotFrame,
	mascotGlyphs,
	mascotWidth,
	type Pose,
	poseGrid,
	REST,
	renderMascot,
	SEQUENCES,
	SOURCE,
	withHold,
} from "../ext/branding/mascot.ts";

const POSES: Pose[] = ["default", "look-left", "look-right", "arms-up"];
const GLYPHS: Glyphs[] = ["octant", "halfblock"];
const ALL_FRAMES: MascotFrame[] = [REST, ...Object.values(SEQUENCES).flat()];

function hex(r: number, g: number, b: number): string {
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** 4-connected components of one pixel value, as bounding-box sizes `w×h` (all components are rectangles here). */
function components(grid: readonly string[], value: string): string[] {
	const seen = new Set<string>();
	const sizes: string[] = [];
	for (let y = 0; y < grid.length; y++) {
		for (let x = 0; x < grid[y]!.length; x++) {
			if (grid[y]![x] !== value || seen.has(`${x},${y}`)) continue;
			const stack = [[x, y]];
			let [minX, maxX, minY, maxY, count] = [x, x, y, y, 0];
			while (stack.length > 0) {
				const [cx, cy] = stack.pop()!;
				if (grid[cy!]?.[cx!] !== value || seen.has(`${cx},${cy}`)) continue;
				seen.add(`${cx},${cy}`);
				count++;
				[minX, maxX, minY, maxY] = [
					Math.min(minX, cx!),
					Math.max(maxX, cx!),
					Math.min(minY, cy!),
					Math.max(maxY, cy!),
				];
				stack.push([cx! + 1, cy!], [cx! - 1, cy!], [cx!, cy! + 1], [cx!, cy! - 1]);
			}
			const w = maxX - minX + 1;
			const h = maxY - minY + 1;
			expect(count).toBe(w * h);
			sizes.push(`${w}×${h}`);
		}
	}
	return sizes;
}

/** Leg runs: opaque runs in the last three rows. */
function legs(grid: readonly string[]): number[][] {
	return grid.slice(-3).map((row) => (row.match(/#+/g) ?? []).map((run: string) => run.length));
}

/** Height of each arm: the rows where the grid is opaque at its outer columns. */
function arms(grid: readonly string[]): number[] {
	const last = grid[0]!.length - 1;
	return [0, last].map((x) => grid.filter((row) => row[x] !== ".").length);
}

describe("mascot source", () => {
	it("is the grid mascot.svg draws, pixel for pixel", async () => {
		const svg = readFileSync(new URL("../ext/branding/mascot.svg", import.meta.url), "utf8");
		const [mask, color] = [...svg.matchAll(/base64,([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1]!, "base64"));
		const photon = await loadPhoton();
		if (!photon) throw new Error("photon unavailable");
		const decode = (bytes: Buffer) => {
			const image = photon.PhotonImage.new_from_byteslice(bytes);
			try {
				return { width: image.get_width(), pixels: image.get_raw_pixels() };
			} finally {
				image.free();
			}
		};
		const maskImage = decode(mask!);
		const colorImage = decode(color!);
		const block = 100;
		const grid: string[] = [];
		const colors = new Set<string>();
		for (let y = 0; y < 15; y++) {
			let row = "";
			for (let x = 0; x < 20; x++) {
				const at = ((y * block + block / 2) * maskImage.width + x * block + block / 2) * 4;
				if ((maskImage.pixels[at] ?? 0) < 128) {
					row += ".";
					continue;
				}
				const c = hex(colorImage.pixels[at]!, colorImage.pixels[at + 1]!, colorImage.pixels[at + 2]!);
				colors.add(c);
				row += c === EYE_COLOR ? "o" : c === BODY_COLOR ? "#" : "?";
			}
			grid.push(row);
		}
		expect(grid).toEqual(SOURCE);
		expect([...colors].sort()).toEqual([EYE_COLOR, BODY_COLOR].sort());
	});
});

describe("poses", () => {
	it.each(POSES)("%s keeps every part at its source size, before and after widening", (pose) => {
		const source = { eyes: components(SOURCE, "o"), legs: legs(SOURCE), arms: arms(SOURCE) };
		expect(source).toEqual({
			eyes: ["2×2", "2×2"],
			legs: [
				[2, 2, 2, 2],
				[2, 2, 2, 2],
				[2, 2, 2, 2],
			],
			arms: [3, 3],
		});
		const grid = poseGrid(pose);
		const opaque = (g: readonly string[]) => g.join("").replace(/\./g, "").length;
		expect(opaque(grid)).toBe(opaque(SOURCE));
		for (const g of [
			grid as readonly string[],
			frameCanvas({ pose, offset: 0 }, "octant").map((row) => row.join("")),
		]) {
			expect(components(g, "o")).toEqual(source.eyes);
			expect(legs(g.slice(0, 15))).toEqual(source.legs);
			expect(arms(g)).toEqual(source.arms);
		}
	});

	it("moves only what the pose names", () => {
		expect(poseGrid("default")).toEqual(SOURCE);
		expect(poseGrid("look-left")[4]).toBe("..##oo######oo####..");
		expect(poseGrid("look-right")[4]).toBe("..####oo######oo##..");
		const up = poseGrid("arms-up");
		expect(up.map((row) => row[0])).toEqual([...".....###......."]);
		expect(up.slice(9)).toEqual(SOURCE.slice(9));
	});
});

describe("sequences", () => {
	it("port Claude Code's frame counts and end at rest", () => {
		expect(Object.fromEntries(Object.entries(SEQUENCES).map(([name, frames]) => [name, frames.length]))).toEqual({
			jump: 12,
			look: 11,
			spin: 10,
			skip: 14,
		});
		for (const frames of Object.values(SEQUENCES)) {
			const last = frames.at(-1)!;
			expect([last.pose, last.offset, last.x ?? 0]).toEqual(["default", 0, 0]);
		}
		expect(withHold(SEQUENCES.jump, 100)).toHaveLength(14);
	});
});

describe("renderMascot", () => {
	it.each(GLYPHS)("%s: every cell of every frame needs at most two colors", (glyphs) => {
		for (const frame of ALL_FRAMES) {
			for (const row of cellValues(frameCanvas(frame, glyphs), glyphs)) {
				for (const values of row) expect(values.size).toBeLessThanOrEqual(2);
			}
		}
	});

	it("draws 11×4 octants or 22×8 half blocks", () => {
		expect(mascotWidth("octant")).toBe(11);
		expect(mascotWidth("halfblock")).toBe(22);
		for (const glyphs of GLYPHS) {
			for (const frame of ALL_FRAMES) {
				const lines = renderMascot(frame, glyphs);
				expect(lines).toHaveLength(glyphs === "octant" ? 4 : 8);
				for (const line of lines) expect(visibleWidth(line)).toBe(mascotWidth(glyphs));
			}
		}
	});

	it.each(GLYPHS)("%s decodes back to the frame's pixels", (glyphs) => {
		const [w, h] = glyphs === "octant" ? [2, 4] : [1, 2];
		const inverse = new Map(Array.from({ length: 1 << (w * h) }, (_, mask) => [glyphFor(glyphs, mask), mask]));
		const toPixel = (rgb: string | undefined) =>
			rgb === undefined
				? "."
				: hex(...(rgb.split(";").map(Number) as [number, number, number])) === EYE_COLOR
					? "o"
					: "#";
		for (const frame of ALL_FRAMES.filter((f) => !f.poof)) {
			const decoded = Array.from({ length: 16 }, () => Array<string>(22).fill("."));
			for (const [cy, line] of renderMascot(frame, glyphs).entries()) {
				const cells = line.match(/\x1b\[38;2;([\d;]+?);(?:48;2;([\d;]+)|49)m(.)\x1b\[0m|(.)/gu)!;
				for (const [cx, cell] of cells.entries()) {
					const m = /\x1b\[38;2;(\d+;\d+;\d+);(?:48;2;(\d+;\d+;\d+)|49)m(.)\x1b\[0m/u.exec(cell);
					const mask = m ? inverse.get(m[3]!)! : 0;
					for (let bit = 0; bit < w * h; bit++) {
						const on = (mask >> bit) & 1;
						const pixel = on ? toPixel(m![1]) : toPixel(m?.[2]);
						decoded[cy * h + Math.floor(bit / w)]![cx * w + (bit % w)] = pixel;
					}
				}
			}
			expect(decoded).toEqual(frameCanvas(frame, glyphs));
		}
	});

	it("uses Unicode 16's octant code points", () => {
		expect(glyphFor("octant", 0b100)).toBe("\u{1CD00}");
		expect(glyphFor("octant", 0b111)).toBe("\u{1CD02}");
		expect(glyphFor("octant", 0b11111110)).toBe("\u{1CDE5}");
		expect(glyphFor("octant", 0b1111)).toBe("▀");
		expect(new Set(Array.from({ length: 256 }, (_, mask) => glyphFor("octant", mask))).size).toBe(256);
	});

	it("puts the landing dust between the legs", () => {
		const [dot] = SEQUENCES.jump;
		expect(dot?.poof).toBe("dot");
		expect(renderMascot(dot!, "octant", (t) => `<${t}>`).at(-1)).toContain("<·>");
	});
});

describe("mascotGlyphs", () => {
	it("falls back to half blocks only where octants are known to be missing", () => {
		expect(mascotGlyphs({ TERM_PROGRAM: "ghostty" })).toBe("octant");
		expect(mascotGlyphs({ TERM_PROGRAM: "tmux" })).toBe("octant");
		expect(mascotGlyphs({ TERM_PROGRAM: "Apple_Terminal" })).toBe("halfblock");
		expect(mascotGlyphs({ TERM: "linux" })).toBe("halfblock");
	});
});
