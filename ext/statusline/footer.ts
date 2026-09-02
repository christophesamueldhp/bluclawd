/**
 * Footer component replicating the user's Claude Code ccstatusline configuration
 * (`~/.config/ccstatusline/settings.json`, widget for widget):
 *
 *   line 1: model · thinking effort · context slider (bar only) — flex — origin owner · ⎇ branch · (+ins,-del) · cwd
 *   line 2: Claude usage — Session: slider % · reset timer | Weekly: slider % · reset date (Anthropic OAuth only)
 *   line 3: OpenCode Go usage — Session/Weekly/Monthly sliders + reset times (env credentials only)
 *   line 4: cost + token stats (omitted when empty)
 *   line 5: extension statuses (permission mode, mcp, the external statusline command, ...)
 *
 * Colors follow the ccstatusline settings: bright 16-color ANSI, global bold,
 * one space of padding on each side of every widget. They are emitted as raw
 * SGR codes rather than theme tokens on purpose — ccstatusline's colors are
 * terminal-palette colors, not theme colors, and this footer should look the
 * same as the one in Claude Code whatever pi theme is active.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GitChangeCounts } from "./git-info.ts";
import type { OpencodeGoUsageData, OpencodeGoWindow, UsageError, UsageWindowData } from "./usage-providers.ts";

/** Everything the footer reads, behind functions so each render sees live values. */
export interface FooterSources {
	/** Latest extension context, or undefined when none is active (renders a bare footer). */
	ctx(): ExtensionContext | undefined;
	gitBranch(): string | null;
	gitOriginOwner(): string | null;
	gitChanges(): GitChangeCounts | null;
	usage(): UsageWindowData | null;
	goUsage(): OpencodeGoUsageData | null;
	extensionStatuses(): ReadonlyMap<string, string>;
}

/** ccstatusline colors: bright 16-color ANSI SGR codes with `globalBold`. */
const SGR = {
	whiteBright: 97,
	magentaBright: 95,
	cyanBright: 96,
	blueBright: 94,
	greenBright: 92,
	blackBright: 90,
	yellowBright: 93,
	yellow: 33,
} as const;

function paint(color: keyof typeof SGR, text: string): string {
	return `\x1b[1;${SGR[color]}m${text}\x1b[0m`;
}

/** ccstatusline defaultPadding: every widget is wrapped in one space on each side. */
function pad(text: string): string {
	return ` ${text} `;
}

/** Width of ccstatusline slider bars (context bar and usage sliders). */
const SLIDER_WIDTH = 10;

/** Render a ccstatusline-style slider bar: `▓` filled, `░` empty. */
export function makeSliderBar(percent: number, width: number = SLIDER_WIDTH): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** Format a duration like ccstatusline's usage reset timers: `2hr 30m` / `1d 3hr` / `45m`. */
export function formatUsageDuration(durationMs: number, compact = false): string {
	const clampedMs = Math.max(0, durationMs);
	const totalHours = Math.floor(clampedMs / (1000 * 60 * 60));
	const m = Math.floor((clampedMs % (1000 * 60 * 60)) / (1000 * 60));

	const hLabel = compact ? "h" : "hr";
	const joiner = compact ? "" : " ";
	const d = Math.floor(totalHours / 24);
	const h = totalHours % 24;
	const parts = [d > 0 && `${d}d`, h > 0 && `${h}${hLabel}`, m > 0 && `${m}m`].filter(Boolean);
	return parts.length > 0 ? parts.join(joiner) : "0m";
}

/** Format a reset timestamp in compact local time (`MM-DD HH:MM`), ccstatusline absolute+compact style. */
export function formatResetAtCompactLocal(resetAt: string | undefined): string | null {
	if (!resetAt) return null;
	const resetAtMs = Date.parse(resetAt);
	if (Number.isNaN(resetAtMs)) return null;
	const date = new Date(resetAtMs);
	const two = (value: number) => value.toString().padStart(2, "0");
	return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Format token counts for compact display (same thresholds as pi's own footer). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** `~`-abbreviate a path inside the home directory (ccstatusline `abbreviateHome`). */
export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Error badges identical to ccstatusline's usage widgets. */
function usageErrorMessage(error: UsageError): string {
	switch (error) {
		case "no-credentials":
			return "[No credentials]";
		case "timeout":
			return "[Timeout]";
		case "rate-limited":
			return "[Rate limited]";
		case "api-error":
			return "[API Error]";
		case "parse-error":
			return "[Parse Error]";
	}
}

/** Sanitize an extension status for single-line display. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Cumulative usage over the whole session, including pre-compaction entries. */
export type SessionTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
};

/**
 * Whether the active model is billed by subscription rather than per token —
 * pi's own footer rule: OAuth to a provider whose OAuth flow is a subscription,
 * plus Kimi Coding, which is subscription-backed despite API-key auth.
 */
export function isUsingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (model.provider === "kimi-coding") return true;
	try {
		return (
			ctx.modelRegistry.isUsingOAuth(model) &&
			ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true
		);
	} catch {
		return false;
	}
}

export function sumSessionUsage(ctx: ExtensionContext): SessionTotals {
	const totals: SessionTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		latestCacheHitRate: undefined,
	};
	const add = (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { total: number };
	}) => {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost.total;
	};
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			add(entry.message.usage);
			const promptTokens =
				entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
			totals.latestCacheHitRate =
				promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			add(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			add(entry.usage);
		}
	}
	return totals;
}

export class CcStatuslineFooter implements Component {
	private readonly sources: FooterSources;
	private readonly theme: Theme;

	constructor(sources: FooterSources, theme: Theme) {
		this.sources = sources;
		this.theme = theme;
	}

	invalidate(): void {}

	/** Line 1: model, thinking effort, context slider — flex — origin owner, branch, changes, cwd. */
	private renderInfoLine(width: number, ctx: ExtensionContext | undefined): string {
		const left: string[] = [];
		// model widget: brightWhite, raw value (display name, trailing parenthetical stripped)
		const model = ctx?.model;
		const modelName = (model?.name ?? model?.id ?? "no-model").replace(/\s*\(.*\)$/, "");
		left.push(pad(paint("whiteBright", modelName)));
		// thinking-effort widget: brightMagenta, raw value
		if (model?.reasoning) {
			left.push(pad(paint("magentaBright", ctx?.thinkingLevel || "off")));
		}
		// context-bar widget: brightWhite, "slider-only" display (bare bar, no percent)
		// (hidden while usage is unknown, e.g. right after compaction)
		const contextPercent = ctx?.getContextUsage()?.percent;
		if (contextPercent !== null && contextPercent !== undefined) {
			left.push(pad(paint("whiteBright", makeSliderBar(contextPercent))));
		}

		const right: string[] = [];
		// git-origin-owner widget: brightCyan, hidden without a remote
		const owner = this.sources.gitOriginOwner();
		if (owner) right.push(pad(paint("cyanBright", owner)));
		// git-branch widget: brightBlue with ⎇ prefix, hidden outside a repo
		const branch = this.sources.gitBranch();
		if (branch) right.push(pad(paint("blueBright", `⎇ ${branch}`)));
		// git-changes widget: brightGreen (+ins,-del), hidden outside a repo
		const changes = branch ? this.sources.gitChanges() : null;
		if (changes) right.push(pad(paint("greenBright", `(+${changes.insertions},-${changes.deletions})`)));
		// current-working-dir widget: brightBlack, ~-abbreviated
		const cwd = ctx?.cwd ?? process.cwd();
		right.push(pad(paint("blackBright", formatCwd(cwd, process.env.HOME || process.env.USERPROFILE))));

		const leftText = left.join("");
		const rightText = right.join("");
		const leftWidth = visibleWidth(leftText);
		const rightWidth = visibleWidth(rightText);

		// flex-separator: distribute the remaining space between the two groups
		if (leftWidth + rightWidth <= width) {
			return leftText + " ".repeat(width - leftWidth - rightWidth) + rightText;
		}
		return truncateToWidth(leftText + rightText, width, "...");
	}

	/** Line 2: Session slider + block reset timer | Weekly slider + weekly reset date. */
	private renderUsageLine(width: number): string | null {
		const data = this.sources.usage();
		if (!data) return null;

		const now = Date.now();

		// session-usage widget: brightYellow, labeled slider
		let sessionUsage: string | null = null;
		if (data.sessionUsage !== undefined) {
			const percent = Math.max(0, Math.min(100, data.sessionUsage));
			sessionUsage = `Session: ${makeSliderBar(percent)} ${percent.toFixed(1)}%`;
		} else if (data.error) {
			sessionUsage = usageErrorMessage(data.error);
		}

		// reset-timer widget: yellow, raw remaining time until the 5h block resets
		let resetTimer: string | null = null;
		if (!data.error) {
			const resetAtMs = data.sessionResetAt ? Date.parse(data.sessionResetAt) : Number.NaN;
			resetTimer = Number.isNaN(resetAtMs) ? "[Loading]" : formatUsageDuration(resetAtMs - now);
		}

		// weekly-usage widget: brightYellow, labeled slider
		let weeklyUsage: string | null = null;
		if (data.weeklyUsage !== undefined) {
			const percent = Math.max(0, Math.min(100, data.weeklyUsage));
			weeklyUsage = `Weekly: ${makeSliderBar(percent)} ${percent.toFixed(1)}%`;
		}

		// weekly-reset-timer widget: yellow, absolute compact local date
		let weeklyReset: string | null = null;
		if (!data.error) {
			weeklyReset = formatResetAtCompactLocal(data.weeklyResetAt) ?? "[Loading]";
		}

		const leftGroup = [
			sessionUsage && pad(paint("yellowBright", sessionUsage)),
			resetTimer && pad(paint("yellow", resetTimer)),
		]
			.filter(Boolean)
			.join("");
		const rightGroup = [
			weeklyUsage && pad(paint("yellowBright", weeklyUsage)),
			weeklyReset && pad(paint("yellow", weeklyReset)),
		]
			.filter(Boolean)
			.join("");

		if (!leftGroup && !rightGroup) return null;
		// separator widget: brightWhite " | ", only between two rendered groups
		const line =
			leftGroup && rightGroup ? leftGroup + paint("whiteBright", " | ") + rightGroup : leftGroup || rightGroup;
		return truncateToWidth(line, width, "...");
	}

	/** Line 3: OpenCode Go plan usage — rolling 5h, weekly, and monthly windows. */
	private renderGoUsageLine(width: number): string | null {
		const data = this.sources.goUsage();
		if (!data) return null;

		if (data.error) {
			return truncateToWidth(pad(paint("yellowBright", `Session: ${usageErrorMessage(data.error)}`)), width, "...");
		}

		const now = Date.now();
		const windowGroup = (label: string, window: OpencodeGoWindow | undefined, absoluteReset: boolean) => {
			if (!window) return null;
			const percent = Math.max(0, Math.min(100, window.usagePercent));
			const usage = pad(paint("yellowBright", `${label}: ${makeSliderBar(percent)} ${percent.toFixed(1)}%`));
			const reset = absoluteReset
				? formatResetAtCompactLocal(window.resetAt)
				: formatUsageDuration(Date.parse(window.resetAt) - now);
			return usage + (reset ? pad(paint("yellow", reset)) : "");
		};

		const groups = [
			windowGroup("Session", data.rolling, false),
			windowGroup("Weekly", data.weekly, true),
			windowGroup("Monthly", data.monthly, true),
		].filter((group): group is string => Boolean(group));

		if (groups.length === 0) return null;
		return truncateToWidth(groups.join(paint("whiteBright", " | ")), width, "...");
	}

	/** Line 4: cost and token stats, dim. Returns null when there is nothing to show. */
	private renderStatsLine(width: number, ctx: ExtensionContext | undefined): string | null {
		if (!ctx) return null;
		const totals = sumSessionUsage(ctx);

		const parts: string[] = [];
		const usingSubscription = isUsingSubscription(ctx);
		if (totals.cost || usingSubscription) {
			parts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.latestCacheHitRate !== undefined) {
			parts.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
		}

		if (parts.length === 0) return null;
		return truncateToWidth(pad(paint("blackBright", parts.join(" "))), width, "...");
	}

	render(width: number): string[] {
		// The context's getters throw once its runner is retired (session switch,
		// /reload); a footer must degrade to bare, never crash the render loop.
		let ctx: ExtensionContext | undefined;
		try {
			ctx = this.sources.ctx();
			ctx?.cwd;
		} catch {
			ctx = undefined;
		}

		const lines = [this.renderInfoLine(width, ctx)];

		const usageLine = this.renderUsageLine(width);
		if (usageLine !== null) lines.push(usageLine);

		const goUsageLine = this.renderGoUsageLine(width);
		if (goUsageLine !== null) lines.push(goUsageLine);

		let statsLine: string | null = null;
		try {
			statsLine = this.renderStatsLine(width, ctx);
		} catch {
			statsLine = null;
		}
		if (statsLine !== null) lines.push(statsLine);

		// Extension statuses on one line, sorted by key. Identical texts collapse
		// to one chip: loosely-coupled extensions may echo the same state under
		// different keys, which would otherwise render twice.
		const statuses = this.sources.extensionStatuses();
		if (statuses.size > 0) {
			const sorted = Array.from(statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			lines.push(truncateToWidth([...new Set(sorted)].join(" "), width, this.theme.fg("dim", "...")));
		}

		return lines;
	}
}

/**
 * One-line context token counter rendered directly above the prompt input,
 * right-aligned and dim. Shows nothing while the count is unknown (no model,
 * or right after compaction before the next response reports usage).
 */
export class ContextTokenCount implements Component {
	private readonly getTokens: () => number | null | undefined;
	private readonly theme: Theme;

	constructor(getTokens: () => number | null | undefined, theme: Theme) {
		this.getTokens = getTokens;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		let tokens: number | null | undefined;
		try {
			tokens = this.getTokens();
		} catch {
			tokens = undefined;
		}
		if (tokens === null || tokens === undefined) return [];
		// -1 reserves the same right margin the padding below leaves, so a terminal
		// too narrow for the full string clips instead of wrapping.
		const text = this.theme.fg("dim", truncateToWidth(`${formatTokens(tokens)} tokens`, Math.max(0, width - 1)));
		return [" ".repeat(Math.max(0, width - visibleWidth(text) - 1)) + text];
	}
}
