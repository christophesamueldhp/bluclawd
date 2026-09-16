/**
 * `webfetch` settings. Read per call, like websearch's.
 *
 * Keys that widen what a fetch can reach or send are honoured from the USER
 * settings file only, never from a project's, trusted or not: `allowRanges`
 * opens private addresses, `hosts` attaches secrets to requests, and `fallbacks`
 * hands URLs to third parties. A repository must not be able to switch any of
 * those on for whoever opens it. `timeoutSeconds` is harmless and merges.
 *
 * Example (~/.pi/agent/settings.json):
 *   "webfetch": {
 *     "timeoutSeconds": 60,
 *     "allowRanges": ["198.18.0.0/15"],
 *     "hosts": { "intranet.example.com": { "headersEnv": { "Cookie": "INTRANET_COOKIE" } } },
 *     "fallbacks": { "remote": true }
 *   }
 */

import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface WebfetchSettings {
	timeoutSeconds?: number;
	allowRanges?: string[];
	/** Per exact host: request header name -> environment variable holding its value. */
	hosts?: Record<string, { headersEnv?: Record<string, string> }>;
	/** Let a hosted reader (Jina Reader; Firecrawl when FIRECRAWL_API_KEY is set) retry a page that came back empty. */
	fallbacks?: { remote?: boolean };
}

const MAX_TIMEOUT_SECONDS = 300;

export interface WebfetchConfig {
	timeoutMs?: number;
	allowRanges: string[];
	remoteFallbacks: boolean;
	headersFor(host: string): Record<string, string> | undefined;
}

function section(value: unknown): WebfetchSettings {
	const webfetch = (value as { webfetch?: unknown } | undefined)?.webfetch;
	return webfetch && typeof webfetch === "object" ? (webfetch as WebfetchSettings) : {};
}

export function webfetchConfig(sm: SettingsManager, env: NodeJS.ProcessEnv = process.env): WebfetchConfig {
	const user = section(sm.getGlobalSettings());
	const project = section(sm.getProjectSettings());
	const seconds = project.timeoutSeconds ?? user.timeoutSeconds;
	return {
		timeoutMs: typeof seconds === "number" && seconds > 0 ? Math.min(seconds, MAX_TIMEOUT_SECONDS) * 1000 : undefined,
		allowRanges: Array.isArray(user.allowRanges) ? user.allowRanges.filter((r) => typeof r === "string") : [],
		remoteFallbacks: user.fallbacks?.remote === true,
		headersFor(host) {
			const spec = user.hosts?.[host.toLowerCase()]?.headersEnv;
			if (!spec) return undefined;
			const headers: Record<string, string> = {};
			for (const [name, envVar] of Object.entries(spec)) {
				const value = env[envVar];
				if (value) headers[name] = value;
			}
			return Object.keys(headers).length > 0 ? headers : undefined;
		},
	};
}
