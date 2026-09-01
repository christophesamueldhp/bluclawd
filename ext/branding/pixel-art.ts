import { loadPhoton } from "../_shared/photon.ts";

/** Alpha values below this are treated as fully transparent. */
const ALPHA_THRESHOLD = 128;

/** Lower half block: the glyph's ink fills the bottom half of the cell. */
const HALF_BLOCK = "▄";

/** Upper half block: the glyph's ink fills the top half of the cell. */
const UPPER_HALF_BLOCK = "▀";

/** Repeat the named columns (0-based) once more, widening the buffer. */
function widenColumns(
	pixels: Uint8Array,
	width: number,
	height: number,
	columns: number[],
): { pixels: Uint8Array; width: number } {
	const outWidth = width + columns.length;
	const out = new Uint8Array(outWidth * height * 4);
	for (let y = 0; y < height; y++) {
		let outX = 0;
		for (let x = 0; x < width; x++) {
			const src = (y * width + x) * 4;
			const copies = columns.includes(x) ? 2 : 1;
			for (let i = 0; i < copies; i++) {
				out.set(pixels.subarray(src, src + 4), (y * outWidth + outX) * 4);
				outX++;
			}
		}
	}
	return { pixels: out, width: outWidth };
}

interface Rgb {
	r: number;
	g: number;
	b: number;
}

interface SampledPixel {
	color: Rgb;
	opaque: boolean;
}

function readPixel(pixels: Uint8Array, width: number, x: number, y: number): SampledPixel | null {
	const offset = (y * width + x) * 4;
	if (offset + 3 >= pixels.length) return null;
	const alpha = pixels[offset + 3] ?? 0;
	return {
		color: { r: pixels[offset] ?? 0, g: pixels[offset + 1] ?? 0, b: pixels[offset + 2] ?? 0 },
		opaque: alpha >= ALPHA_THRESHOLD,
	};
}

/**
 * Encode a raw RGBA pixel buffer as half-block Unicode + 24-bit ANSI art.
 * Each output line packs 2 source pixel rows: the bottom row becomes the
 * foreground color (the `▄` glyph's ink), the top row becomes the
 * background. A row with no pairing bottom row (odd height) is treated as
 * transparent for that half. A cell whose bottom half alone is transparent
 * uses `▀` with the top color as ink, so the transparent half always shows
 * the terminal's default background — never the default foreground color.
 * Cells where both halves are transparent render as a plain space, so the
 * mascot blends into whatever surrounds it instead of showing a stray
 * default-colored glyph.
 */
export function encodeHalfBlockRows(pixels: Uint8Array, width: number, height: number): string[] {
	const lines: string[] = [];
	for (let y = 0; y < height; y += 2) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const top = readPixel(pixels, width, x, y);
			const bottom = readPixel(pixels, width, x, y + 1);
			const topOpaque = top?.opaque ?? false;
			const bottomOpaque = bottom?.opaque ?? false;

			if (!topOpaque && !bottomOpaque) {
				line += " ";
				continue;
			}

			if (!bottomOpaque && top) {
				line += `\x1b[38;2;${top.color.r};${top.color.g};${top.color.b};49m${UPPER_HALF_BLOCK}\x1b[0m`;
				continue;
			}

			const fg = bottom ? `38;2;${bottom.color.r};${bottom.color.g};${bottom.color.b}` : "39";
			const bg = topOpaque && top ? `48;2;${top.color.r};${top.color.g};${top.color.b}` : "49";
			line += `\x1b[${fg};${bg}m${HALF_BLOCK}\x1b[0m`;
		}
		lines.push(line);
	}
	return lines;
}

/**
 * Decode a PNG and render it as half-block ANSI art at a fixed target width.
 * Uses the Nearest sampling filter so flat pixel-art colors stay crisp
 * instead of blending at edges. `doubleColumns` names sampled columns
 * (0-based, pre-doubling) to render twice: terminal cells are taller than
 * 2× their width, so art shown at its natural pixel height reads ~14% too
 * tall — doubling a few flat interior columns widens it back toward the
 * source's visual aspect ratio without resampling rows or resizing any
 * feature. Returns null on any failure (missing file bytes, corrupt image,
 * photon unavailable) so callers can silently omit the art rather than
 * crash or show a broken banner.
 */
export async function renderPixelArt(
	pngBytes: Uint8Array,
	targetWidthCells: number,
	doubleColumns: number[] = [],
): Promise<string[] | null> {
	const photon = await loadPhoton();
	if (!photon) return null;

	let decoded: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	let resized: ReturnType<typeof photon.resize> | undefined;
	try {
		decoded = photon.PhotonImage.new_from_byteslice(pngBytes);
		const originalWidth = decoded.get_width();
		const originalHeight = decoded.get_height();
		if (originalWidth <= 0 || originalHeight <= 0) return null;

		const targetWidthPx = Math.max(1, Math.round(targetWidthCells));
		const targetHeightPx = Math.max(1, Math.round((originalHeight / originalWidth) * targetWidthPx));

		resized = photon.resize(decoded, targetWidthPx, targetHeightPx, photon.SamplingFilter.Nearest);
		let pixels: Uint8Array = resized.get_raw_pixels();
		let width = targetWidthPx;
		if (doubleColumns.length > 0) {
			({ pixels, width } = widenColumns(pixels, targetWidthPx, targetHeightPx, doubleColumns));
		}
		return encodeHalfBlockRows(pixels, width, targetHeightPx);
	} catch {
		return null;
	} finally {
		resized?.free();
		decoded?.free();
	}
}
