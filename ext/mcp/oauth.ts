/**
 * OAuth for remote MCP servers — audit item B.5.
 *
 * The SDK ships the whole OAuth2 client (discovery, dynamic client registration,
 * PKCE, exchange, refresh, 401-retry). This module supplies only the two things it
 * cannot: somewhere to persist credentials, and a way to reach a browser.
 *
 * Like client.ts this imports the SDK, so it is reached by dynamic `import()` only —
 * schema.ts stays SDK-free and the startup path stays light.
 *
 * TRUST NOTE: the flow runs only from `/mcp login`. A project mcp.json may point
 * `url` at any host, and auto-flow-on-401 would let configuration rather than the
 * user decide which login page opens. Two independent guards enforce this:
 *   1. connectServer() is handed a provider only when a credential already exists
 *      (authProviderFor), and
 *   2. redirectToAuthorization() and saveClientInformation() refuse outright unless
 *      a flow is in progress.
 * Guard 2 exists because guard 1 alone once rested on redirectUrl being "" — which
 * silently disabled token refresh as well. Do not reintroduce that coupling.
 *
 * The authorization URL itself is remote-controlled, so it is scheme-checked before
 * ever reaching the OS opener — see assertOpenableAuthorizationUrl.
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
	type OAuthClientInformation,
	OAuthClientInformationSchema,
	type OAuthClientMetadata,
	type OAuthTokens,
	OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpCredentialStore, McpOAuthCredential } from "./credential-store.ts";
import type { ServerConfig } from "./schema.ts";

/** How long a pending browser login may stay open before the listener gives up. */
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Stand-in redirect URI used outside an active login. See the redirectUrl getter:
 * an empty value makes the SDK skip token refresh, so this must be non-empty.
 */
const PLACEHOLDER_REDIRECT_URL = "http://127.0.0.1/callback";

/**
 * Refuse to hand a non-web URL to the platform opener.
 *
 * The authorization endpoint arrives in the REMOTE server's discovery document,
 * and openBrowser() passes it to `open(1)` / `rundll32` / `xdg-open`, which launch
 * whatever handler the scheme maps to — `file://` can start a .app bundle, and
 * `smb:`/`vscode:`/`itms-apps:` reach other local handlers. The SDK's own schema is
 * a denylist (it rejects only javascript:/data:/vbscript:), so it accepts all of
 * these. Adding an MCP server is giving bluclawd a URL, not consenting to run code,
 * and the 401 hint actively invites the user to start this flow — so the check
 * belongs here, before anything is launched.
 */
export function assertOpenableAuthorizationUrl(url: URL, server: string): void {
	const isLoopbackHttp =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
	if (url.protocol !== "https:" && !isLoopbackHttp) {
		throw new Error(
			`server "${server}" asked to open a non-HTTPS authorization URL (${url.protocol}); refusing. ` +
				"Only https, or http on loopback, may be opened.",
		);
	}
}

export interface McpOAuthProviderOptions {
	storage: McpCredentialStore;
	server: string;
	serverUrl: string;
	/** Without a UI there is no one to complete a browser flow; redirect throws. */
	hasUI: boolean;
	openBrowser: (url: string) => Promise<void>;
}

/**
 * Implements the SDK's OAuthClientProvider over the MCP credential store.
 *
 * The PKCE verifier is deliberately in-memory only: it is worthless once the code
 * is exchanged, so persisting it would widen the on-disk secret surface for nothing.
 */
export class McpOAuthProvider {
	private readonly opts: McpOAuthProviderOptions;
	private verifier: string | undefined;

	constructor(opts: McpOAuthProviderOptions) {
		this.opts = opts;
	}

	/**
	 * A stored credential counts only for the origin it was issued to. If mcp.json
	 * repoints this server name at another host, the token must not follow it —
	 * the mismatch reads as "not logged in" and forces a fresh, explicit login.
	 */
	private read(): McpOAuthCredential | undefined {
		const cred = this.opts.storage.get(this.opts.server);
		if (!cred) return undefined;
		return cred.serverUrl === this.opts.serverUrl ? cred : undefined;
	}

	private write(patch: Partial<McpOAuthCredential>): void {
		const current = this.read();
		this.opts.storage.set(this.opts.server, {
			serverUrl: this.opts.serverUrl,
			client: current?.client,
			tokens: current?.tokens,
			...patch,
		});
	}

	/** Bound together once the loopback listener is up; both are per-flow. */
	private flow: { redirectUrl: string; state: string; startTimeout?: () => void } | undefined;

	/**
	 * Attach this provider to a pending callback listener. The redirect URI cannot
	 * be known until the OS assigns a port, and the state must be the same value the
	 * listener will verify — so they are set as one step, never independently.
	 */
	beginFlow(
		callback: Pick<CallbackServer, "redirectUrl" | "state"> & {
			startTimeout?: () => void;
		},
	): void {
		this.flow = {
			redirectUrl: callback.redirectUrl,
			state: callback.state,
			startTimeout: callback.startTimeout,
		};
	}

	/**
	 * Outside a login flow this reports a placeholder rather than "".
	 *
	 * The SDK reads an empty redirectUrl as "non-interactive flow" and then skips
	 * the refresh_token branch entirely (client/auth.js: `nonInteractiveFlow =
	 * !provider.redirectUrl`), so an empty value silently breaks refresh on every
	 * token expiry. The placeholder is never redirected to: a refresh grant does not
	 * use it, and starting an actual authorization is blocked by the `flow` guards in
	 * redirectToAuthorization() and saveClientInformation().
	 */
	get redirectUrl(): string {
		return this.flow?.redirectUrl ?? PLACEHOLDER_REDIRECT_URL;
	}

	state(): string {
		if (!this.flow) throw new Error("no OAuth flow in progress");
		return this.flow.state;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "bluclawd",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	clientInformation(): OAuthClientInformation | undefined {
		const raw = this.read()?.client;
		if (raw === undefined) return undefined;
		const parsed = OAuthClientInformationSchema.safeParse(raw);
		return parsed.success ? parsed.data : undefined;
	}

	saveClientInformation(client: OAuthClientInformation): void {
		// The SDK runs dynamic client registration BEFORE it decides a flow is
		// non-interactive, so a connect-path refresh with missing/corrupt client info
		// would register a client at the server using the placeholder redirect URI.
		// Registration belongs to an explicit login and nowhere else.
		if (!this.flow) throw new Error("no OAuth flow in progress — run /mcp login to register this client");
		this.write({ client });
	}

	tokens(): OAuthTokens | undefined {
		const cred = this.read();
		if (!cred || cred.tokens === undefined) return undefined;
		const parsed = OAuthTokensSchema.safeParse(cred.tokens);
		return parsed.success ? parsed.data : undefined;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.write({ tokens });
	}

	saveCodeVerifier(verifier: string): void {
		this.verifier = verifier;
	}

	codeVerifier(): string {
		if (!this.verifier) throw new Error("no PKCE code verifier for this flow");
		return this.verifier;
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		// Explicit, not incidental: only a running /mcp login may open a browser.
		// This previously held only because redirectUrl was "" — which also disabled
		// token refresh — so the invariant now stands on its own.
		if (!this.flow) {
			throw new Error("no OAuth flow in progress — run /mcp login to authenticate");
		}
		if (!this.opts.hasUI) {
			throw new Error(
				"MCP OAuth needs a browser, which a headless run has no way to show. " +
					"Log in once interactively with /mcp login, then headless runs reuse the refresh token.",
			);
		}
		assertOpenableAuthorizationUrl(url, this.opts.server);
		// Start the human's clock HERE, not when the listener was created: discovery
		// and dynamic client registration happen first and were eating the budget.
		this.flow.startTimeout?.();
		await this.opts.openBrowser(url.toString());
	}
}

export interface CallbackServer {
	/** Loopback URL registered as the OAuth redirect_uri. */
	redirectUrl: string;
	/** Per-flow CSRF token; the callback is rejected unless it echoes this back. */
	state: string;
	/** (Re)start the timeout, so it measures the human's time rather than setup. */
	startTimeout(): void;
	waitForCode(): Promise<string>;
	close(): void;
}

/**
 * One-shot loopback listener for the authorization code.
 *
 * Bound to 127.0.0.1 (never 0.0.0.0) so the listener is not reachable from the
 * network, on port 0 so the OS picks a free port. The `state` parameter is checked
 * before anything else is read off the callback, and every failure path rejects
 * without yielding a code.
 */
export async function startCallbackServer(opts: { timeoutMs?: number } = {}): Promise<CallbackServer> {
	const timeoutMs = opts.timeoutMs ?? CALLBACK_TIMEOUT_MS;
	const state = randomBytes(24).toString("base64url");

	let resolve!: (code: string) => void;
	let reject!: (err: Error) => void;
	const settled = new Promise<string>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// The caller may not be awaiting yet when a timeout or forged callback settles
	// this; swallow here so an early rejection is never an unhandled rejection.
	settled.catch(() => {});

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const reply = (message: string) => {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end(`${message}\n`);
		};

		// State first: nothing else on this request is trustworthy until it matches.
		if (url.searchParams.get("state") !== state) {
			reply("Login failed: state mismatch. You can close this tab.");
			reject(new Error("OAuth callback state did not match the pending flow"));
			return;
		}

		const error = url.searchParams.get("error");
		if (error) {
			reply(`Login failed: ${error}. You can close this tab.`);
			reject(new Error(`authorization server returned "${error}"`));
			return;
		}

		const code = url.searchParams.get("code");
		if (!code) {
			reply("Login failed: no authorization code. You can close this tab.");
			reject(new Error("OAuth callback carried no authorization code"));
			return;
		}

		reply("Login complete. You can close this tab and return to bluclawd.");
		resolve(code);
	});

	// listen() reports bind failures via an `error` event, not by throwing. Without
	// this handler an unbindable loopback (a sandbox denying it, an exhausted port
	// table) raises an uncaughtException from an async context and takes the whole
	// agent down, instead of failing just this login.
	await new Promise<void>((ready, failed) => {
		server.once("error", failed);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", failed);
			ready();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	let timer: ReturnType<typeof setTimeout>;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(
			() => reject(new Error(`timed out waiting for the OAuth callback after ${timeoutMs}ms`)),
			timeoutMs,
		);
		// Never hold the process open on this timer alone.
		timer.unref?.();
	};
	arm();

	return {
		redirectUrl: `http://127.0.0.1:${port}/callback`,
		state,
		startTimeout: arm,
		waitForCode: () => settled,
		close: () => {
			clearTimeout(timer);
			server.close();
		},
	};
}

/**
 * Decide whether a connection should carry OAuth, and build the provider if so.
 *
 * Returns a provider ONLY for an HTTP server that already has a usable credential
 * for exactly this URL. That is what keeps `/mcp login` the sole entry point: an
 * un-logged-in server is handed no provider, so nothing on the connect path can
 * reach redirectToAuthorization() and open a browser the user never asked for.
 */
export function authProviderFor(opts: {
	storage: McpCredentialStore;
	server: string;
	config: Pick<ServerConfig, "url" | "command">;
	hasUI: boolean;
	openBrowser: (url: string) => Promise<void>;
}): McpOAuthProvider | undefined {
	const url = opts.config.url;
	if (typeof url !== "string" || url.length === 0) return undefined;

	const provider = new McpOAuthProvider({
		storage: opts.storage,
		server: opts.server,
		serverUrl: url,
		hasUI: opts.hasUI,
		openBrowser: opts.openBrowser,
	});

	// tokens() already enforces the URL binding and rejects malformed JSON.
	return provider.tokens() ? provider : undefined;
}

/** Forget a server's stored credential. Absent credentials are not an error. */
export function logoutServer(opts: { storage: McpCredentialStore; server: string }): void {
	// remove() is already a no-op for an absent server, so no guard is needed.
	opts.storage.remove(opts.server);
}

/**
 * Run the interactive authorization-code flow for one server.
 *
 * The SDK drives discovery, dynamic client registration, PKCE and the token
 * exchange; this only sequences it around the loopback listener. Nothing is
 * persisted unless the exchange succeeds — every failure path leaves storage as it
 * was, so a half-finished login never masquerades as a working one.
 */
export async function loginServer(opts: {
	storage: McpCredentialStore;
	server: string;
	serverUrl: string;
	hasUI: boolean;
	openBrowser: (url: string) => Promise<void>;
	timeoutMs?: number;
}): Promise<void> {
	const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");

	const callback = await startCallbackServer({ timeoutMs: opts.timeoutMs });
	try {
		const provider = new McpOAuthProvider({
			storage: opts.storage,
			server: opts.server,
			serverUrl: opts.serverUrl,
			hasUI: opts.hasUI,
			openBrowser: opts.openBrowser,
		});
		provider.beginFlow(callback);

		// Opens the browser via redirectToAuthorization() unless a still-valid
		// credential already covers this server.
		const result = await auth(provider, { serverUrl: opts.serverUrl });
		if (result === "AUTHORIZED") return;

		const code = await callback.waitForCode();
		const exchanged = await auth(provider, {
			serverUrl: opts.serverUrl,
			authorizationCode: code,
		});
		if (exchanged !== "AUTHORIZED") {
			throw new Error("authorization did not complete");
		}
	} finally {
		callback.close();
	}
}
