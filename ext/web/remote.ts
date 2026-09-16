/**
 * Hosted readers `webfetch` may ask for a page it could not read itself: one
 * blocked by a bot wall (403/429/503) or one that renders its text with
 * JavaScript. Opt-in only (settings `webfetch.fallbacks.remote`, user settings):
 * the URL goes to a third party, which is exactly what a `WebFetch(domain:…)`
 * approval did not cover.
 *
 * Firecrawl when FIRECRAWL_API_KEY is set, then Jina Reader (keyless, or
 * JINA_API_KEY for its higher limits). Request shapes follow pi-web-access (MIT).
 */

import { USER_AGENT } from "./search.ts";

const TIMEOUT_MS = 60_000;

export interface RemoteRead {
	text: string;
	provider: "firecrawl" | "jina";
}

async function firecrawl(url: string, apiKey: string, fetchImpl: typeof fetch, signal: AbortSignal) {
	const res = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
		body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
		signal,
		redirect: "manual",
	});
	if (!res.ok) return undefined;
	const data = (await res.json()) as { data?: { markdown?: unknown } };
	return typeof data.data?.markdown === "string" ? data.data.markdown : undefined;
}

async function jina(url: string, apiKey: string | undefined, fetchImpl: typeof fetch, signal: AbortSignal) {
	const res = await fetchImpl(`https://r.jina.ai/${url}`, {
		headers: {
			Accept: "text/plain",
			"X-Return-Format": "markdown",
			"User-Agent": USER_AGENT,
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		signal,
		redirect: "manual",
	});
	return res.ok ? await res.text() : undefined;
}

/** The page's text from the first hosted reader that returns some, or undefined. Throws only on abort. */
export async function remoteRead(
	url: string,
	opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<RemoteRead | undefined> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const env = opts.env ?? process.env;
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	const attempts: Array<[RemoteRead["provider"], () => Promise<string | undefined>]> = [];
	if (env.FIRECRAWL_API_KEY)
		attempts.push(["firecrawl", () => firecrawl(url, env.FIRECRAWL_API_KEY as string, fetchImpl, signal)]);
	attempts.push(["jina", () => jina(url, env.JINA_API_KEY, fetchImpl, signal)]);
	for (const [provider, attempt] of attempts) {
		try {
			const text = (await attempt())?.trim();
			if (text) return { text, provider };
		} catch (err) {
			if (opts.signal?.aborted) throw err;
		}
	}
	return undefined;
}
