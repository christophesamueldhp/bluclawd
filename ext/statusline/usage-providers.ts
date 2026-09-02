/**
 * Plan-usage data sources for the ccstatusline-style footer.
 *
 * Two independent pollers, both optional at runtime:
 *  - `UsageDataProvider` — Claude subscription usage (5h block + 7-day window)
 *    from the Anthropic OAuth usage API, the same endpoint ccstatusline's
 *    `session-usage`/`weekly-usage` widgets read. Returns null (line hidden)
 *    unless an Anthropic OAuth credential exists in pi's auth store — bluclawd
 *    is multi-provider, so API-key and other-provider users never see a
 *    "[No credentials]" badge.
 *  - `OpencodeGoUsageProvider` — OpenCode Go plan usage (rolling 5h / weekly /
 *    monthly), scraped from the workspace dashboard because no public usage API
 *    exists. Follows opencode-quota's approach and reuses its env variable
 *    names: OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE (the browser
 *    `auth` cookie). Returns null when either is missing.
 *
 * Neither poller keeps the process alive (`unref`), and a failed fetch surfaces
 * as an error badge rather than a throw.
 */

/** Anthropic OAuth usage windows, mirroring the `five_hour` and `seven_day` buckets. */
export type UsageWindowData = {
	/** 5-hour block utilization percent (0-100). */
	sessionUsage?: number;
	/** ISO timestamp when the 5-hour block resets. */
	sessionResetAt?: string;
	/** 7-day window utilization percent (0-100). */
	weeklyUsage?: number;
	/** ISO timestamp when the 7-day window resets. */
	weeklyResetAt?: string;
	error?: UsageError;
};

export type UsageError = "no-credentials" | "timeout" | "rate-limited" | "api-error" | "parse-error";

const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_API_TIMEOUT_MS = 5000;
const REFRESH_INTERVAL_MS = 60_000;

type UsageApiBucket = { utilization?: number | null; resets_at?: string | null } | null | undefined;

function bucketUtilization(bucket: UsageApiBucket): number | undefined {
	if (bucket === null) return 0;
	return bucket?.utilization ?? undefined;
}

/** The shape of a stored credential this file cares about; pi's own type is wider. */
export type StoredCredentialLike = { type?: string; access?: string } | undefined;

/** Returns the stored Anthropic credential, or undefined. May be sync or async. */
export type ReadAnthropicCredential = () => StoredCredentialLike | Promise<StoredCredentialLike>;

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

abstract class PollingProvider<T> {
	private data: T | null = null;
	private changeCallbacks = new Set<() => void>();
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	protected fetchInFlight = false;
	protected disposed = false;

	/** Latest data, or null when the source is not configured. */
	getUsageData(): T | null {
		return this.data;
	}

	/** Subscribe to data changes. Returns an unsubscribe function. */
	onChange(callback: () => void): () => void {
		this.changeCallbacks.add(callback);
		return () => this.changeCallbacks.delete(callback);
	}

	/** Fetch immediately and start the periodic refresh. */
	start(): void {
		if (this.disposed || this.refreshTimer) return;
		void this.refresh();
		this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
		this.refreshTimer.unref?.();
	}

	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.changeCallbacks.clear();
	}

	protected setData(next: T | null): void {
		if (JSON.stringify(next) === JSON.stringify(this.data)) return;
		this.data = next;
		for (const cb of this.changeCallbacks) cb();
	}

	protected abstract refresh(): Promise<void>;
}

/** Claude subscription usage (5h block + weekly window) via the Anthropic OAuth usage API. */
export class UsageDataProvider extends PollingProvider<UsageWindowData> {
	private readCredential: ReadAnthropicCredential;

	constructor(readCredential: ReadAnthropicCredential) {
		super();
		this.readCredential = readCredential;
	}

	private async getAccessToken(): Promise<string | null> {
		try {
			const cred = await this.readCredential();
			return cred?.type === "oauth" && cred.access ? cred.access : null;
		} catch {
			return null;
		}
	}

	protected async refresh(): Promise<void> {
		if (this.disposed || this.fetchInFlight) return;

		// Awaited on purpose: a Promise here is always truthy, and the guard below
		// would then fetch with "Bearer [object Promise]" and show [API Error] for
		// every API-key-only user (this exact bug shipped once).
		const token = await this.getAccessToken();
		if (!token) {
			this.setData(null);
			return;
		}

		this.fetchInFlight = true;
		try {
			const response = await fetch(USAGE_API_URL, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					"anthropic-beta": "oauth-2025-04-20",
				},
				signal: AbortSignal.timeout(USAGE_API_TIMEOUT_MS),
			});
			if (this.disposed) return;
			if (!response.ok) {
				this.setData({ error: response.status === 429 ? "rate-limited" : "api-error" });
				return;
			}
			let parsed: { five_hour?: UsageApiBucket; seven_day?: UsageApiBucket };
			try {
				parsed = (await response.json()) as typeof parsed;
			} catch {
				this.setData({ error: "parse-error" });
				return;
			}
			this.setData({
				sessionUsage: bucketUtilization(parsed.five_hour),
				sessionResetAt: parsed.five_hour?.resets_at ?? undefined,
				weeklyUsage: bucketUtilization(parsed.seven_day),
				weeklyResetAt: parsed.seven_day?.resets_at ?? undefined,
			});
		} catch (error) {
			if (this.disposed) return;
			this.setData({ error: isTimeoutError(error) ? "timeout" : "api-error" });
		} finally {
			this.fetchInFlight = false;
		}
	}
}

// ============================================================================
// OpenCode Go
// ============================================================================

/** One OpenCode Go usage window (rolling 5h / weekly / monthly). */
export type OpencodeGoWindow = {
	/** Utilization percent (0-100). */
	usagePercent: number;
	/** ISO timestamp when the window resets. */
	resetAt: string;
};

/** OpenCode Go plan usage, scraped from the workspace dashboard. */
export type OpencodeGoUsageData = {
	rolling?: OpencodeGoWindow;
	weekly?: OpencodeGoWindow;
	monthly?: OpencodeGoWindow;
	error?: UsageError;
};

type OpencodeGoWindowKey = "rolling" | "weekly" | "monthly";

const OPENCODE_GO_TIMEOUT_MS = 10_000;
const OPENCODE_GO_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

/** SolidJS SSR hydration pattern: `<window>Usage:$R[n]={...usagePercent:X...resetInSec:Y...}` (field order varies). */
function parseSsrWindow(html: string, windowName: string): OpencodeGoWindow | null {
	const num = String.raw`(-?\d+(?:\.\d+)?)`;
	const pctFirst = new RegExp(
		String.raw`${windowName}Usage:\$R\[\d+\]=\{[^}]*usagePercent:${num}[^}]*resetInSec:${num}[^}]*\}`,
	).exec(html);
	const resetFirst = new RegExp(
		String.raw`${windowName}Usage:\$R\[\d+\]=\{[^}]*resetInSec:${num}[^}]*usagePercent:${num}[^}]*\}`,
	).exec(html);
	const usagePercent = Number(pctFirst?.[1] ?? resetFirst?.[2]);
	const resetInSec = Number(pctFirst?.[2] ?? resetFirst?.[1]);
	if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSec)) return null;
	return {
		usagePercent: Math.max(0, usagePercent),
		resetAt: new Date(Date.now() + Math.max(0, resetInSec) * 1000).toISOString(),
	};
}

/** Parse human-readable reset times from the data-slot format, e.g. `1 hour 56 minutes`, `6 days 2 hours`. */
function parseHumanReadableSeconds(text: string): number | null {
	const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
	if (/^(reset[- ]now|now|resets now)$/.test(normalized)) return 0;
	let total = 0;
	let matched = false;
	for (const [unit, seconds] of [
		["days?", 86400],
		["hours?", 3600],
		["minutes?", 60],
		["seconds?", 1],
	] as const) {
		const match = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${unit}`).exec(normalized);
		if (match?.[1]) {
			total += Number(match[1]) * seconds;
			matched = true;
		}
	}
	return matched ? total : null;
}

/** Newer dashboard format: `data-slot="usage-item"` blocks with label/value/reset-time slots. */
function parseDataSlotWindows(html: string): Partial<Record<OpencodeGoWindowKey, OpencodeGoWindow>> {
	const result: Partial<Record<OpencodeGoWindowKey, OpencodeGoWindow>> = {};
	const items = html.split(/data-slot="usage-item"/).slice(1);
	for (const content of items) {
		const label = /data-slot="usage-label">([^<]+)</.exec(content)?.[1]?.trim().toLowerCase();
		const windowKey: OpencodeGoWindowKey | null = label?.includes("rolling")
			? "rolling"
			: label?.includes("weekly")
				? "weekly"
				: label?.includes("monthly")
					? "monthly"
					: null;
		if (!windowKey) continue;
		const usageMatch = /data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/.exec(content);
		const resetMatch = /data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/.exec(content);
		if (!usageMatch?.[1] || !resetMatch) continue;
		const resetText = (resetMatch[2] ?? "")
			.replace(/<!--\$-->|<!--\/-->/g, "")
			.replace(/Resets?\s*in\s*/i, "")
			.trim();
		const resetInSec = resetMatch[1] === "reset-now" ? 0 : parseHumanReadableSeconds(resetText);
		const usagePercent = Number(usageMatch[1]);
		if (!Number.isFinite(usagePercent) || resetInSec === null) continue;
		result[windowKey] = {
			usagePercent: Math.max(0, usagePercent),
			resetAt: new Date(Date.now() + resetInSec * 1000).toISOString(),
		};
	}
	return result;
}

/** Parse the OpenCode Go dashboard HTML (SSR hydration first, data-slot fallback). Exported for tests. */
export function parseOpencodeGoDashboard(html: string): OpencodeGoUsageData | null {
	let rolling = parseSsrWindow(html, "rolling");
	let weekly = parseSsrWindow(html, "weekly");
	let monthly = parseSsrWindow(html, "monthly");
	if (!rolling && !weekly && !monthly) {
		const slots = parseDataSlotWindows(html);
		rolling = slots.rolling ?? null;
		weekly = slots.weekly ?? null;
		monthly = slots.monthly ?? null;
	}
	if (!rolling && !weekly && !monthly) return null;
	return {
		...(rolling ? { rolling } : {}),
		...(weekly ? { weekly } : {}),
		...(monthly ? { monthly } : {}),
	};
}

/** OpenCode Go plan usage, polled from the workspace dashboard with env credentials. */
export class OpencodeGoUsageProvider extends PollingProvider<OpencodeGoUsageData> {
	protected async refresh(): Promise<void> {
		if (this.disposed || this.fetchInFlight) return;

		const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
		const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
		if (!workspaceId || !authCookie) {
			this.setData(null);
			return;
		}

		this.fetchInFlight = true;
		try {
			const response = await fetch(`https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`, {
				method: "GET",
				headers: {
					"User-Agent": OPENCODE_GO_USER_AGENT,
					Accept: "text/html",
					Cookie: `auth=${authCookie}`,
				},
				signal: AbortSignal.timeout(OPENCODE_GO_TIMEOUT_MS),
			});
			if (this.disposed) return;
			if (!response.ok) {
				this.setData({ error: response.status === 429 ? "rate-limited" : "api-error" });
				return;
			}
			const parsed = parseOpencodeGoDashboard(await response.text());
			this.setData(parsed ?? { error: "parse-error" });
		} catch (error) {
			if (this.disposed) return;
			this.setData({ error: isTimeoutError(error) ? "timeout" : "api-error" });
		} finally {
			this.fetchInFlight = false;
		}
	}
}
