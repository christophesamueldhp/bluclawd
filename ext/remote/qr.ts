/**
 * A QR code for `/remote-control`'s pairing link, drawn in the terminal: byte mode, error
 * correction level M, versions 1 to 10 (up to 213 bytes, plenty for a ts.net link).
 */

/** Per version at level M: error correction codewords per block, and the number of blocks. */
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Level M's two format bits. */
const LEVEL_M = 0;

/** Product in GF(256) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

/** The Reed–Solomon generator polynomial of `degree`, its leading 1 left out. */
function generator(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			result[j] = multiply(result[j]!, root);
			if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
		}
		root = multiply(root, 2);
	}
	return result;
}

function errorCorrection(data: number[], divisor: number[]): number[] {
	const result = new Array<number>(divisor.length).fill(0);
	for (const byte of data) {
		const factor = byte ^ result.shift()!;
		result.push(0);
		divisor.forEach((coefficient, i) => {
			result[i]! ^= multiply(coefficient, factor);
		});
	}
	return result;
}

/** Modules left for data and error correction once the function patterns are drawn. */
function rawModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const alignments = Math.floor(version / 7) + 2;
		result -= (25 * alignments - 10) * alignments - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

function dataCodewords(version: number): number {
	return Math.floor(rawModules(version) / 8) - EC_PER_BLOCK[version - 1]! * BLOCKS[version - 1]!;
}

function alignmentPositions(version: number): number[] {
	if (version === 1) return [];
	const count = Math.floor(version / 7) + 2;
	const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
	const result = [6];
	for (let position = version * 4 + 10; result.length < count; position -= step) result.splice(1, 0, position);
	return result;
}

/** The BCH check bits of `data`: the remainder of `data << degree` by the generator `poly`. */
function bch(data: number, poly: number, degree: number): number {
	let rem = data << degree;
	for (let bit = 31 - Math.clz32(rem); bit >= degree; bit--) if (rem & (1 << bit)) rem ^= poly << (bit - degree);
	return rem;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
	(x, y) => (x + y) % 2 === 0,
	(_x, y) => y % 2 === 0,
	(x) => x % 3 === 0,
	(x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
	(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
	(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Data codewords followed by their error correction, interleaved block by block. */
function codewords(bytes: Uint8Array, version: number): number[] {
	const capacity = dataCodewords(version);
	const bits: number[] = [];
	const append = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	append(0b0100, 4);
	append(bytes.length, version < 10 ? 8 : 16);
	for (const byte of bytes) append(byte, 8);
	append(0, Math.min(4, capacity * 8 - bits.length));
	append(0, (8 - (bits.length % 8)) % 8);
	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
	for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

	const blockCount = BLOCKS[version - 1]!;
	const ecLength = EC_PER_BLOCK[version - 1]!;
	const total = Math.floor(rawModules(version) / 8);
	const shortBlocks = blockCount - (total % blockCount);
	const shortLength = Math.floor(total / blockCount);
	const divisor = generator(ecLength);
	const blocks: number[][] = [];
	for (let i = 0, k = 0; i < blockCount; i++) {
		const block = data.slice(k, k + shortLength - ecLength + (i < shortBlocks ? 0 : 1));
		k += block.length;
		const ec = errorCorrection(block, divisor);
		// A placeholder evens out the short blocks; it is skipped below.
		if (i < shortBlocks) block.push(0);
		blocks.push([...block, ...ec]);
	}
	const result: number[] = [];
	for (let i = 0; i < blocks[0]!.length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortLength - ecLength || j >= shortBlocks) result.push(block[i]!);
		});
	}
	return result;
}

class Grid {
	readonly size: number;
	readonly modules: boolean[][];
	/** Finder, timing, alignment, format and version modules, which masks leave alone. */
	readonly fixed: boolean[][];

	constructor(version: number) {
		this.size = version * 4 + 17;
		this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		for (let i = 0; i < this.size; i++) {
			this.set(6, i, i % 2 === 0);
			this.set(i, 6, i % 2 === 0);
		}
		for (const [x, y] of [
			[3, 3],
			[this.size - 4, 3],
			[3, this.size - 4],
		] as const) {
			for (let dy = -4; dy <= 4; dy++) {
				for (let dx = -4; dx <= 4; dx++) {
					const distance = Math.max(Math.abs(dx), Math.abs(dy));
					if (x + dx >= 0 && x + dx < this.size && y + dy >= 0 && y + dy < this.size) {
						this.set(x + dx, y + dy, distance !== 2 && distance !== 4);
					}
				}
			}
		}
		const positions = alignmentPositions(version);
		const last = positions.length - 1;
		positions.forEach((x, i) => {
			positions.forEach((y, j) => {
				// Not over the finders.
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
				}
			});
		});
		// Reserves the format modules; draw() writes them once the mask is known.
		this.format(0);
		if (version >= 7) {
			const bits = (version << 12) | bch(version, 0x1f25, 12);
			for (let i = 0; i < 18; i++) {
				const dark = ((bits >>> i) & 1) === 1;
				this.set(this.size - 11 + (i % 3), Math.floor(i / 3), dark);
				this.set(Math.floor(i / 3), this.size - 11 + (i % 3), dark);
			}
		}
	}

	set(x: number, y: number, dark: boolean): void {
		this.modules[y]![x] = dark;
		this.fixed[y]![x] = true;
	}

	format(mask: number): void {
		const data = (LEVEL_M << 3) | mask;
		const bits = ((data << 10) | bch(data, 0x537, 10)) ^ 0x5412;
		const bit = (i: number) => ((bits >>> i) & 1) === 1;
		for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
		this.set(8, 7, bit(6));
		this.set(8, 8, bit(7));
		this.set(7, 8, bit(8));
		for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
		for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
		for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
		this.set(8, this.size - 8, true);
	}

	/** Places the codewords in the two-column zigzag from the bottom right, around fixed modules. */
	place(data: number[]): void {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vertical = 0; vertical < this.size; vertical++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vertical : vertical;
					if (this.fixed[y]![x] || i >= data.length * 8) continue;
					this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
					i++;
				}
			}
		}
	}

	/** Applying a mask twice undoes it. */
	mask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++)
				if (!this.fixed[y]![x] && MASKS[mask]!(x, y)) this.modules[y]![x] = !this.modules[y]![x];
		}
	}

	penalty(): number {
		const { size, modules } = this;
		let result = 0;
		const lines = [modules, modules[0]!.map((_, x) => modules.map((row) => row[x]!))];
		for (const line of lines.flat()) {
			// Runs of five or more of one colour.
			let run = 1;
			for (let i = 1; i <= size; i++) {
				if (i < size && line[i] === line[i - 1]) {
					run++;
					continue;
				}
				if (run >= 5) result += 3 + run - 5;
				run = 1;
			}
			// A finder-like 1:1:3:1:1 with four light modules on either side.
			const text = line.map((dark) => (dark ? "1" : "0")).join("");
			for (let i = 0; i + 11 <= size; i++) {
				const window = text.slice(i, i + 11);
				if (window === "10111010000" || window === "00001011101") result += 40;
			}
		}
		for (let y = 0; y + 1 < size; y++) {
			for (let x = 0; x + 1 < size; x++) {
				const color = modules[y]![x];
				if (modules[y]![x + 1] === color && modules[y + 1]![x] === color && modules[y + 1]![x + 1] === color)
					result += 3;
			}
		}
		const dark = modules.flat().filter(Boolean).length;
		result += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
		return result;
	}
}

/**
 * `text`'s QR code, rows of modules (true is dark), without the quiet zone. `mask` picks one of the
 * eight; left out, the one with the lowest penalty.
 */
export function qrMatrix(text: string, mask?: number): boolean[][] {
	const bytes = new TextEncoder().encode(text);
	let version = 1;
	while (4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) {
		if (++version > 10) throw new Error(`Too long for a QR code: ${bytes.length} bytes`);
	}
	const grid = new Grid(version);
	grid.place(codewords(bytes, version));
	let chosen = mask ?? 0;
	if (mask === undefined) {
		let lowest = Number.POSITIVE_INFINITY;
		for (let candidate = 0; candidate < 8; candidate++) {
			grid.mask(candidate);
			grid.format(candidate);
			const penalty = grid.penalty();
			if (penalty < lowest) {
				lowest = penalty;
				chosen = candidate;
			}
			grid.mask(candidate);
		}
	}
	grid.mask(chosen);
	grid.format(chosen);
	return grid.modules;
}

/** In the terminal's own colours: dark modules in its foreground on its background, so the code
 *  is inverted on a dark terminal, which scanners read too. Only resets: not dimmed, as pi dims a notice. */
const OPEN = "\x1b[22;39;49m";
const QUIET = 4;

/** Two module rows to a line with half blocks, in a blank quiet zone of 4 modules. */
export function renderQr(matrix: boolean[][]): string {
	const width = matrix.length + QUIET * 2;
	const dark = (x: number, y: number) => matrix[y - QUIET]?.[x - QUIET] === true;
	const lines: string[] = [];
	for (let y = 0; y < width; y += 2) {
		let line = "";
		for (let x = 0; x < width; x++) {
			const top = dark(x, y);
			const bottom = dark(x, y + 1);
			line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(`${OPEN}${line}`);
	}
	return lines.join("\n");
}
