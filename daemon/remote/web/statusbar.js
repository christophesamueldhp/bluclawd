// @ts-check

/** @typedef {{ branch: string, owner?: string, added: number, removed: number }} GitInfo */
/** @typedef {{ provider: string, id: string, name?: string }} ReportModel */
/**
 * @typedef {{ name: string, description?: string, source?: "builtin" | "extension" | "prompt" | "skill", skill?: {id: string, scope: string, path: string, origin: string, source: string} }} Command
 */
/** @typedef {{ text: string, fg?: string, bg?: string, bold?: boolean, dim?: boolean, italic?: boolean, underline?: boolean }} StatusSpan */
/**
 * @typedef {{ id: string, kind: "shell" | "monitor" | "agent", label: string, startedAt: number, foreground?: boolean, output?: boolean, status?: string, model?: string }} Task
 */
/**
 * @typedef {{ id: string, outcome: "sent" | "taken" | "queued" } | { id: string, outcome: "refused", reason: "busy" | "draft" | "dialog" | "compacting" | "session_changed" | "unreachable" | "invalid_skills" } | { id: string, outcome: "lost", reason: "pane_gone" | "daemon_restarted" | "dequeued" }} PromptOutcome
 * @typedef {{ model?: ReportModel, models: ReportModel[], thinkingLevel?: string, thinkingLevels?: string[], trust?: string, context?: { tokens: number | null, contextWindow: number, percent: number | null }, usage?: { input: number, output: number, cacheRead: number, cacheWrite: number, cost: number }, subagentUsage?: { runCount: number, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number | null }, git?: GitInfo, notice?: { text: string, at: number }, outcomes?: PromptOutcome[], statusline?: { lines: StatusSpan[][] }, tasks?: Task[] }} Report
 */

/**
 * pi's `defaultProjectTrust` values, as Alt+M cycles them, their footer badges, and their names in
 * the sheet. U+FE0E keeps a glyph text, because iOS draws a bare ⏸ as a colour emoji.
 */
/** @type {["always" | "ask" | "never", string, string][]} */
export const TRUST = [
	["always", "⏵\uFE0E⏵\uFE0E always", "Always"],
	["ask", "⏸\uFE0E ask", "Ask"],
	["never", "✕\uFE0E never", "Never"],
];

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @param {number} count */
export function tokens(count) {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

/** @param {Report["subagentUsage"]} usage */
export function runUsageHtml(usage) {
	if (!usage || usage.runCount === 0) return "";
	const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost =
		typeof usage.cost === "number" && Number.isFinite(usage.cost) ? `$${usage.cost.toFixed(3)}` : "cost unknown";
	return `<p>Subagents (${esc(usage.runCount)}): ${esc(tokens(total))} tokens · ${esc(cost)} — excluded from session totals</p>`;
}

/** pi's footer warns above 70% and reports an error above 90%. @param {number} percent */
export function contextLevel(percent) {
	return percent > 90 ? "full" : percent > 70 ? "high" : "normal";
}

/** @param {GitInfo} git */
function changesHtml(git) {
	const parts = [];
	if (git.added) parts.push(`<span class="added">+${esc(git.added)}</span>`);
	if (git.removed) parts.push(`<span class="removed">−${esc(git.removed)}</span>`);
	return parts.join(" ");
}

/** @param {Report | null | undefined} report @param {string | undefined} cwd */
export function barHtml(report, cwd) {
	const items = [];
	const model = report?.model;
	if (model) {
		const thinking = report.thinkingLevel
			? ` • <span class="thinking-level" data-thinking="${esc(report.thinkingLevel)}">${esc(report.thinkingLevel)}</span>`
			: "";
		items.push(`<span class="model grow">${esc(model.name ?? model.id)}${thinking}</span>`);
	}
	const context = report?.context;
	if (context && context.percent !== null) {
		items.push(
			`<span class="context-used ${contextLevel(context.percent)}">ctx ${esc(Math.round(context.percent))}%</span>`,
		);
	}
	const branch = report?.git?.branch;
	if (branch) items.push(`<span class="grow branch">${esc(branch)}</span>`);
	else if (cwd) items.push(`<span class="grow cwd"><bdi>${esc(cwd)}</bdi></span>`);
	const always = TRUST.find(([value]) => value === "always")?.[1];
	if (report?.trust === "always" && always) items.push(`<span class="trust always">${esc(always)}</span>`);
	return items.length ? `<span class="line">${items.join('<span aria-hidden="true">·</span>')}</span>` : "";
}

/** @param {string} key @param {string} label @param {string} value @param {boolean} pickable */
function settingHtml(key, label, value, pickable) {
	const inner = `<span class="label">${esc(label)}</span><span class="value">${esc(value)}</span>`;
	return pickable
		? `<button type="button" class="setting" data-pick="${key}">${inner}<span class="chevron" aria-hidden="true">›</span></button>`
		: `<div class="setting"${key === "thinking" ? ` data-thinking="${esc(value)}"` : ""}>${inner}</div>`;
}

/**
 * The thinking level as a slider with a stop for each level pi offers, in pi's order. A tap on a
 * level's name under it picks it too, because iOS moves a range's thumb only by dragging it. app.js sends the level a tap picks.
 * @param {string[]} levels @param {string} level
 */
function thinkingHtml(levels, level) {
	const at = levels.indexOf(level);
	const ticks = levels
		.map(
			(name, index) =>
				`<button type="button" tabindex="-1" data-thinking="${esc(name)}" data-level="${index}">${esc(name)}</button>`,
		)
		.join("");
	const slider = `<input type="range" id="thinking" min="0" max="${levels.length - 1}" step="1" value="${Math.max(at, 0)}" aria-label="Thinking" aria-valuetext="${esc(level)}">`;
	return `<div class="setting slider" data-thinking="${esc(level)}"><span class="label">Thinking</span><span class="value">${esc(level)}</span>${slider}<div class="ticks" aria-hidden="true">${ticks}</div></div>`;
}

/** @param {Report} report @param {boolean} pickable */
export function settingsHtml(report, pickable) {
	const model = report.model ? (report.model.name ?? report.model.id) : "None selected";
	const levels = report.thinkingLevels ?? [];
	const level = report.thinkingLevel ?? "off";
	const rows = [
		settingHtml("model", "Model", model, pickable && report.models.length > 0),
		pickable && levels.length > 1 ? thinkingHtml(levels, level) : settingHtml("thinking", "Thinking", level, false),
	];
	const trust = TRUST.find(([value]) => value === report.trust);
	if (trust) rows.push(settingHtml("trust", "Trust", trust[2], pickable));
	return `<div class="settings">${rows.join("")}</div>`;
}

/** @param {Report} report @param {string | undefined} cwd */
export function whereHtml(report, cwd) {
	const lines = [];
	if (cwd) lines.push(esc(cwd));
	const git = report.git;
	if (git) {
		const changes = changesHtml(git);
		lines.push(`${git.owner ? `${esc(git.owner)} · ` : ""}${esc(git.branch)}${changes ? ` ${changes}` : ""}`);
	}
	return lines.map((line) => `<p class="meta">${line}</p>`).join("");
}

const XTERM = [
	"#000000",
	"#cd0000",
	"#00cd00",
	"#cdcd00",
	"#0000ee",
	"#cd00cd",
	"#00cdcd",
	"#e5e5e5",
	"#7f7f7f",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#5c5cff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];
const READABLE = {
	light: [
		"#000000",
		"#c4243c",
		"#2c7a39",
		"#a06f00",
		"#1f4fd1",
		"#a3289b",
		"#007c99",
		"#545458",
		"#6e6e73",
		"#c4243c",
		"#2c7a39",
		"#a06f00",
		"#3d5afe",
		"#a3289b",
		"#007c99",
		"#3a3a3c",
	],
	dark: [
		"#98989f",
		"#ff6b80",
		"#4eba65",
		"#ffc107",
		"#6b8cff",
		"#e07ae0",
		"#33cdee",
		"#e5e5e5",
		"#98989f",
		"#ff6b80",
		"#4eba65",
		"#ffc107",
		"#8c9eff",
		"#ff7aff",
		"#33cdee",
		"#ffffff",
	],
};
const THEME = { light: { bg: "#ffffff", text: "#000000" }, dark: { bg: "#141414", text: "#ffffff" } };
/** Below this, text is not read at a glance (WCAG's minimum for large text). */
const MIN_CONTRAST = 3;

/** @param {string} hex */
function luminance(hex) {
	const [r, g, b] = [1, 3, 5].map((at) => {
		const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** @param {string} a @param {string} b */
export function contrast(a, b) {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

/** @param {StatusSpan} span @param {boolean} dark @returns {{ color?: string, background?: string, classes: string[] }} */
export function spanStyle(span, dark) {
	const theme = THEME[dark ? "dark" : "light"];
	const classes = [];
	if (span.bold) classes.push("b");
	if (span.dim) classes.push("d");
	if (span.italic) classes.push("i");
	if (span.underline) classes.push("u");
	let color = span.fg;
	if (span.bg) {
		if (!color && contrast(theme.text, span.bg) < MIN_CONTRAST) color = theme.bg;
		return { ...(color ? { color } : {}), background: span.bg, classes };
	}
	const named = color ? XTERM.indexOf(color.toLowerCase()) : -1;
	if (color && named >= 0 && contrast(color, theme.bg) < MIN_CONTRAST) {
		color = READABLE[dark ? "dark" : "light"][named];
	} else if (color && contrast(color, theme.bg) < MIN_CONTRAST) color = readable(color, theme.text, theme.bg);
	return { ...(color ? { color } : {}), classes };
}

/** @param {string} color @param {string} toward @param {string} bg */
function readable(color, toward, bg) {
	const channels = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
	const [from, to] = [channels(color), channels(toward)];
	for (let step = 1; step <= 10; step++) {
		const mixed = `#${from
			.map((c, i) =>
				Math.round(c + ((to[i] - c) * step) / 10)
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")}`;
		if (contrast(mixed, bg) >= MIN_CONTRAST) return mixed;
	}
	return toward;
}

/** @param {StatusSpan[][]} lines @returns {StatusSpan[][]} */
export function compactLines(lines) {
	return lines.map((spans) => {
		const out = spans.map((span) => ({ ...span, text: span.text.replace(/ {3,}/g, "  ") }));
		while (out.length && !out.at(-1)?.bg && out.at(-1)?.text.trim() === "") out.pop();
		const last = out.at(-1);
		if (last && !last.bg) out[out.length - 1] = { ...last, text: last.text.trimEnd() };
		return out;
	});
}

/** @param {number} startedAt @param {number} now */
export function elapsedText(startedAt, now) {
	const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
