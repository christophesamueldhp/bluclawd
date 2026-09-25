/**
 * The startup header, Claude Code 2.1.282's `_s` (m1356): no box, just the
 * mascot beside three lines — bold name and dim version, dim model · billing,
 * dim cwd — centered on each other. In the fullscreen renderer the mascot plays
 * one of Claude Code's entrance sequences each time pi is launched.
 *
 * Claude Code's billing field (plan or provider) is the provider's display name
 * here, which reads the same for every provider.
 */
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	ENTRANCES,
	FRAME_MS,
	type Glyphs,
	type MascotFrame,
	mascotWidth,
	REST,
	renderMascot,
	SEQUENCES,
	type SequenceName,
	withHold,
} from "./mascot.ts";

/** Ink's `bold` and `dimColor`, which Claude Code draws the header with. */
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
const faint = (text: string) => `\x1b[2m${text}\x1b[22m`;

export interface WelcomeHeaderInfo {
	version: string;
	/** Model display name; the line is left out without one. */
	model?: string;
	/** Thinking level, when the model reasons and it is not off. */
	effort?: string;
	/** Provider display name, in Claude Code's billing slot. */
	provider?: string;
	/** `~`-abbreviated working directory. */
	cwd: string;
}

/** Plain-text truncation with a trailing `…` (pi-tui's adds SGR resets around it). */
function ellipsis(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	let out = "";
	for (const { segment } of new Intl.Segmenter().segment(text)) {
		if (visibleWidth(out + segment) > width - 1) break;
		out += segment;
	}
	return width > 0 ? `${out}…` : "";
}

/** Claude Code's path elider (`e_e`): keeps the first and last segments, then as many middle ones as fit. */
export function elidePath(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	const parts = path.split("/");
	const first = parts[0] || "";
	const last = parts.at(-1) || "";
	const lastWidth = visibleWidth(last);
	if (parts.length === 1) return ellipsis(path, width);
	if (first === "" && 2 + lastWidth >= width) return `/${ellipsis(last, Math.max(1, width - 1))}`;
	if (first !== "" && 3 + lastWidth >= width) return `…/${ellipsis(last, Math.max(1, width - 2))}`;
	if (parts.length === 2) return `${ellipsis(first, width - 2 - lastWidth)}…/${last}`;
	let room = width - visibleWidth(first) - lastWidth - 3;
	if (room <= 0) return `${ellipsis(first, Math.max(0, width - lastWidth - 3))}/…/${last}`;
	const middle: string[] = [];
	for (let i = parts.length - 2; i > 0; i--) {
		const part = parts[i]!;
		if (!part || visibleWidth(part) + 1 > room) break;
		middle.unshift(part);
		room -= visibleWidth(part) + 1;
	}
	return middle.length === 0 ? `${first}/…/${last}` : `${first}/…/${middle.join("/")}/${last}`;
}

/** The text column for a terminal `columns` wide, Claude Code's widths shifted by the mascot's extra cells. */
export function welcomeLines(info: WelcomeHeaderInfo, columns: number, mascotCells: number): string[] {
	// Claude Code: max(columns - 15, 20) for its 9-cell Clawd and 2-cell gap; the mascot's box
	// carries one blank cell of swing room, and the gap after it is one cell.
	const width = Math.max(columns - (mascotCells + 5), 20);
	const lines = [`${bold("bluclawd")} ${faint(`v${ellipsis(info.version, Math.max(width - 13, 6))}`)}`];
	if (info.model) {
		const model = info.effort ? `${info.model} with ${info.effort} effort` : info.model;
		const billing = info.provider ?? "";
		if (!billing) lines.push(faint(ellipsis(model, width)));
		else if (visibleWidth(model) + 3 + visibleWidth(billing) > width) {
			lines.push(faint(ellipsis(model, width)), faint(ellipsis(billing, width)));
		} else {
			lines.push(faint(`${ellipsis(model, Math.max(width - visibleWidth(billing) - 3, 10))} · ${billing}`));
		}
	}
	if (info.cwd) lines.push(faint(elidePath(info.cwd, Math.max(width, 10))));
	return lines;
}

/**
 * Claude Code's entrance rule (`fe`, m1353), minus its once-per-version limit:
 * only in the fullscreen renderer, not with reduced motion, and only for a launch
 * (not /new, /resume, /fork or /reload) — then a random pick of the entrances.
 */
export function pickEntrance(opts: {
	fullscreen: boolean;
	reducedMotion: boolean;
	startup: boolean;
	random?: () => number;
}): SequenceName | undefined {
	if (!opts.fullscreen || opts.reducedMotion || !opts.startup) return undefined;
	return ENTRANCES[Math.floor((opts.random ?? Math.random)() * ENTRANCES.length)];
}

export interface Clock {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Steps through a sequence once at Claude Code's frame rate, then rests on its last frame. */
export class MascotPlayer {
	private readonly frames: MascotFrame[];
	private readonly onFrame: () => void;
	private readonly clock: Clock;
	private index = 0;
	private timer: unknown;

	constructor(sequence: SequenceName | undefined, onFrame: () => void, clock: Clock = realClock) {
		this.onFrame = onFrame;
		this.clock = clock;
		// Claude Code's welcome passes delayMs: 100.
		this.frames = sequence ? withHold(SEQUENCES[sequence], 100) : [];
		if (this.frames.length > 0) this.schedule();
	}

	get frame(): MascotFrame {
		return this.frames[Math.min(this.index, this.frames.length - 1)] ?? REST;
	}

	get playing(): boolean {
		return this.timer !== undefined;
	}

	private schedule(): void {
		this.timer = this.clock.setTimeout(() => {
			this.index++;
			if (this.index < this.frames.length - 1) this.schedule();
			else this.timer = undefined;
			this.onFrame();
		}, FRAME_MS);
	}

	dispose(): void {
		if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
		this.timer = undefined;
	}
}

/** The header component: mascot and text, each centered on the taller of the two (Yoga rounds half up). */
export class WelcomeHeader implements Component {
	private readonly glyphs: Glyphs;
	private readonly player: MascotPlayer;
	private readonly getInfo: () => WelcomeHeaderInfo;
	private readonly dim: (text: string) => string;

	constructor(glyphs: Glyphs, player: MascotPlayer, getInfo: () => WelcomeHeaderInfo, dim: (text: string) => string) {
		this.glyphs = glyphs;
		this.player = player;
		this.getInfo = getInfo;
		this.dim = dim;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const cells = mascotWidth(this.glyphs);
		const mascot = renderMascot(this.player.frame, this.glyphs, this.dim);
		const text = welcomeLines(this.getInfo(), width, cells);
		const rows = Math.max(mascot.length, text.length);
		const mascotTop = Math.round((rows - mascot.length) / 2);
		const textTop = Math.round((rows - text.length) / 2);
		const lines: string[] = [];
		for (let i = 0; i < rows; i++) {
			const art = mascot[i - mascotTop] ?? " ".repeat(cells);
			lines.push(truncateToWidth(` ${art} ${text[i - textTop] ?? ""}`, width));
		}
		return lines;
	}

	dispose(): void {
		this.player.dispose();
	}
}
