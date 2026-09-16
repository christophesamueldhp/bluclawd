/**
 * Footer component replicating the user's Claude Code ccstatusline configuration
 * (`~/.config/ccstatusline/settings.json`, widget for widget):
 *
 *   line 1: model · thinking effort · context slider (bar only) — flex — origin owner · ⎇ branch · (+ins,-del) · cwd
 *   line 2..n: one plan-usage line per source that has data (Claude subscription
 *              via Anthropic OAuth, OpenCode Go via env credentials, ...) — sliders +
 *              reset times, compacted before truncation when the terminal is narrow
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
import {
	type ExtensionContext,
	estimateTokens,
	sessionEntryToContextMessages,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sharedRef } from "../_shared/global-state.ts";
import type { GitChangeCounts } from "./git-info.ts";
import type { PlanUsage, UsageError } from "./usage-providers.ts";

/** Everything the footer reads, behind functions so each render sees live values. */
export interface FooterSources {
	/** Latest extension context, or undefined when none is active (renders a bare footer). */
	ctx(): ExtensionContext | undefined;
	gitBranch(): string | null;
	gitOriginOwner(): string | null;
	gitChanges(): GitChangeCounts | null;
	/** Every plan-usage source that currently has data, in display order. */
	planUsage(): readonly PlanUsage[];
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

/** Fixed lead-in order for the extension-statuses line: permission mode reads
 * before the mcp server/tool count, matching Claude Code. Keys not listed here
 * fall back to alphabetical order after these. */
const STATUS_KEY_ORDER: readonly string[] = ["mode", "mcp"];

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
/** One plan-usage widget pair, already painted: the labeled slider and its optional reset text. */
export type UsageGroup = { usage: string; reset?: string };

/**
 * Fit plan-usage groups into `width`, dropping detail before cutting text: full
 * line → fewer trailing windows, reset times kept → all windows without reset
 * times → fewer trailing windows without them → truncated as a last resort. A
 * line that fits is never touched.
 *
 * Detail goes before breadth because "when does it reset" is what the line is
 * for: at the ~85 columns a typical terminal has, keeping the reset times costs
 * the trailing window and leaves exactly the Session + Weekly pair ccstatusline
 * shows. The dropped window is still in `/usage`.
 */
export function fitUsageGroups(groups: readonly UsageGroup[], width: number, separator: string): string {
	const join = (items: readonly UsageGroup[], withReset: boolean) =>
		items.map((g) => g.usage + (withReset ? (g.reset ?? "") : "")).join(separator);
	for (const withReset of [true, false]) {
		for (let kept = groups.length; kept > 0; kept--) {
			const line = join(groups.slice(0, kept), withReset);
			if (visibleWidth(line) <= width) return line;
		}
	}
	return truncateToWidth(join(groups.slice(0, 1), false), width, "...");
}

/** Context usage as the slider and token counter show it. */
export type DisplayContextUsage = { tokens: number; percent: number; approximate: boolean };

let contextEstimate: { key: string; usage: DisplayContextUsage } | undefined;

/**
 * Context usage for the slider and the token counter. After a compaction pi
 * reports the count as unknown until the next response, which used to blank
 * both widgets right when the user wants to see how much the compaction freed.
 * Instead, estimate the compacted context — system prompt plus the messages
 * still in context, at pi's own chars/4 rate — and mark it approximate. Cached
 * per session leaf because walking the context on every render is not free.
 */
export function resolveContextUsage(ctx: ExtensionContext): DisplayContextUsage | undefined {
	const usage = ctx.getContextUsage();
	if (!usage) return undefined;
	if (usage.tokens !== null && usage.percent !== null) {
		return { tokens: usage.tokens, percent: usage.percent, approximate: false };
	}
	const key = `${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getLeafId()}:${usage.contextWindow}`;
	if (contextEstimate?.key !== key) {
		let tokens = Math.ceil(ctx.getSystemPrompt().length / 4);
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			for (const message of sessionEntryToContextMessages(entry)) tokens += estimateTokens(message);
		}
		contextEstimate = { key, usage: { tokens, percent: (tokens / usage.contextWindow) * 100, approximate: true } };
	}
	return contextEstimate.usage;
}

export type SessionTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
};

/** Providers billed by subscription despite API-key auth, so pi's OAuth rule never sees them. */
const BUILTIN_SUBSCRIPTION_PROVIDERS: readonly string[] = ["kimi-coding", "opencode-go"];

/**
 * `statusline.subscriptionProviders` from settings. A sharedRef, not a module
 * `let`: `diagnostics` imports this file for `/status` inside its own module
 * graph and would otherwise never see what `statusline` set.
 */
const configuredSubscriptionProviders = sharedRef<readonly string[]>("statusline.subscriptionProviders", []);

export function setSubscriptionProviders(providers: readonly string[]): void {
	configuredSubscriptionProviders.set([...providers]);
}

/**
 * Whether the active model is billed by subscription rather than per token —
 * pi's own footer rule (OAuth to a provider whose OAuth flow is a subscription)
 * plus the built-in and configured subscription providers above.
 */
export function isUsingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (BUILTIN_SUBSCRIPTION_PROVIDERS.includes(model.provider)) return true;
	if (configuredSubscriptionProviders.get().includes(model.provider)) return true;
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
		const contextUsage = ctx && resolveContextUsage(ctx);
		if (contextUsage) {
			left.push(pad(paint("whiteBright", makeSliderBar(contextUsage.percent))));
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

	/**
	 * One plan-usage line: `Label: slider pct%  reset` per window, ` | ` between.
	 * An errored source renders as `Source: [API Error]` so the failing poller is
	 * named. Compacted by {@link fitUsageGroups} before anything is truncated.
	 */
	private renderPlanUsageLine(usage: PlanUsage, width: number): string | null {
		if (usage.error) {
			return truncateToWidth(
				pad(paint("yellowBright", `${usage.source}: ${usageErrorMessage(usage.error)}`)),
				width,
				"...",
			);
		}
		const now = Date.now();
		const groups: UsageGroup[] = usage.windows.map((window) => {
			const percent = Math.max(0, Math.min(100, window.usagePercent));
			let reset: string | null = null;
			if (window.resetAt) {
				if (window.resetStyle === "countdown") {
					const resetAtMs = Date.parse(window.resetAt);
					reset = Number.isNaN(resetAtMs) ? null : formatUsageDuration(resetAtMs - now);
				} else {
					reset = formatResetAtCompactLocal(window.resetAt);
				}
			}
			if (reset === null && usage.loading) reset = "[Loading]";
			return {
				usage: pad(paint("yellowBright", `${window.label}: ${makeSliderBar(percent)} ${percent.toFixed(1)}%`)),
				reset: reset === null ? undefined : pad(paint("yellow", reset)),
			};
		});
		if (groups.length === 0) return null;
		return fitUsageGroups(groups, width, paint("whiteBright", " | "));
	}

	/** Line 4: cost and token stats, dim. Returns null when there is nothing to show. */
	private renderStatsLine(width: number, ctx: ExtensionContext | undefined): string | null {
		if (!ctx) return null;
		const totals = sumSessionUsage(ctx);

		const parts: string[] = [];
		// The marker is the dollar figure's unit, so it is always named: under a
		// subscription the amount is what the tokens would have cost at API rates,
		// otherwise it is what the session actually costs. With no model there is no
		// billing to name, so the bare figure shows only once something was spent.
		if (ctx.model) {
			parts.push(`$${totals.cost.toFixed(3)} (${isUsingSubscription(ctx) ? "subscription" : "per token"})`);
		} else if (totals.cost) {
			parts.push(`$${totals.cost.toFixed(3)}`);
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

		for (const usage of this.sources.planUsage()) {
			const line = this.renderPlanUsageLine(usage, width);
			if (line !== null) lines.push(line);
		}

		let statsLine: string | null = null;
		try {
			statsLine = this.renderStatsLine(width, ctx);
		} catch {
			statsLine = null;
		}
		if (statsLine !== null) lines.push(statsLine);

		// Extension statuses on one line: "mode" before "mcp" (Claude Code's own
		// order), everything else alphabetical by key. Identical texts collapse to
		// one chip: loosely-coupled extensions may echo the same state under
		// different keys, which would otherwise render twice.
		const statuses = this.sources.extensionStatuses();
		if (statuses.size > 0) {
			const rank = (key: string) => {
				const index = STATUS_KEY_ORDER.indexOf(key);
				return index === -1 ? STATUS_KEY_ORDER.length : index;
			};
			const sorted = Array.from(statuses.entries())
				.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			lines.push(truncateToWidth([...new Set(sorted)].join(" "), width, this.theme.fg("dim", "...")));
		}

		return lines;
	}
}

/**
 * One-line context token counter rendered directly above the prompt input,
 * right-aligned and dim, `~`-prefixed when the count is an estimate. Shows
 * nothing while there is no count at all (no model).
 */
export class ContextTokenCount implements Component {
	private readonly getUsage: () => DisplayContextUsage | undefined;
	private readonly theme: Theme;

	constructor(getUsage: () => DisplayContextUsage | undefined, theme: Theme) {
		this.getUsage = getUsage;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		let usage: DisplayContextUsage | undefined;
		try {
			usage = this.getUsage();
		} catch {
			usage = undefined;
		}
		if (!usage) return [];
		const label = `${usage.approximate ? "~" : ""}${formatTokens(usage.tokens)} tokens`;
		// -1 reserves the same right margin the padding below leaves, so a terminal
		// too narrow for the full string clips instead of wrapping.
		const text = this.theme.fg("dim", truncateToWidth(label, Math.max(0, width - 1)));
		return [" ".repeat(Math.max(0, width - visibleWidth(text) - 1)) + text];
	}
}
