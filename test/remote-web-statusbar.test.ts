import { describe, expect, it } from "vitest";
import {
	barHtml,
	columns,
	contrast,
	elapsedText,
	factsHtml,
	spanStyle,
	thinkingHtml,
	tokens,
	untilText,
} from "../daemon/remote/web/statusbar.js";

const now = Date.parse("2026-10-15T10:12:00Z");
const report = {
	model: { provider: "anthropic", id: "claude-opus", name: "Opus" },
	models: [],
	thinkingLevel: "high",
	thinkingLevels: ["off", "low", "medium", "high"],
	trust: "always",
	context: { tokens: 68_000, contextWindow: 200_000, percent: 34 },
	usage: { input: 1_000_000, output: 150_000, cacheRead: 40_000, cacheWrite: 10_000, cost: 3.2149 },
	git: { branch: "main", owner: "christophe", added: 12, removed: 3 },
	limits: {
		sessionUsage: 43.4,
		sessionResetAt: "2026-10-15T12:30:00Z",
		weeklyUsage: 46,
		weeklyResetAt: "2026-10-20T10:00:00Z",
	},
};
/** What the bar says, without its markup. */
const text = (html: string) =>
	html
		.replace(/<\/span><span class="line">/g, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/ +/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.trim();

describe("the chat's status bar", () => {
	it("shows the session, then where it is and the plan's limits, as pistatusline does", () => {
		const html = barHtml(report, "~/Projects/bluclawd", now);
		expect(html.match(/class="line"/g)).toHaveLength(2);
		expect(text(html)).toBe(
			"Opus • high 34% 1.2M · $3.21 ⏵︎⏵︎ always\n~/Projects/bluclawd main +12 −3 5h 43% 2h18m wk 46% 4d23h",
		);
		// Every badge glyph as text: iOS draws a bare ⏸ as a colour emoji.
		for (const trust of ["always", "ask", "never"]) {
			const badge = text(barHtml({ models: [], trust }, undefined, now));
			expect(badge.replace(/[a-z ]/g, "").replace(/(.)︎/gu, ""), trust).toBe("");
		}
		// The context gauge's width is a class: the CSP allows no inline style.
		expect(html).toContain('class="p40"');
		expect(html).not.toContain("style=");
	});

	it("leaves out what is unknown: no report yet, no thinking, no git, no limits", () => {
		expect(barHtml(undefined, "~/p", now)).toBe(
			'<span class="line"><span class="grow cwd"><bdi>~/p</bdi></span></span>',
		);
		expect(barHtml(null, undefined, now)).toBe("");
		const plain = barHtml({ models: [], model: { provider: "local", id: "llama" } }, undefined, now);
		expect(text(plain)).toBe("llama");
		const unknownContext = { models: [], context: { tokens: null, contextWindow: 200_000, percent: null } };
		expect(barHtml(unknownContext, undefined, now)).toBe("");
	});

	it("drops a usage window whose reset has passed: the Mac's cache has not seen the new one", () => {
		const limits = { sessionUsage: 90, sessionResetAt: "2026-10-15T09:00:00Z", weeklyUsage: 46 };
		expect(text(barHtml({ models: [], limits }, undefined, now))).toBe("wk 46%");
	});

	it("escapes what it shows", () => {
		const html = barHtml({ models: [], git: { branch: "<b>x</b>", added: 0, removed: 0 } }, '~/"a"&b', now);
		expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
		expect(html).toContain("~/&#34;a&#34;&#38;b");
	});

	it("counts down to a reset in minutes, hours and days", () => {
		expect(untilText("2026-10-15T10:47:00Z", now)).toBe("35m");
		expect(untilText("2026-10-15T12:17:00Z", now)).toBe("2h05m");
		expect(untilText("2026-10-19T16:12:00Z", now)).toBe("4d6h");
		expect(untilText("2026-10-15T10:00:00Z", now)).toBeUndefined();
		expect(untilText("soon", now)).toBeUndefined();
		expect(untilText(undefined, now)).toBeUndefined();
	});

	it("shortens token counts", () => {
		expect([tokens(950), tokens(12_300), tokens(1_250_000)]).toEqual(["950", "12.3k", "1.3M"]);
	});
});

describe("the status sheet's pickers and facts", () => {
	it("picks among the levels pi offers for the model, else shows the level", () => {
		const picker = thinkingHtml(report);
		expect(picker).toContain('<select id="thinking">');
		expect(picker.match(/<option/g)).toHaveLength(4);
		expect(picker).toContain("<option selected>high</option>");
		expect(thinkingHtml({ models: [] })).toBe("<dt>Thinking</dt><dd>off</dd>");
	});

	it("shows the directory, git, both limits and the trust mode picker", () => {
		const html = factsHtml(report, "~/Projects/bluclawd", now);
		expect(html).toContain("<dd>~/Projects/bluclawd</dd>");
		expect(html).toContain("christophe · main");
		expect(html).toContain("43% used · resets in 2h18m");
		expect(html).toContain("46% used · resets in 4d23h");
		expect(html).toContain('<select id="trust">');
		// Words alone: an option cannot be styled, and iOS draws a bare ⏸ as a colour emoji.
		expect(html).toContain('<option value="always" selected>Always</option>');
		expect(html).toContain('<option value="ask">Ask</option>');
		expect(html.match(/<option/g)).toHaveLength(3);
	});

	it("offers no trust picker for a pane that reports no trust mode", () => {
		expect(factsHtml({ models: [] }, undefined, now)).toBe("");
	});
});

describe("the user's pistatusline on the phone", () => {
	it("keeps each span's colours, exactly, while they read on the theme", () => {
		expect(spanStyle({ text: "main", fg: "#5f87af" }, true)).toEqual({ color: "#5f87af", classes: [] });
		expect(spanStyle({ text: "opus", fg: "#ff0000", bold: true }, false)).toEqual({
			color: "#ff0000",
			classes: ["b"],
		});
		expect(spanStyle({ text: "x", dim: true, italic: true, underline: true }, false)).toEqual({
			classes: ["d", "i", "u"],
		});
		// Truecolour and 256-colour shades are the user's own choice, readable or not.
		expect(spanStyle({ text: "x", fg: "#fefefe" }, false)).toEqual({ color: "#fefefe", classes: [] });
	});

	it("draws a named terminal colour too faint on the theme in the app's own shade of it", () => {
		// Yellow, white and bright green on white; black and blue on dark.
		for (const fg of ["#cdcd00", "#ffff00", "#ffffff", "#e5e5e5", "#00ff00", "#00cdcd"]) {
			const { color } = spanStyle({ text: "x", fg }, false);
			expect(color, fg).not.toBe(fg);
			expect(contrast(color!, "#ffffff"), fg).toBeGreaterThanOrEqual(3);
		}
		for (const fg of ["#000000", "#0000ee"]) {
			const { color } = spanStyle({ text: "x", fg }, true);
			expect(color, fg).not.toBe(fg);
			expect(contrast(color!, "#141414"), fg).toBeGreaterThanOrEqual(3);
		}
		// The same colours read on the other theme, and stay.
		expect(spanStyle({ text: "x", fg: "#ffff00" }, true).color).toBe("#ffff00");
		expect(spanStyle({ text: "x", fg: "#0000ee" }, false).color).toBe("#0000ee");
	});

	it("keeps a span's own background, with text that reads on it", () => {
		expect(spanStyle({ text: " ok ", fg: "#000000", bg: "#00cd00" }, true)).toEqual({
			color: "#000000",
			background: "#00cd00",
			classes: [],
		});
		// No colour of its own: the theme's text, unless it would not read there.
		expect(spanStyle({ text: " x ", bg: "#e5e5e5" }, false)).toEqual({ background: "#e5e5e5", classes: [] });
		expect(spanStyle({ text: " x ", bg: "#e5e5e5" }, true)).toEqual({
			color: "#141414",
			background: "#e5e5e5",
			classes: [],
		});
	});

	it("asks for as many characters as fit across the bar, within what the Mac renders", () => {
		expect(columns(358, 6.6)).toBe(54);
		expect(columns(100, 6.6)).toBe(20);
		expect(columns(5000, 6.6)).toBe(200);
		expect(columns(0, 6.6)).toBe(0);
		expect(columns(358, 0)).toBe(0);
	});
});

describe("a background task's running time", () => {
	it("counts minutes, then hours, then days", () => {
		expect(elapsedText(now - 20_000, now)).toBe("<1m");
		expect(elapsedText(now + 5000, now)).toBe("<1m");
		expect(elapsedText(now - 35 * 60_000, now)).toBe("35m");
		expect(elapsedText(now - 125 * 60_000, now)).toBe("2h05m");
		expect(elapsedText(now - (4 * 24 + 6) * 3_600_000, now)).toBe("4d6h");
	});
});
