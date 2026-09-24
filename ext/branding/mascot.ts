/**
 * The bluclawd mascot as a pixel grid, its poses, Claude Code's Clawd animation
 * sequences, and a renderer to terminal block glyphs.
 *
 * `mascot.svg` is the source: it embeds a 2000×1500 raster (a color image and a
 * luminance mask) that is pixel art on a 20×15 grid of 100 px blocks.
 * `SOURCE` below is that grid, and a test checks it against the SVG. Every pose
 * only moves parts of the grid — eyes, arms, the whole sprite — and never
 * resizes one, so the proportions of the SVG hold in every frame.
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

export type Pose = "default" | "look-left" | "look-right" | "arms-up";

const EYE_ROWS = [4, 5];
const EYE_COLUMNS = [5, 6, 13, 14];
const ARM_COLUMNS = [0, 1, 18, 19];
const ARM_ROWS = [6, 7, 8];

/** The 20×15 grid for a pose. */
export function poseGrid(pose: Pose): string[] {
	const grid = SOURCE.map((row) => row.split("") as Pixel[]);
	if (pose === "look-left" || pose === "look-right") {
		const shift = pose === "look-left" ? -1 : 1;
		for (const y of EYE_ROWS) for (const x of EYE_COLUMNS) grid[y]![x] = "#";
		for (const y of EYE_ROWS) for (const x of EYE_COLUMNS) grid[y]![x + shift] = "o";
	} else if (pose === "arms-up") {
		for (const x of ARM_COLUMNS) {
			for (const y of ARM_ROWS) grid[y]![x] = ".";
			for (const y of ARM_ROWS) grid[y - 1]![x] = "#";
		}
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

/** Widened grid width, and the canvas height: 15 rows plus a spare row the crouch drops into. */
const WIDTH = SOURCE[0]!.length + DOUBLED_COLUMNS.length;
const HEIGHT = 16;

/**
 * One animation frame, Claude Code's shape (m1353): `offset` is the crouch — the
 * sprite drops one pixel into the spare row instead of clipping its feet, so
 * the legs keep their length — `x` slides the sprite in Claude Code's units
 * (its Clawd is 9 cells wide), and `poof` is the landing dust.
 */
export interface MascotFrame {
	pose: Pose;
	offset: number;
	x?: number;
	poof?: "dot" | "wave";
}

export const REST: MascotFrame = { pose: "default", offset: 0 };

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

/** Claude Code's entrance sequences, frame for frame. */
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
} satisfies Record<string, MascotFrame[]>;

export type SequenceName = keyof typeof SEQUENCES;

/** What Claude Code picks from at random for the startup entrance. */
export const ENTRANCES: SequenceName[] = ["skip", "jump", "look", "spin"];

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

/** Cell width of a rendered frame. */
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
	const sprite = widen(poseGrid(frame.pose));
	const cellWidth = CELL[glyphs].w;
	const dx = Math.round(((frame.x ?? 0) / CLAWD_WIDTH) * mascotWidth(glyphs)) * cellWidth;
	const canvas: Pixel[][] = Array.from({ length: HEIGHT }, () => Array<Pixel>(WIDTH).fill("."));
	for (const [y, row] of sprite.entries()) {
		for (const [x, pixel] of [...row].entries()) {
			const cx = x + dx;
			const cy = y + frame.offset;
			if (cx >= 0 && cx < WIDTH && cy < HEIGHT) canvas[cy]![cx] = pixel as Pixel;
		}
	}
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
		// Claude Code centers the dust on the feet row, between the legs.
		const width = mascotWidth(glyphs);
		const center = Math.floor((width - 1) / 2);
		const last = lines.length - 1;
		const cells = splitCells(lines[last]!);
		cells[center] = dim(frame.poof === "dot" ? "·" : "~");
		lines[last] = cells.join("");
	}
	return lines;
}

/** One entry per cell of a rendered line (each cell is a styled glyph or a space). */
function splitCells(line: string): string[] {
	return line.match(/\x1b\[[0-9;]*m[^\x1b]\x1b\[0m|[^\x1b]/gu) ?? [];
}
