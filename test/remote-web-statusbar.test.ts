import { describe, expect, expectTypeOf, it } from "vitest";
import {
	backgroundUsageHtml,
	barHtml,
	compactLines,
	contextLevel,
	contrast,
	elapsedText,
	type Report,
	settingsHtml,
	spanStyle,
	tokens,
	whereHtml,
} from "#remote-web/statusbar.js";
import type { StatusView } from "../daemon/remote/phone-control.ts";

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
	// Checked by npm run typecheck: the web app cannot import the daemon's type, so it documents it by hand.
	it("reads the status view phone control builds, field for field", () => {
		expectTypeOf<keyof Report>().toEqualTypeOf<keyof StatusView>();
		expectTypeOf<StatusView>().toExtend<Report>();
	});

	it("labels background usage as additional and never renders unknown pricing as zero", () => {
		expect(backgroundUsageHtml(undefined)).toBe("");
		const usage = { runCount: 2, input: 300, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.03 };
		const known = text(backgroundUsageHtml(usage));
		expect(known).toContain("Background subagents (2)");
		expect(known).toContain("$0.030");
		expect(known).toContain("excluded from session totals");
		const unknown = text(backgroundUsageHtml({ ...usage, cost: null }));
		expect(unknown).toContain("cost unknown");
		expect(unknown).not.toContain("$0.000");
	});

	it("shows the session, then where it is, as pistatusline does", () => {
		const html = barHtml(report, "~/Projects/bluclawd");
		expect(html.match(/class="line"/g)).toHaveLength(2);
		expect(text(html)).toBe("Opus • high 34% 1.2M · $3.21 ⏵︎⏵︎ always\n~/Projects/bluclawd main +12 −3");
		// Every badge glyph as text: iOS draws a bare ⏸ as a colour emoji.
		for (const trust of ["always", "ask", "never"]) {
			const badge = text(barHtml({ models: [], trust }, undefined));
			expect(badge.replace(/[a-z ]/g, "").replace(/(.)︎/gu, ""), trust).toBe("");
		}
		// The context gauge's width is a class: the CSP allows no inline style.
		expect(html).toContain('class="p40"');
		expect(html).not.toContain("style=");
	});

	it.each([
		[0, "normal"],
		[70, "normal"],
		[70.1, "high"],
		[90, "high"],
		[90.1, "full"],
		[100, "full"],
	])("colors context at %s%% as %s, matching pi's warning thresholds", (percent, level) => {
		expect(contextLevel(Number(percent))).toBe(level);
		const html = barHtml({ ...report, context: { ...report.context, percent: Number(percent) } }, undefined);
		expect(html).toContain(`class="context-used ${level}"`);
	});

	it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
		"marks thinking %s for its own color in the bar and settings",
		(level) => {
			const colored = {
				...report,
				thinkingLevel: level,
				thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			};
			expect(barHtml(colored, undefined)).toContain(`class="thinking-level" data-thinking="${level}"`);
			expect(settingsHtml(colored)).toContain(`class="setting slider" data-thinking="${level}"`);
			expect(settingsHtml({ models: [], thinkingLevel: level })).toContain(
				`class="setting" data-thinking="${level}"`,
			);
		},
	);

	it("leaves out what is unknown: no report yet, no thinking, no git", () => {
		expect(barHtml(undefined, "~/p")).toBe('<span class="line"><span class="grow cwd"><bdi>~/p</bdi></span></span>');
		expect(barHtml(null, undefined)).toBe("");
		const plain = barHtml({ models: [], model: { provider: "local", id: "llama" } }, undefined);
		expect(text(plain)).toBe("llama");
		const unknownContext = { models: [], context: { tokens: null, contextWindow: 200_000, percent: null } };
		expect(barHtml(unknownContext, undefined)).toBe("");
	});

	it("escapes what it shows", () => {
		const html = barHtml({ models: [], git: { branch: "<b>x</b>", added: 0, removed: 0 } }, '~/"a"&b');
		expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
		expect(html).toContain("~/&#34;a&#34;&#38;b");
	});

	it("shortens token counts", () => {
		expect([tokens(950), tokens(12_300), tokens(1_250_000)]).toEqual(["950", "12.3k", "1.3M"]);
	});
});

describe("the status sheet's settings and where it is", () => {
	const models = [{ provider: "anthropic", id: "claude-opus", name: "Opus" }];

	it("lists the model and trust as rows a tap picks another value for, and thinking as a slider", () => {
		const html = settingsHtml({ ...report, models });
		expect(text(html)).toBe("Model Opus › Thinking high off low medium high Trust Always ›");
		expect(html.match(/<button type="button" class="setting" data-pick="(\w+)"/g)).toHaveLength(2);
		expect(html).toContain('<input type="range" id="thinking" min="0" max="3" step="1" value="3"');
		expect(html.match(/data-level="\d"/g)).toHaveLength(4);
		// No hint under trust: its name says enough.
		expect(html).not.toContain("defaultProjectTrust");
	});

	it("shows a value no tap changes as a plain row, and no trust row for a pane without one", () => {
		const html = settingsHtml({ models: [] });
		expect(text(html)).toBe("Model None selected Thinking off");
		expect(html).not.toContain("data-pick");
	});

	it("says where the session is in two grey lines, and no plan usage", () => {
		const html = whereHtml(report, "~/Projects/bluclawd");
		expect(html.match(/<p class="meta">/g)).toHaveLength(2);
		expect(text(html)).toBe("~/Projects/bluclawd christophe · main +12 −3");
		expect(html).not.toContain("limit");
		expect(whereHtml({ models: [] }, undefined)).toBe("");
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
		// A truecolour or 256-colour shade too faint on the theme moves toward the text colour until it reads.
		const faint = spanStyle({ text: "Session:", fg: "#ffff5f" }, false).color ?? "";
		expect(faint).not.toBe("#ffff5f");
		expect(contrast(faint, "#ffffff")).toBeGreaterThanOrEqual(3);
		expect(spanStyle({ text: "x", fg: "#ffff5f" }, true)).toEqual({ color: "#ffff5f", classes: [] });
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

	it("takes out the room a flex separator fills at the widest, so nothing is cut and nothing gapes", () => {
		const lines = [
			[
				{ text: "Opus 5.5 ", fg: "#ffffff" },
				{ text: "                                        " },
				{ text: "~/Projects/b  |  x", fg: "#808080" },
				{ text: "         " },
			],
			[{ text: `Session: 99%${" ".repeat(30)}355.8M tokens   ` }],
		];
		expect(compactLines(lines)).toEqual([
			[{ text: "Opus 5.5 ", fg: "#ffffff" }, { text: "  " }, { text: "~/Projects/b  |  x", fg: "#808080" }],
			[{ text: "Session: 99%  355.8M tokens" }],
		]);
		// A coloured background's own spaces stay: they are what draws a bar.
		expect(compactLines([[{ text: "     ", bg: "#444444" }]])).toEqual([[{ text: "  ", bg: "#444444" }]]);
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
