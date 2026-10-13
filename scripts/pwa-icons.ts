// The phone app's icons, drawn from the mascot's pixel grid: `node scripts/pwa-icons.ts` writes
// them into daemon/remote/web/. test/remote-icons.test.ts checks the committed files against this.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { BODY_COLOR, EYE_COLOR, SOURCE } from "../ext/branding/mascot.ts";

/** The app's dark background: iOS fills a touch icon's transparency with black. */
const BACKGROUND = "#141414";
/** The mascot's width as a share of the icon's, in whole pixels per grid block so it stays crisp. */
const SCALE = 0.7;

export const ICONS: Record<string, number> = {
	"apple-touch-icon.png": 180,
	"icon-192.png": 192,
	"icon-512.png": 512,
	"favicon-32.png": 32,
};

function rgb(hex: string): number[] {
	return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

const COLORS: Record<string, number[]> = { ".": rgb(BACKGROUND), "#": rgb(BODY_COLOR), o: rgb(EYE_COLOR) };

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A `size`×`size` opaque RGB PNG: the mascot centred, each grid block a square of whole pixels. */
export function renderIcon(size: number): Buffer {
	const columns = SOURCE[0]!.length;
	const block = Math.max(1, Math.round((size * SCALE) / columns));
	const left = Math.floor((size - columns * block) / 2);
	const top = Math.floor((size - SOURCE.length * block) / 2);
	const raw = Buffer.alloc(size * (size * 3 + 1));
	for (let y = 0; y < size; y++) {
		// Each scanline starts with its filter type, 0: none.
		const row = y * (size * 3 + 1) + 1;
		for (let x = 0; x < size; x++) {
			const pixel = SOURCE[Math.floor((y - top) / block)]?.[Math.floor((x - left) / block)];
			raw.set(COLORS[pixel ?? "."]!, row + x * 3);
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	// 8-bit depth, colour type 2 (RGB), then default compression, filtering and no interlace.
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

export const WEB_DIR = join(import.meta.dirname, "..", "daemon", "remote", "web");

if (import.meta.url === `file://${process.argv[1]}`) {
	for (const [name, size] of Object.entries(ICONS)) writeFileSync(join(WEB_DIR, name), renderIcon(size));
}
