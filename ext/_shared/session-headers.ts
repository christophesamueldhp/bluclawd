/**
 * The per-session headers pi's own agent loop adds for OpenCode (provider-attribution.ts,
 * not exported): OpenCode Go refuses a request without `x-opencode-session`. Any
 * extension that calls a model directly needs them.
 */
export function sessionHeaders(
	model: { provider: string; baseUrl: string },
	sessionId: string,
): Record<string, string> {
	let host = "";
	try {
		host = new URL(model.baseUrl).hostname;
	} catch {
		// No usable base URL: decide by provider name alone.
	}
	const opencode = model.provider === "opencode" || model.provider === "opencode-go" || host === "opencode.ai";
	return opencode && sessionId ? { "x-opencode-session": sessionId, "x-opencode-client": "pi" } : {};
}
