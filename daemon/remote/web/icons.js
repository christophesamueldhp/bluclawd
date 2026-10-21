// @ts-check
/**
 * The app's icons: inline SVG in the text's colour (the CSP allows no inline style, but markup is
 * fine). Each is decorative: its button carries the name in `aria-label`.
 */

/** @param {string} paths @param {string} [fill] */
const svg = (paths, fill = "none") =>
	`<svg class="icon" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
	working: svg(`<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>`),
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
	tasks: svg(`<path d="M4 17l6-6-6-6M12 19h8"/>`),
};
