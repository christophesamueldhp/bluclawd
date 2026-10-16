import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { qrMatrix, renderQr } from "../ext/remote/qr.ts";

/** CoreImage's CIQRCodeGenerator at level L, written by a Swift script as rows of 0/1 without the
 *  quiet zone, each code under a `# <text> <size>` line. */
function fixtures(): { text: string; rows: string[] }[] {
	const lines = readFileSync(join(import.meta.dirname, "fixtures", "qr-coreimage-l.txt"), "utf8").split("\n");
	const codes: { text: string; rows: string[] }[] = [];
	for (const [i, line] of lines.entries()) {
		if (!line.startsWith("# ")) continue;
		const size = Number(line.slice(line.lastIndexOf(" ") + 1));
		codes.push({ text: line.slice(2, line.lastIndexOf(" ")), rows: lines.slice(i + 1, i + 1 + size) });
	}
	return codes;
}

const rows = (matrix: boolean[][]) => matrix.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));

/** The 15 format bits, read from around the top-left finder and from the other two. */
function formatBits(matrix: boolean[][]): [number, number] {
	const size = matrix.length;
	const at = (x: number, y: number) => (matrix[y]![x] ? 1 : 0);
	let first = 0;
	let second = 0;
	const a = [...[0, 1, 2, 3, 4, 5, 7, 8].map((y) => [8, y]), ...[7, 5, 4, 3, 2, 1, 0].map((x) => [x, 8])];
	const b = [
		...Array.from({ length: 8 }, (_, i) => [size - 1 - i, 8]),
		...Array.from({ length: 7 }, (_, i) => [8, size - 7 + i]),
	];
	for (let i = 0; i < 15; i++) {
		first |= at(a[i]![0]!, a[i]![1]!) << i;
		second |= at(b[i]![0]!, b[i]![1]!) << i;
	}
	return [first, second];
}

/** The BCH check bits of `data`: the remainder of `data << degree` by the generator `poly`. */
function bch(data: number, poly: number, degree: number): number {
	let rem = data << degree;
	for (let bit = 31 - Math.clz32(rem); bit >= degree; bit--) if (rem & (1 << bit)) rem ^= poly << (bit - degree);
	return rem;
}

describe("QR code", () => {
	it("matches CoreImage's codes module for module, once both use the same mask", () => {
		const codes = fixtures();
		expect(codes.map((c) => c.rows.length)).toEqual([21, 33, 41, 45, 53, 57]);
		for (const { text, rows: expected } of codes) {
			// The mask CoreImage chose, from its format bits (level L is 01).
			const [format] = formatBits(expected.map((row) => [...row].map((c) => c === "1")));
			const mask = ((format ^ 0x5412) >> 10) & 7;
			expect(rows(qrMatrix(text, mask)), text).toEqual(expected);
		}
	});

	it("picks the smallest version that holds the text at level L, from 1 to 10", () => {
		// Byte-mode capacity at level L of versions 1 to 10.
		const capacity = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271];
		for (const [i, length] of capacity.entries()) {
			const version = i + 1;
			expect(qrMatrix("a".repeat(length)).length).toBe(17 + 4 * version);
			if (version < 10) expect(qrMatrix("a".repeat(length + 1)).length).toBe(21 + 4 * version);
		}
		expect(() => qrMatrix("a".repeat(272))).toThrow();
	});

	it("is well formed at every version: finders, timing, dark module, format and version bits", () => {
		const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
		for (const length of [17, 32, 53, 78, 106, 134, 154, 192, 230, 271]) {
			const matrix = qrMatrix("x".repeat(length));
			const size = matrix.length;
			const version = (size - 17) / 4;
			const block = (x: number, y: number) => rows(matrix.slice(y, y + 7).map((row) => row.slice(x, x + 7)));
			expect(block(0, 0)).toEqual(finder);
			expect(block(size - 7, 0)).toEqual(finder);
			expect(block(0, size - 7)).toEqual(finder);
			for (let i = 8; i < size - 8; i++) {
				expect(matrix[6]![i]).toBe(i % 2 === 0);
				expect(matrix[i]![6]).toBe(i % 2 === 0);
			}
			expect(matrix[size - 8]![8]).toBe(true);
			const [first, second] = formatBits(matrix);
			expect(second).toBe(first);
			const format = first ^ 0x5412;
			expect(format >> 13).toBe(1); // level L
			expect(bch(format >> 10, 0x537, 10)).toBe(format & 0x3ff);
			if (version < 7) continue;
			let bottomLeft = 0;
			let topRight = 0;
			for (let i = 0; i < 18; i++) {
				bottomLeft |= (matrix[size - 11 + (i % 3)]![Math.floor(i / 3)] ? 1 : 0) << i;
				topRight |= (matrix[Math.floor(i / 3)]![size - 11 + (i % 3)] ? 1 : 0) << i;
			}
			expect(topRight).toBe(bottomLeft);
			expect(bottomLeft >> 12).toBe(version);
			expect(bch(version, 0x1f25, 12)).toBe(bottomLeft & 0xfff);
		}
	});

	it("draws dark modules in the terminal's own foreground on its background, two rows to a line, inside a blank 2-module quiet zone", () => {
		const matrix = qrMatrix("https://mac.tail1234.ts.net/#pair=482913");
		const size = matrix.length;
		const lines = renderQr(matrix).split("\n");
		expect(lines).toHaveLength(Math.ceil((size + 4) / 2));
		// Only resets: undimmed, default foreground and background, so a dark terminal shows it inverted.
		const open = "\x1b[22;39;49m";
		const body = lines.map((line) => {
			expect(line.startsWith(open)).toBe(true);
			return line.slice(open.length);
		});
		expect(body.join("")).not.toContain("\x1b");
		expect(body.every((line) => [...line].length === size + 4)).toBe(true);
		expect(body[0]).toBe(" ".repeat(size + 4));
		// Rows 0 and 1 of the finder: all dark, then dark at both ends only.
		expect(body[1]!.slice(2, 9)).toBe("█▀▀▀▀▀█");
		const dark = (x: number, y: number) => matrix[y - 2]?.[x - 2] === true;
		for (const [line, text] of body.entries()) {
			[...text].forEach((char, x) => {
				const glyph = { "00": " ", "10": "▀", "01": "▄", "11": "█" }[
					`${dark(x, 2 * line) ? 1 : 0}${dark(x, 2 * line + 1) ? 1 : 0}`
				];
				expect(char).toBe(glyph);
			});
		}
	});

	it("keeps its lines and colours whole in pi's text, which wraps and dims a notification", () => {
		const qr = renderQr(qrMatrix("https://christophes-macbook-air.tailf9d726.ts.net/#pair=123456"));
		// As pi's showStatus: theme.fg("dim", message) in a Text with one column of padding.
		const shown = new Text(`\x1b[38;5;242m\x1b[2mabove\n${qr}\nbelow\x1b[22;39m`, 1, 0).render(80);
		for (const line of qr.split("\n")) expect(shown.some((rendered) => rendered.includes(line))).toBe(true);
	});
});
