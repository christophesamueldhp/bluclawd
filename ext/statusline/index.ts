/**
 * Statusline extension: `/usage` (Claude Code's name), the session's spend,
 * token totals and Claude plan windows. The footer itself is pistatusline's
 * (ccstatusline as a pi package); this extension only reads the settings that
 * `/usage` and `/status` share — `statusline.subscriptionProviders` and
 * `statusline.currency`.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAgentDir, readStoredCredential, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	formatTokens,
	isUsingSubscription,
	type SessionTotals,
	setSubscriptionProviders,
	sumSessionUsage,
} from "../_shared/session-usage.ts";
import * as forkSettings from "../_shared/settings.ts";
import { COST_CURRENCIES, type CostCurrency, CurrencyRates, formatCost, normalizeCurrency } from "./currency.ts";
import { claudePlanUsage, fetchClaudeUsage, type PlanUsage } from "./usage-providers.ts";

/** Printed when there is no Claude plan to report. */
const CLAUDE_HINT = "Claude plan windows need an Anthropic OAuth login (/login).";

/** Daily USD rates for the cost figure; one table per process, shared by every session. */
const currencyRates = new CurrencyRates({
	cachePath: join(getAgentDir(), "bluclawd", "currency-rates.json"),
	// Bounded: `/usage` waits for this table.
	fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
});
let costCurrency: CostCurrency = "USD";

/** Snapshot rendered by `/usage`. Plain data so it survives in the session file. */
export interface UsageReport {
	model?: string;
	subscription: boolean;
	totals: SessionTotals;
	/** Optional: entries written before 2026-09-07 carry `claude`/`go` fields instead and must still render. */
	plans?: PlanUsage[];
	/** Hints for the sources that had no data, printed when nothing is available. */
	unavailable?: string[];
	/** Absent on entries written before currencies existed: they render in USD. */
	currency?: { code: CostCurrency; rate: number | null };
}

/**
 * The `/usage` report: this session's spend and token totals, followed by
 * whichever plan-usage windows are available. Exported pure for tests; `theme`
 * is the only styling dependency.
 */
export function formatUsageReport(
	report: UsageReport,
	theme: { bold(s: string): string; fg(color: "dim", s: string): string },
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const lines: string[] = [theme.bold("Session usage")];
	const t = report.totals;
	lines.push(`${dim("Model:")} ${report.model ?? "none selected"}`);
	// The amount always says how it is billed, since a subscription total is a
	// notional API-rate equivalent and a per-token one is real spend. No model, no
	// billing to name.
	const billing = report.model ? dim(report.subscription ? " (subscription)" : " (per token)") : "";
	lines.push(
		`${dim("Cost:")} ${formatCost(t.cost, report.currency?.code ?? "USD", report.currency?.rate ?? 1, 4)}${billing}`,
	);
	lines.push(
		`${dim("Tokens:")} ↑${formatTokens(t.input)} in · ↓${formatTokens(t.output)} out · cache read ${formatTokens(t.cacheRead)} · cache write ${formatTokens(t.cacheWrite)}`,
	);
	if (t.latestCacheHitRate !== undefined) {
		lines.push(`${dim("Cache hit (last turn):")} ${t.latestCacheHitRate.toFixed(1)}%`);
	}

	const resetSuffix = (iso: string | undefined): string => {
		if (!iso) return "";
		const at = new Date(iso);
		return Number.isNaN(at.getTime()) ? "" : dim(` (resets ${at.toLocaleString()})`);
	};

	const plans = report.plans ?? [];
	for (const plan of plans) {
		if (plan.windows.length === 0) continue;
		lines.push("", theme.bold(`Plan usage (${plan.source})`));
		for (const window of plan.windows) {
			lines.push(`${dim(`${window.label}:`)} ${window.usagePercent.toFixed(0)}%${resetSuffix(window.resetAt)}`);
		}
	}

	if (plans.length === 0) {
		const provider = report.model?.split("/")[0];
		lines.push("", dim(`No plan usage available${provider ? ` for ${provider}` : ""}.`));
		for (const hint of report.unavailable ?? []) lines.push(dim(hint));
	}
	return lines;
}

export function factory(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// Trust-aware: an untrusted project's settings do not apply.
		const settingsManager = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const statusline = forkSettings.statusline(settingsManager);
		setSubscriptionProviders(statusline?.subscriptionProviders ?? []);
		const currency = statusline?.currency === undefined ? "USD" : normalizeCurrency(statusline.currency);
		if (!currency) {
			ctx.ui.notify(
				`statusline.currency "${statusline?.currency}" is not supported, showing USD. Supported: ${COST_CURRENCIES.join(", ")}.`,
				"warning",
			);
		}
		costCurrency = currency ?? "USD";
	});

	pi.registerEntryRenderer<UsageReport>("bluclawd:usage", (entry, _options, theme) => {
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new Text(entry.data ? formatUsageReport(entry.data, theme).join("\n") : "", 1, 0));
		return container;
	});

	const usageHandler = async (_args: string, ctx: ExtensionContext): Promise<void> => {
		const model = ctx.model;
		const claude = claudePlanUsage(await fetchClaudeUsage(() => readStoredCredential("anthropic")));
		// The first call starts loading the rate table; without one the amount prints in USD.
		currencyRates.rate(costCurrency);
		await currencyRates.settled();
		pi.appendEntry<UsageReport>("bluclawd:usage", {
			model: model ? `${model.provider}/${model.id}` : undefined,
			subscription: isUsingSubscription(ctx),
			totals: sumSessionUsage(ctx),
			plans: claude ? [claude] : [],
			unavailable: claude ? [] : [CLAUDE_HINT],
			currency: { code: costCurrency, rate: currencyRates.rate(costCurrency) },
		});
	};
	pi.registerCommand("usage", {
		description: "Show session cost, token totals, and plan usage",
		handler: usageHandler,
	});
}

const statuslineExtension: InlineExtension = { name: "statusline", factory };
export default statuslineExtension.factory;
