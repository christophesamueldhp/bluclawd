// @ts-check
/**
 * The mascot, acting out what its session does: the 20×15 pixel grid of ext/_shared/mascot.ts's
 * SOURCE (a test keeps this equal to it) drawn as vector parts — torso, arms, legs, eyes — that
 * style.css moves by whole pixels, one set of keyframes per state, and the same parts turned a
 * quarter to either side, which the terminal's flat poses have no room for.
 */

/** @typedef {import("./app.js").Session} Session */
/** @typedef {"idle" | "thinking" | "writing" | "tool" | "needs" | "done" | "failed" | "asleep" | "loading" | "wave"} MascotState */

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

/** The arms are the two columns at either edge, the legs the rows under the torso. */
const TORSO = GRID.slice(0, 12).map((row) => `..${row.slice(2, -2)}..`);
const LEGS = GRID.slice(12);

/**
 * The torso turned a quarter, its face to the left edge: the front narrowed and moved over, and
 * the side it then shows (`s`) beside it, each tier's a little further back.
 */
const TURNED = [
	".......###ss........",
	".......###ss........",
	"....#########sss....",
	"....#########sss....",
	"..#oo####oo###ssss..",
	"..#oo####oo###ssss..",
	...Array.from({ length: 6 }, () => "..############ssss.."),
];

/** @param {string[]} rows @param {number} x @param {number} y */
const at = (rows, x, y) => rows[y]?.[x] ?? ".";

/**
 * A rectangle per run of the cells `pick` takes.
 * @param {string[]} rows @param {number} top the first row's y @param {(x: number, y: number) => boolean} pick
 */
function runs(rows, top, pick) {
	let path = "";
	rows.forEach((row, y) => {
		const cells = [...row].map((_, x) => (pick(x, y) ? "#" : ".")).join("");
		for (const run of cells.matchAll(/#+/g)) path += `M${run.index} ${y + top}h${run[0].length}v1h-${run[0].length}z`;
	});
	return path;
}

/** @param {number} x @param {number} y @param {number} w @param {number} h @param {string} [cls] */
const rect = (x, y, w, h, cls) => `<rect${cls ? ` class="${cls}"` : ""} x="${x}" y="${y}" width="${w}" height="${h}"/>`;

/**
 * A torso's front, eyes' places filled so the eyes can move over them, the side it shows, and its
 * face. A lit top edge and a shaded right and bottom one give the flat grid some volume.
 * @param {string[]} rows
 */
function torsoHtml(rows) {
	/** @param {number} x @param {number} y */
	const front = (x, y) => "#o".includes(at(rows, x, y));
	/** @param {number} x @param {number} y */
	const solid = (x, y) => at(rows, x, y) !== ".";
	// Each 2×2 eye's top-left pixel.
	const eyes = rows.flatMap((row, y) =>
		[...row].flatMap((pixel, x) =>
			pixel === "o" && row[x - 1] !== "o" && at(rows, x, y - 1) !== "o" ? [[x, y]] : [],
		),
	);
	const side = runs(rows, 0, (x, y) => at(rows, x, y) === "s");
	return [
		`<path class="body" d="${runs(rows, 0, front)}"/>`,
		side && `<path class="side" d="${side}"/>`,
		`<path class="light" d="${runs(rows, 0, (x, y) => front(x, y) && !solid(x, y - 1))}"/>`,
		`<path class="shade" d="${runs(rows, 0, (x, y) => front(x, y) && (!solid(x, y + 1) || !solid(x + 1, y)))}"/>`,
		// Open and shut eyes look the same way: the face moves, and a blink swaps one for the other.
		`<g class="face"><g class="eyes">${eyes.map(([x, y]) => rect(x, y, 2, 2)).join("")}</g>`,
		`<g class="lids">${eyes.map(([x, y]) => rect(x, y + 1, 2, 1)).join("")}</g></g>`,
	].join("");
}

/** @param {number[]} columns each 2×3 leg's left column */
const legs = (columns) => columns.map((x) => rect(x, 12, 2, 3)).join("");

/**
 * The mascot from the front and turned a quarter to either side, the same parts in each: the legs,
 * and over them the arms and the torso. Turned, its four legs are two sets that step in turn, the
 * far one of them and its far arm in its side's shade; facing right is facing left, mirrored.
 */
const TURNED_VIEW = [
	`<g class="legs odd">${legs([3, 11])}</g><g class="legs even">${legs([6])}${rect(15, 12, 2, 3, "far")}</g>`,
	`<g class="upper">${rect(0, 6, 2, 3, "arm l")}${rect(18, 6, 2, 3, "arm r far")}${torsoHtml(TURNED)}</g>`,
].join("");
const VIEWS = {
	f: `<g class="view f"><path class="legs" d="${runs(LEGS, 12, (x, y) => at(LEGS, x, y) === "#")}"/><g class="upper">${rect(0, 6, 2, 3, "arm l")}${rect(18, 6, 2, 3, "arm r")}${torsoHtml(TORSO)}</g></g>`,
	l: `<g class="view l">${TURNED_VIEW}</g>`,
	r: `<g class="view r" transform="matrix(-1 0 0 1 20 0)">${TURNED_VIEW}</g>`,
};

/** The views a state turns between, the first the one it shows when nothing moves; the front alone otherwise. */
const TURNS = { idle: "flr", loading: "flr", thinking: "rl", tool: "r" };

/** A pixel "z" `n` wide and tall with its top-left at `[x, y]`. @param {number} x @param {number} y @param {number} n */
function zed(x, y, n) {
	let path = `M${x} ${y}h${n}v1h-${n}zM${x} ${y + n - 1}h${n}v1h-${n}z`;
	for (let i = 1; i < n - 1; i++) path += `M${x + n - 1 - i} ${y + i}h1v1h-1z`;
	return path;
}

/** What a state draws around the mascot: thought dots, an alert, sparks, a sleeper's z's. */
const EXTRAS = {
	thinking: `<g class="dots">${rect(17, 1, 1, 1)}${rect(19, -1, 1, 1)}${rect(20, -4, 2, 2)}</g>`,
	needs: `<g class="alert">${rect(0, -4, 2, 4)}${rect(0, 1, 2, 2)}</g>`,
	done: `<g class="sparks">${rect(-1, 1, 1, 1)}${rect(20, -1, 1, 1)}${rect(2, -3, 1, 1)}</g>`,
	asleep: `<path class="z z1" d="${zed(14, -3, 5)}"/><path class="z z2" d="${zed(19, -5, 3)}"/>`,
};

/**
 * The mascot in `state`, decorative: what it shows is said in words beside it. Its box leaves room
 * around the grid for a raised arm, a jump, a few steps to either side and what a state draws above
 * the head.
 * @param {MascotState} state @param {string} [size] a class of style.css's: `mid` or `big`
 */
export function mascotHtml(state, size = "") {
	const extras = EXTRAS[/** @type {keyof typeof EXTRAS} */ (state)] ?? "";
	const views = [...(TURNS[/** @type {keyof typeof TURNS} */ (state)] ?? "f")]
		.map((view) => VIEWS[/** @type {keyof typeof VIEWS} */ (view)])
		.join("");
	return `<svg class="mascot ${state}${size ? ` ${size}` : ""}" viewBox="-2 -5 24 22" aria-hidden="true"><ellipse class="shadow" cx="10" cy="15.5" rx="8" ry="1"/><g class="sprite" shape-rendering="crispEdges"><g class="views">${views}</g>${extras}</g></svg>`;
}

/** It looks about while something loads; "Loading…" is for screen readers. */
export function loaderHtml() {
	return `<div class="loader" role="status">${mascotHtml("loading", "big")}<span class="label">Loading…</span></div>`;
}

/**
 * What the mascot acts out for a session: asleep while nothing answers for it (the Mac is out of
 * reach, its pane is gone or silent), waving for an answer, and mid-turn what the reply in progress
 * does — a tool running, text being written, else thinking.
 * @param {Session | undefined} session @param {{ text: string, tools: { running: boolean }[] } | undefined} live
 * @param {boolean} online @returns {MascotState}
 */
export function mascotState(session, live, online) {
	if (!online || !session?.alive || session.silent || session.state === "stopped") return "asleep";
	if (session.state === "needs") return "needs";
	if (session.state === "working") {
		if (live?.tools.some((tool) => tool.running)) return "tool";
		return live?.text ? "writing" : "thinking";
	}
	return session.state === "failed" || session.state === "done" ? session.state : "idle";
}

/**
 * The list's mascot, for all its sessions at once: asleep while the Mac's pi is out of reach,
 * waving while any waits on an answer, thinking while any works.
 * @param {Session[]} sessions @param {boolean} live @returns {MascotState}
 */
export function fleetState(sessions, live) {
	if (!live) return "asleep";
	const acting = sessions.map((session) => mascotState(session, undefined, true));
	return acting.includes("needs") ? "needs" : acting.includes("thinking") ? "thinking" : "idle";
}
