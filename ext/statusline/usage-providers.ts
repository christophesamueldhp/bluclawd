/**
 * Claude subscription usage (5h block + 7-day window) for `/usage`, from the
 * Anthropic OAuth usage API that ccstatusline's `session-usage`/`weekly-usage`
 * widgets read. Nothing is fetched unless an Anthropic OAuth credential exists
 * in pi's auth store: bluclawd is multi-provider, and API-key and
 * other-provider users have no plan to report.
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

export type UsageError = "timeout" | "rate-limited" | "api-error" | "parse-error";

const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_API_TIMEOUT_MS = 5000;

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

/** The current Claude plan windows, or null without an Anthropic OAuth login. */
export async function fetchClaudeUsage(readCredential: ReadAnthropicCredential): Promise<UsageWindowData | null> {
	let token: string | null = null;
	try {
		// Awaited on purpose: a Promise here is always truthy, and the guard below
		// would then fetch with "Bearer [object Promise]" and report an API error
		// for every API-key-only user (this exact bug shipped once).
		const cred = await readCredential();
		token = cred?.type === "oauth" && cred.access ? cred.access : null;
	} catch {
		token = null;
	}
	if (!token) return null;

	try {
		const response = await fetch(USAGE_API_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(USAGE_API_TIMEOUT_MS),
		});
		if (!response.ok) return { error: response.status === 429 ? "rate-limited" : "api-error" };
		let parsed: { five_hour?: UsageApiBucket; seven_day?: UsageApiBucket };
		try {
			parsed = (await response.json()) as typeof parsed;
		} catch {
			return { error: "parse-error" };
		}
		return {
			sessionUsage: bucketUtilization(parsed.five_hour),
			sessionResetAt: parsed.five_hour?.resets_at ?? undefined,
			weeklyUsage: bucketUtilization(parsed.seven_day),
			weeklyResetAt: parsed.seven_day?.resets_at ?? undefined,
		};
	} catch (error) {
		return { error: isTimeoutError(error) ? "timeout" : "api-error" };
	}
}

/**
 * Provider-neutral plan usage, the shape `/usage` renders. `/usage` entries saved
 * in session files keep this shape, so it stays wider than the Claude source needs.
 */
export type PlanUsageWindow = {
	label: string;
	/** Utilization percent, 0-100. */
	usagePercent: number;
	/** ISO timestamp of the next reset, when the source reports one. */
	resetAt?: string;
};

export type PlanUsage = {
	/** Source name ("Claude"). */
	source: string;
	windows: PlanUsageWindow[];
	error?: UsageError;
};

export function claudePlanUsage(data: UsageWindowData | null): PlanUsage | null {
	if (!data) return null;
	const windows: PlanUsageWindow[] = [];
	if (data.sessionUsage !== undefined) {
		windows.push({ label: "Session", usagePercent: data.sessionUsage, resetAt: data.sessionResetAt });
	}
	if (data.weeklyUsage !== undefined) {
		windows.push({ label: "Weekly", usagePercent: data.weeklyUsage, resetAt: data.weeklyResetAt });
	}
	return { source: "Claude", windows, error: data.error };
}
