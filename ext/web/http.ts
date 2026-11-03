/**
 * Shared HTTP plumbing for the search providers: one retry for a transient failure, and
 * failures sorted into what a caller does next.
 */

/**
 * `transient`: rate limited, server error or network failure, worth one retry.
 * `unavailable`: the provider cannot serve this user now (key, credits, login): try the other one.
 * `invalid`: the request itself is wrong; neither a retry nor the other provider helps.
 */
export type FailureKind = "transient" | "unavailable" | "invalid";

export class WebError extends Error {
	readonly kind: FailureKind;
	readonly retryAfterMs: number | undefined;

	constructor(message: string, kind: FailureKind, retryAfterMs?: number) {
		super(message);
		this.kind = kind;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface HttpDeps {
	fetch: typeof fetch;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const defaultDeps: HttpDeps = {
	fetch: (input, init) => fetch(input, init),
	sleep: (ms, signal) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason);
				},
				{ once: true },
			);
		}),
};

const RETRY_DELAY_MS = 1000;
const MAX_RETRY_AFTER_MS = 10_000;

export function failureKind(status: number): FailureKind {
	if (status === 429 || status >= 500) return "transient";
	if (status === 401 || status === 402 || status === 403) return "unavailable";
	return "invalid";
}

function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (header === null) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * POST `body` as JSON, retrying once on a transient failure. A non-2xx response becomes a
 * WebError whose message is `describe(status, text)`.
 */
export async function postJson(
	deps: HttpDeps,
	url: string,
	headers: Record<string, string>,
	body: unknown,
	describe: (status: number, text: string) => string,
	signal?: AbortSignal,
): Promise<Response> {
	const attempt = async (): Promise<Response> => {
		let response: Response;
		try {
			response = await deps.fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new WebError(`network error: ${error instanceof Error ? error.message : String(error)}`, "transient");
		}
		if (response.ok) return response;
		const text = await response.text().catch(() => "");
		throw new WebError(describe(response.status, text), failureKind(response.status), retryAfterMs(response));
	};
	try {
		return await attempt();
	} catch (error) {
		if (!(error instanceof WebError) || error.kind !== "transient") throw error;
		await deps.sleep(error.retryAfterMs ?? RETRY_DELAY_MS, signal);
		return attempt();
	}
}
