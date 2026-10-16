// @ts-check
/**
 * The loading mascot: mascot.svg's 20×15 pixel grid (ext/_shared/mascot.ts's SOURCE, which a test
 * keeps this equal to) drawn as vector rows, its eyes a group of their own that style.css rolls
 * around the head. The SVG file embeds a raster, so its eyes cannot move on their own.
 */

/** `.` transparent, `#` body, `o` eye. */
export const GRID = [
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

/** The body, eyes' places filled, so the eyes can move over it: a rectangle per run of a row. */
function bodyPath() {
	let path = "";
	GRID.forEach((row, y) => {
		for (const run of row.matchAll(/[#o]+/g)) path += `M${run.index} ${y}h${run[0].length}v1h-${run[0].length}z`;
	});
	return path;
}

/** Each 2×2 eye's top-left pixel. */
const EYES = GRID.flatMap((row, y) =>
	[...row].flatMap((pixel, x) => (pixel === "o" && row[x - 1] !== "o" && GRID[y - 1]?.[x] !== "o" ? [[x, y]] : [])),
);

/** Its eyes roll while something loads; "Loading…" is for screen readers. */
export function loaderHtml() {
	const eyes = EYES.map(([x, y]) => `<rect x="${x}" y="${y}" width="2" height="2"/>`).join("");
	return `<div class="loader" role="status"><svg viewBox="0 0 20 15" aria-hidden="true" shape-rendering="crispEdges"><path class="body" d="${bodyPath()}"/><g class="eyes">${eyes}</g></svg><span class="label">Loading…</span></div>`;
}
