import { backgroundAnsi, foregroundAnsi, parseColor } from "@earendil-works/pi-tui";

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
const LEFT_EYE_COLUMNS = [5, 6];
const RIGHT_EYE_COLUMNS = [13, 14];
const EYE_COLUMNS = [...LEFT_EYE_COLUMNS, ...RIGHT_EYE_COLUMNS];
const LOOK_SHIFT = LEFT_EYE_COLUMNS.length;
const BODY_ROWS = 12;
const ARM_RAISE = BODY_ROWS / 4;
const ARM_COLUMNS = [0, 1, 18, 19];
const RIGHT_ARM_COLUMNS = [18, 19];
const ARM_ROWS = [6, 7, 8];

function removeRightArm(grid: Pixel[][]): void {
	for (const x of RIGHT_ARM_COLUMNS) for (const y of ARM_ROWS) grid[y]![x] = ".";
}

function raiseArm(grid: Pixel[][], columns: number[], rows: number): void {
	for (const x of columns) {
		for (const y of ARM_ROWS) grid[y]![x] = ".";
		for (const y of ARM_ROWS) grid[y - rows]![x] = "#";
	}
}

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
		removeRightArm(grid);
	}
	return grid.map((row) => row.join(""));
}

const COLUMNS_WIDENED_FOR_CELL_ASPECT = [2, 17];

function widen(grid: string[]): string[] {
	return grid.map((row) =>
		row
			.split("")
			.map((pixel, x) => (COLUMNS_WIDENED_FOR_CELL_ASPECT.includes(x) ? pixel + pixel : pixel))
			.join(""),
	);
}

const CELL = { octant: { w: 2, h: 4 }, halfblock: { w: 1, h: 2 } } as const;

const ART_WIDTH = SOURCE[0]!.length + COLUMNS_WIDENED_FOR_CELL_ASPECT.length;
const SWING_ROOM = CELL.octant.w;
const WIDTH = ART_WIDTH + SWING_ROOM;
const PAD_ROW = 1;
const HEIGHT = SOURCE.length + PAD_ROW;

export interface MascotFrame {
	pose: Pose;
	crouchRows: number;
	x?: number;
	poof?: "dot" | "wave";
	look?: "left" | "right";
	arm?: readonly (readonly [number, number])[];
}

export const REST: MascotFrame = { pose: "default", crouchRows: 0 };

const CROUCH_PIXELS = CELL.octant.h;

export const FRAME_MS = 60;

const CLAWD_WIDTH = 9;

function repeat(pose: Pose, crouchRows: number, count: number, x?: number): MascotFrame[] {
	return Array.from({ length: count }, () => (x === undefined ? { pose, crouchRows } : { pose, crouchRows, x }));
}

function poof(x?: number): MascotFrame[] {
	return (["dot", "wave"] as const).map((dust) =>
		x === undefined
			? { pose: "default", crouchRows: 1, poof: dust }
			: { pose: "default", crouchRows: 1, x, poof: dust },
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

function block(x: number, y: number, w: number, h: number): ArmPixels {
	return Array.from({ length: w * h }, (_, i) => [x + (i % w), y + Math.floor(i / w)] as const);
}

const ARM = {
	shoulder: block(20, 4, 2, 3),
	up: block(20, 2, 2, 3),
	in: block(18, 1, 2, 3),
	out: block(20, 3, 3, 2),
} as const;

function armFrames(count: number, arm: keyof typeof ARM, look?: "right"): MascotFrame[] {
	return Array.from({ length: count }, () => ({
		pose: "wave" as const,
		crouchRows: 0,
		arm: ARM[arm],
		...(look && { look }),
	}));
}

const swing = [...armFrames(1, "up"), ...armFrames(2, "out"), ...armFrames(1, "up"), ...armFrames(2, "in")];

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
	wave,
} satisfies Record<string, MascotFrame[]>;

export type SequenceName = keyof typeof SEQUENCES;

export const ENTRANCES: SequenceName[] = ["skip", "jump", "look", "spin", "wave"];

export function withHold(frames: MascotFrame[], delayMs: number): MascotFrame[] {
	return [...repeat("default", 0, Math.round(delayMs / FRAME_MS)), ...frames];
}

export type Glyphs = "octant" | "halfblock";

export function mascotGlyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
	return env.TERM_PROGRAM === "Apple_Terminal" || env.TERM === "linux" ? "halfblock" : "octant";
}

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

export function glyphFor(glyphs: Glyphs, mask: number): string {
	return glyphs === "octant" ? OCTANTS[mask]! : HALF_BLOCKS[mask]!;
}

const INK: Record<Exclude<Pixel, ".">, string> = {
	"#": foregroundAnsi(parseColor(BODY_COLOR), "truecolor"),
	o: foregroundAnsi(parseColor(EYE_COLOR), "truecolor"),
};
const BODY_BACK = backgroundAnsi(parseColor(BODY_COLOR), "truecolor");

export function frameCanvas(frame: MascotFrame, glyphs: Glyphs): Pixel[][] {
	const sprite = widen(poseGrid(frame.pose, frame.look));
	const cellWidth = CELL[glyphs].w;
	const dx = Math.round(((frame.x ?? 0) / CLAWD_WIDTH) * (ART_WIDTH / cellWidth)) * cellWidth;
	const dy = Math.round(frame.crouchRows * CROUCH_PIXELS);
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

export function renderMascot(frame: MascotFrame, glyphs: Glyphs, dim: (text: string) => string = (t) => t): string[] {
	const canvas = frameCanvas(frame, glyphs);
	const { w, h } = CELL[glyphs];
	const lines: string[] = [];
	for (let cy = 0; cy < HEIGHT / h; cy++) {
		let line = "";
		for (let cx = 0; cx < WIDTH / w; cx++) {
			const pixels: Pixel[] = [];
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push(canvas[cy * h + y]![cx * w + x]!);
			const ink: Pixel = pixels.includes("o") ? "o" : "#";
			const mask = pixels.reduce((bits, pixel, bit) => (pixel === ink ? bits | (1 << bit) : bits), 0);
			if (mask === 0) {
				line += " ";
				continue;
			}
			const back = ink === "o" && pixels.includes("#") ? BODY_BACK : "\x1b[49m";
			line += `${INK[ink]}${back}${glyphFor(glyphs, mask)}\x1b[0m`;
		}
		lines.push(line);
	}
	if (frame.poof && frame.crouchRows > 0) {
		const last = lines.length - 1;
		const cells = splitCells(lines[last]!);
		const dust = dim(frame.poof === "dot" ? "·" : "~");
		cells[0] = dust;
		cells[ART_WIDTH / CELL[glyphs].w - 1] = dust;
		lines[last] = cells.join("");
	}
	return lines;
}

function splitCells(line: string): string[] {
	return line.match(/(?:\x1b\[[0-9;]*m)+[^\x1b]\x1b\[0m|[^\x1b]/gu) ?? [];
}
