// @ts-check
/**
 * The chat's status bar and the status sheet's facts beyond the model, as pistatusline shows them
 * under pi on the Mac. Pure, so the tests import it; each item is left out while it is unknown.
 */

/** @typedef {{ branch: string, owner?: string, added: number, removed: number }} GitInfo */
/** @typedef {{ sessionUsage?: number, sessionResetAt?: string, weeklyUsage?: number, weeklyResetAt?: string }} UsageLimits */
/** @typedef {{ provider: string, id: string, name?: string }} ReportModel */
/**
 * A pane's report, with what the Mac adds for its directory (`git`, `limits`).
 * @typedef {{ model?: ReportModel, models: ReportModel[], thinkingLevel?: string, thinkingLevels?: string[], trust?: string, context?: { tokens: number | null, contextWindow: number, percent: number | null }, usage?: { input: number, output: number, cacheRead: number, cacheWrite: number, cost: number }, git?: GitInfo, limits?: UsageLimits }} Report
 */

/** pi's `defaultProjectTrust` values, as Alt+M cycles them, and their footer badges. */
export const TRUST = [
	["always", "⏵⏵ always"],
	["ask", "⏸ ask"],
	["never", "✕ never"],
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

/** How long until `iso`: "35m", "2h05m", "4d6h"; undefined once it has passed. @param {string | undefined} iso @param {number} now */
export function untilText(iso, now) {
	const ms = iso ? Date.parse(iso) - now : Number.NaN;
	if (!(ms > 0)) return undefined;
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/**
 * A usage window's percent and time to reset; none once its reset has passed, since the Mac's cache
 * has not seen the new window yet.
 * @param {number | undefined} percent @param {string | undefined} resetAt @param {number} now
 */
function usageWindow(percent, resetAt, now) {
	if (typeof percent !== "number") return undefined;
	const until = untilText(resetAt, now);
	if (resetAt && !until) return undefined;
	return { percent: Math.round(percent), until };
}

/** A class per 10%: the CSP allows no inline style for a width. @param {number} value @param {string} label @param {string} [kind] */
function gauge(value, label, kind = "") {
	const percent = Math.min(100, Math.max(0, value));
	const step = Math.ceil(percent / 10) * 10;
	const level = percent >= 85 ? " full" : percent >= 60 ? " high" : "";
	return `<span class="gauge${kind}" role="meter" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(Math.round(percent))}"><span class="p${step}${level}"></span></span>`;
}

/** @param {string | undefined} trust */
function trustHtml(trust) {
	const badge = TRUST.find(([value]) => value === trust)?.[1];
	return badge ? `<span class="trust ${esc(trust)}">${esc(badge)}</span>` : "";
}

/** @param {GitInfo} git */
function changesHtml(git) {
	const parts = [];
	if (git.added) parts.push(`<span class="added">+${esc(git.added)}</span>`);
	if (git.removed) parts.push(`<span class="removed">−${esc(git.removed)}</span>`);
	return parts.join(" ");
}

/**
 * Two lines: the session (model • thinking, context, tokens and cost, trust mode), then where it is
 * and the plan's limits (directory, git branch and changes, 5-hour and weekly usage).
 * @param {Report | null | undefined} report @param {string | undefined} cwd as shown, `~` for home @param {number} now
 */
export function barHtml(report, cwd, now) {
	const first = [];
	const second = [];
	const model = report?.model;
	if (model) {
		const thinking = report.thinkingLevel ? ` • ${esc(report.thinkingLevel)}` : "";
		first.push(`<span class="model grow">${esc(model.name ?? model.id)}${thinking}</span>`);
	}
	const context = report?.context;
	if (context && context.percent !== null) {
		first.push(
			`<span>${gauge(context.percent, "Context used", " mini")} ${esc(Math.round(context.percent))}%</span>`,
		);
	}
	const usage = report?.usage;
	if (usage) {
		const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		first.push(`<span>${esc(tokens(total))} · $${esc(usage.cost.toFixed(2))}</span>`);
	}
	const trust = trustHtml(report?.trust);
	if (trust) first.push(trust);
	if (cwd) second.push(`<span class="grow cwd"><bdi>${esc(cwd)}</bdi></span>`);
	const git = report?.git;
	if (git) {
		const changes = changesHtml(git);
		second.push(`<span class="grow branch">${esc(git.branch)}</span>`);
		if (changes) second.push(`<span>${changes}</span>`);
	}
	const limits = report?.limits;
	for (const [name, percent, resetAt] of /** @type {const} */ ([
		["5h", limits?.sessionUsage, limits?.sessionResetAt],
		["wk", limits?.weeklyUsage, limits?.weeklyResetAt],
	])) {
		const use = usageWindow(percent, resetAt, now);
		if (use) {
			second.push(`<span>${name} ${esc(use.percent)}%${use.until ? ` ${esc(use.until)}` : ""}</span>`);
		}
	}
	return [first, second]
		.filter((line) => line.length)
		.map((line) => `<span class="line">${line.join("")}</span>`)
		.join("");
}

/** A picker of the levels pi offers for the model, else the level as text. @param {Report} report */
export function thinkingHtml(report) {
	const levels = report.thinkingLevels ?? [];
	if (levels.length < 2) return `<dt>Thinking</dt><dd>${esc(report.thinkingLevel ?? "off")}</dd>`;
	const options = levels
		.map((level) => `<option${level === report.thinkingLevel ? " selected" : ""}>${esc(level)}</option>`)
		.join("");
	return `<dt><label for="thinking">Thinking</label></dt><dd><select id="thinking">${options}</select></dd>`;
}

/**
 * The sheet's rows after the session's own: directory, git, usage limits and the trust mode picker.
 * @param {Report} report @param {string | undefined} cwd as shown, `~` for home @param {number} now
 */
export function factsHtml(report, cwd, now) {
	const rows = [];
	if (cwd) rows.push(`<dt>Directory</dt><dd>${esc(cwd)}</dd>`);
	const git = report.git;
	if (git) {
		const changes = changesHtml(git);
		rows.push(
			`<dt>Git</dt><dd>${git.owner ? `${esc(git.owner)} · ` : ""}${esc(git.branch)}${changes ? `<small>${changes}</small>` : ""}</dd>`,
		);
	}
	const limits = report.limits;
	for (const [name, percent, resetAt] of /** @type {const} */ ([
		["5-hour limit", limits?.sessionUsage, limits?.sessionResetAt],
		["Weekly limit", limits?.weeklyUsage, limits?.weeklyResetAt],
	])) {
		const use = usageWindow(percent, resetAt, now);
		if (use) {
			rows.push(
				`<dt>${name}</dt><dd>${gauge(use.percent, name)}<small>${esc(use.percent)}% used${use.until ? ` · resets in ${esc(use.until)}` : ""}</small></dd>`,
			);
		}
	}
	if (report.trust) {
		const options = TRUST.map(
			([value, badge]) =>
				`<option value="${value}"${value === report.trust ? " selected" : ""}>${esc(badge)}</option>`,
		).join("");
		rows.push(
			`<dt><label for="trust">Trust</label></dt><dd><select id="trust">${options}</select><small>pi's defaultProjectTrust, as Alt+M cycles it: applies to projects opened from now on</small></dd>`,
		);
	}
	return rows.join("");
}
