// @ts-check
/**
 * The app's icons: inline SVG in the text's colour (the CSP allows no inline style, but markup is
 * fine). Each is decorative: its button carries the name in `aria-label`.
 */

/** @param {string} paths @param {string} [fill] */
const svg = (paths, fill = "none") =>
	`<svg class="icon" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
	back: svg(`<path d="M15 18l-6-6 6-6"/>`),
	bell: svg(`<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`),
	close: svg(`<path d="M18 6L6 18M6 6l12 12"/>`),
	more: svg(`<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`),
	pin: svg(
		`<path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z"/><path d="M8 3h8"/>`,
	),
	pinned: svg(
		`<path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z" fill="currentColor"/><path d="M8 3h8"/>`,
	),
	stop: svg(`<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>`),
	send: svg(`<path d="M12 19V5M5 12l7-7 7 7"/>`),
	attach: svg(`<path d="M12 5v14M5 12h14"/>`),
	check: svg(`<path d="M20 6L9 17l-5-5"/>`),
	updown: svg(`<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>`),
	terminal: svg(`<path d="M4 17l6-6-6-6M12 19h8"/>`),
	eye: svg(
		`<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>`,
	),
	edit: svg(
		`<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>`,
	),
	search: svg(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`),
	globe: svg(
		`<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
	),
	bot: svg(
		`<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>`,
	),
	wrench: svg(
		`<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`,
	),
	brain: svg(
		`<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>`,
	),
};

/** A tool's icon, by what it does. @param {string} name */
export function toolIcon(name) {
	const tool = name.toLowerCase();
	if (tool === "bash") return ICONS.terminal;
	if (tool === "read") return ICONS.eye;
	if (tool === "edit" || tool === "write") return ICONS.edit;
	if (["grep", "find", "glob", "ls"].includes(tool)) return ICONS.search;
	if (tool.startsWith("web")) return ICONS.globe;
	if (tool.includes("agent")) return ICONS.bot;
	return ICONS.wrench;
}
