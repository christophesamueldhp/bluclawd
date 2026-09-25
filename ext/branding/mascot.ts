/**
 * The bluclawd mascot as a pixel grid, its poses, Claude Code's Clawd animation
 * sequences, and a renderer to terminal block glyphs.
 *
 * `mascot.svg` is the source: it embeds a 2000×1500 raster (a color image and a
 * luminance mask) that is pixel art on a 20×15 grid of 100 px blocks.
 * `SOURCE` below is that grid, and a test checks it against the SVG. Every pose
 * only moves parts of the grid — eyes, arms, the whole sprite — and never
 * resizes one, so the proportions of the SVG hold in every frame. Each move is
 * Claude Code's Clawd move scaled to this grid: its 1-px eye shifts by its own
 * width, its arm rises a quarter of the body's height, and its crouch drops the
 * sprite one row so the feet leave the clipped box.
 *
 * Terminal cells are ~2.3× taller than wide, so one grid pixel drawn as half a
 * cell reads ~14% too tall. Columns 2 and 17 are drawn twice to widen it back:
 * they are the only mirrored pair that is flat in every row, so no part changes
 * size (22×15, 1.28:1 against the source's 1.33:1).
 *
 * Two encodings with the same pixel aspect: octants (2×4 pixels per cell,
 * Unicode 16) give 11×4 cells, close to Claude Code's 9×3 Clawd; half blocks
 * (1×2 per cell) give 22×8 for terminals that lack octant glyphs.
 */

/** `.` transparent, `#` body, `o` eye. */
type Pixel = "." | "#" | "o";

export const SOURCE: readonly string[] = [
	"........####........",
	"........####........",
	"....############....",
	"....############....",
	"..###oo######oo###..",
	"..###oo######oo###..",
	"####################",
	"####################",
	"####################",
	"..################..",
	"..################..",
	"..################..",
	"...##.##....##.##...",
	"...##.##....##.##...",
	"...##.##....##.##...",
];

export const BODY_COLOR = "#00c0e8";
export const EYE_COLOR = "#1e1e1e";

export type Pose = "default" | "look-left" | "look-right" | "arms-up" | "wave";

const EYE_ROWS = [4, 5];
/** A full eye width, as Claude Code's look moves its 1-px eye by one pixel. */
const LOOK_SHIFT = 2;
/** A quarter of the body's 12 rows, as Claude Code raises its arm 1 of its 4 body pixels. */
const ARM_RAISE = 3;
const EYE_COLUMNS = [5, 6, 13, 14];
const ARM_COLUMNS = [0, 1, 18, 19];
const RIGHT_ARM_COLUMNS = [18, 19];
const ARM_ROWS = [6, 7, 8];

/** Move an arm's 2×3 block up by `rows`, unchanged in size. */
function raiseArm(grid: Pixel[][], columns: number[], rows: number): void {
	for (const x of columns) {
		for (const y of ARM_ROWS) grid[y]![x] = ".";
		for (const y of ARM_ROWS) grid[y - rows]![x] = "#";
	}
}

/** The 20×15 grid for a pose. */
export function poseGrid(pose: Pose, look?: "left" | "right"): string[] {
	const grid = SOURCE.map((row) => row.split("") as Pixel[]);
	const eyes = pose === "look-left" ? "left" : pose === "look-right" ? "right" : look;
	if (eyes) {
		const shift = eyes === "left" ? -LOOK_SHIFT : LOOK_SHIFT;
		for (const y of EYE_ROWS) for (const x of EYE_COLUMNS) grid[y]![x] = "#";
		for (const y of EYE_ROWS) for (const x of EYE_COLUMNS) grid[y]![x + shift] = "o";
	}
	if (pose === "arms-up") {
		raiseArm(grid, ARM_COLUMNS, ARM_RAISE);
	} else if (pose === "wave") {
		// The right arm leaves the grid; the frame's `arm` draws it wherever the wave has it.
		for (const x of RIGHT_ARM_COLUMNS) for (const y of ARM_ROWS) grid[y]![x] = ".";
	}
	return grid.map((row) => row.join(""));
}

export const DOUBLED_COLUMNS = [2, 17];

function widen(grid: string[]): string[] {
	return grid.map((row) =>
		row
			.split("")
			.map((pixel, x) => (DOUBLED_COLUMNS.includes(x) ? pixel + pixel : pixel))
			.join(""),
	);
}

/**
 * The widened art's width; the canvas adds one octant cell on the right for the
 * waving hand to swing into (the header's gap shrinks by one to match). Its
 * height is 15 rows plus a pad row that fills out the last octant line.
 */
const ART_WIDTH = SOURCE[0]!.length + DOUBLED_COLUMNS.length;
const WIDTH = ART_WIDTH + 2;
const HEIGHT = 16;

/**
 * One animation frame, Claude Code's shape (m1353): `offset` is the crouch in
 * rows — the sprite drops and its feet leave the clipped box; a quarter row is
 * a one-pixel bob — `x` slides the sprite in Claude Code's units (its Clawd is
 * 9 cells wide), and `poof` is the landing dust. `look` turns the eyes on top
 * of any pose (bluclawd's wave only).
 */
export interface MascotFrame {
	pose: Pose;
	offset: number;
	x?: number;
	poof?: "dot" | "wave";
	look?: "left" | "right";
	/** The raised right arm's pixels on the widened canvas (pose `wave` only). */
	arm?: readonly (readonly [number, number])[];
}

export const REST: MascotFrame = { pose: "default", offset: 0 };

/** One crouch row: an octant line, which is a third of the art as Claude Code's row is of its Clawd. */
const CROUCH_PIXELS = 4;

/** Claude Code's frame length. */
export const FRAME_MS = 60;

const CLAWD_WIDTH = 9;

function repeat(pose: Pose, offset: number, count: number, x?: number): MascotFrame[] {
	return Array.from({ length: count }, () => (x === undefined ? { pose, offset } : { pose, offset, x }));
}

function poof(x?: number): MascotFrame[] {
	return (["dot", "wave"] as const).map((dust) =>
		x === undefined ? { pose: "default", offset: 1, poof: dust } : { pose: "default", offset: 1, x, poof: dust },
	);
}

const jump = [
	...poof(),
	...repeat("arms-up", 0, 3),
	...repeat("default", 0, 1),
	...poof(),
	...repeat("arms-up", 0, 3),
	...repeat("default", 0, 1),
];

type ArmPixels = readonly (readonly [number, number])[];

/** A solid `w`×`h` block with its top-left pixel at `[x, y]` on the widened canvas. */
function block(x: number, y: number, w: number, h: number): ArmPixels {
	return Array.from({ length: w * h }, (_, i) => [x + (i % w), y + Math.floor(i / w)] as const);
}

/**
 * The raised right arm: always the arm's own solid 2×3 block (or the same
 * block turned on its side), so it stays as thick as the arm in mascot.svg, and
 * always joined to the body — column 19 is the body's edge from row 4 down.
 */
const ARM = {
	shoulder: block(20, 4, 2, 3),
	up: block(20, 2, 2, 3),
	// Standing on the shoulder, beside the head.
	in: block(18, 1, 2, 3),
	// Turned on its side, pointing out.
	out: block(20, 3, 3, 2),
} as const;

function armFrames(count: number, arm: keyof typeof ARM, look?: "right"): MascotFrame[] {
	return Array.from({ length: count }, () => ({
		pose: "wave" as const,
		offset: 0,
		arm: ARM[arm],
		...(look && { look }),
	}));
}

/** One swing: upright, out to the side, upright, in toward the head. */
const swing = [...armFrames(1, "up"), ...armFrames(2, "out"), ...armFrames(1, "up"), ...armFrames(2, "in")];

/**
 * bluclawd's own wave: the arm comes up in two steps while the eyes glance at
 * it, then the eyes turn back to you and the arm swings side to side three
 * times like a waving hand, and comes back down.
 */
const wave: MascotFrame[] = [
	...armFrames(2, "shoulder", "right"),
	...armFrames(2, "up", "right"),
	...swing,
	...swing,
	...swing,
	...armFrames(1, "up"),
	...armFrames(2, "shoulder"),
	...repeat("default", 0, 1),
];

/** Claude Code's entrance sequences, frame for frame, plus bluclawd's own wave. */
export const SEQUENCES = {
	jump,
	look: [...repeat("look-right", 0, 5), ...repeat("look-left", 0, 5), ...repeat("default", 0, 1)],
	spin: [
		...repeat("look-left", 0, 2),
		...repeat("look-right", 0, 2),
		...repeat("look-left", 0, 2),
		...repeat("arms-up", 0, 3),
		...repeat("default", 0, 1),
	],
	skip: [
		...repeat("default", 1, 1, -CLAWD_WIDTH),
		...repeat("arms-up", 0, 2, -6),
		...repeat("default", 0, 1, -6),
		...repeat("default", 1, 1, -6),
		...repeat("arms-up", 0, 2, -3),
		...repeat("default", 0, 1, -3),
		...repeat("default", 1, 1, -3),
		...repeat("arms-up", 0, 2, 0),
		...poof(0),
		...repeat("default", 0, 1, 0),
	],
	/** Not Claude Code's; see `wave` above. */
	wave,
} satisfies Record<string, MascotFrame[]>;

export type SequenceName = keyof typeof SEQUENCES;

/** What the startup entrance picks from at random: Claude Code's four, plus the wave. */
export const ENTRANCES: SequenceName[] = ["skip", "jump", "look", "spin", "wave"];

/** Claude Code's `delayMs` hold, in rest frames, ahead of a sequence. */
export function withHold(frames: MascotFrame[], delayMs: number): MascotFrame[] {
	return [...repeat("default", 0, Math.round(delayMs / FRAME_MS)), ...frames];
}

export type Glyphs = "octant" | "halfblock";

/** Octants everywhere except terminals known to lack them (Claude Code branches on Apple Terminal too). */
export function mascotGlyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
	return env.TERM_PROGRAM === "Apple_Terminal" || env.TERM === "linux" ? "halfblock" : "octant";
}

const CELL = { octant: { w: 2, h: 4 }, halfblock: { w: 1, h: 2 } } as const;

/** Cell width of a rendered frame, the hand's swing room included. */
export function mascotWidth(glyphs: Glyphs): number {
	return WIDTH / CELL[glyphs].w;
}

/**
 * Octant patterns (bit n = octant n+1, numbered left to right, top to bottom)
 * that Unicode encodes outside U+1CD00–1CDE5 because an older block glyph
 * already draws them. The rest take U+1CD00 onwards in ascending order.
 */
const OCTANT_ELSEWHERE = new Map<number, number>([
	[0b00000000, 0x20],
	[0b00000001, 0x1cea8],
	[0b00000010, 0x1ceab],
	[0b00000011, 0x1fb82],
	[0b00000101, 0x2598],
	[0b00001010, 0x259d],
	[0b00001111, 0x2580],
	[0b00010100, 0x1fbe6],
	[0b00101000, 0x1fbe7],
	[0b00111111, 0x1fb85],
	[0b01000000, 0x1cea3],
	[0b01010000, 0x2596],
	[0b01010101, 0x258c],
	[0b01011010, 0x259e],
	[0b01011111, 0x259b],
	[0b10000000, 0x1cea0],
	[0b10100000, 0x2597],
	[0b10100101, 0x259a],
	[0b10101010, 0x2590],
	[0b10101111, 0x259c],
	[0b11000000, 0x2582],
	[0b11110000, 0x2584],
	[0b11110101, 0x2599],
	[0b11111010, 0x259f],
	[0b11111100, 0x2586],
	[0b11111111, 0x2588],
]);

const OCTANTS: string[] = (() => {
	const table: string[] = [];
	let next = 0x1cd00;
	for (let mask = 0; mask < 256; mask++) {
		table.push(String.fromCodePoint(OCTANT_ELSEWHERE.get(mask) ?? next++));
	}
	return table;
})();

const HALF_BLOCKS = [" ", "▀", "▄", "█"];

/** The glyph whose ink covers `mask` (octant bits, or bit 0 top / bit 1 bottom for half blocks). */
export function glyphFor(glyphs: Glyphs, mask: number): string {
	return glyphs === "octant" ? OCTANTS[mask]! : HALF_BLOCKS[mask]!;
}

function rgb(hex: string): string {
	return `${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}`;
}

const COLOR: Record<Exclude<Pixel, ".">, string> = { "#": rgb(BODY_COLOR), o: rgb(EYE_COLOR) };

/** The frame as a canvas of pixels, sprite placed by its crouch and slide. */
export function frameCanvas(frame: MascotFrame, glyphs: Glyphs): Pixel[][] {
	const sprite = widen(poseGrid(frame.pose, frame.look));
	const cellWidth = CELL[glyphs].w;
	const dx = Math.round(((frame.x ?? 0) / CLAWD_WIDTH) * (ART_WIDTH / cellWidth)) * cellWidth;
	const dy = Math.round(frame.offset * CROUCH_PIXELS);
	const canvas: Pixel[][] = Array.from({ length: HEIGHT }, () => Array<Pixel>(WIDTH).fill("."));
	const put = (x: number, y: number, pixel: Pixel) => {
		if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && pixel !== ".") canvas[y]![x] = pixel;
	};
	for (const [y, row] of sprite.entries()) {
		for (const [x, pixel] of [...row].entries()) put(x + dx, y + dy, pixel as Pixel);
	}
	for (const [x, y] of frame.arm ?? []) put(x + dx, y + dy, "#");
	return canvas;
}

/** The distinct pixel values in each cell, for the two-colors-per-cell check. */
export function cellValues(canvas: Pixel[][], glyphs: Glyphs): Set<Pixel>[][] {
	const { w, h } = CELL[glyphs];
	const rows: Set<Pixel>[][] = [];
	for (let cy = 0; cy < HEIGHT / h; cy++) {
		const row: Set<Pixel>[] = [];
		for (let cx = 0; cx < WIDTH / w; cx++) {
			const values = new Set<Pixel>();
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values.add(canvas[cy * h + y]![cx * w + x]!);
			row.push(values);
		}
		rows.push(row);
	}
	return rows;
}

/**
 * ANSI lines for one frame: every line is exactly `mascotWidth(glyphs)` cells.
 * A cell draws one color as the glyph's ink and the other as its background;
 * transparent pixels leave the terminal background. `dim` styles the dust.
 */
export function renderMascot(frame: MascotFrame, glyphs: Glyphs, dim: (text: string) => string = (t) => t): string[] {
	const canvas = frameCanvas(frame, glyphs);
	const { w, h } = CELL[glyphs];
	const lines: string[] = [];
	for (let cy = 0; cy < HEIGHT / h; cy++) {
		let line = "";
		for (let cx = 0; cx < WIDTH / w; cx++) {
			const pixels: Pixel[] = [];
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push(canvas[cy * h + y]![cx * w + x]!);
			// The eye is the ink when present, so the body fills in behind it.
			const ink: Pixel = pixels.includes("o") ? "o" : "#";
			const mask = pixels.reduce((bits, pixel, bit) => (pixel === ink ? bits | (1 << bit) : bits), 0);
			if (mask === 0) {
				line += " ";
				continue;
			}
			const back = ink === "o" && pixels.includes("#") ? `48;2;${COLOR["#"]}` : "49";
			line += `\x1b[38;2;${COLOR[ink]};${back}m${glyphFor(glyphs, mask)}\x1b[0m`;
		}
		lines.push(line);
	}
	if (frame.poof && frame.offset > 0) {
		// Claude Code puffs the dust at both edges of the bottom row, over the crouched arms.
		const last = lines.length - 1;
		const cells = splitCells(lines[last]!);
		const dust = dim(frame.poof === "dot" ? "·" : "~");
		cells[0] = dust;
		cells[ART_WIDTH / CELL[glyphs].w - 1] = dust;
		lines[last] = cells.join("");
	}
	return lines;
}

/** One entry per cell of a rendered line (each cell is a styled glyph or a space). */
function splitCells(line: string): string[] {
	return line.match(/\x1b\[[0-9;]*m[^\x1b]\x1b\[0m|[^\x1b]/gu) ?? [];
}
