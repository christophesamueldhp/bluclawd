/**
 * Credential store for remote MCP servers — `<agentDir>/mcp-auth.json`.
 *
 * MCP OAuth credentials used to live in `auth.json` under an `mcp:<server>` key,
 * sharing the provider credential file. Upstream v0.81.0 moved provider
 * credentials behind an async `CredentialStore` in `packages/ai/src/auth/`, whose
 * `Credential` union is `api_key | oauth` — there is no place in it for an MCP
 * server token, and widening that union would mean carrying a fork delta in a
 * package the fork otherwise never touches, which is the merge cost the whole
 * soft-fork strategy exists to avoid.
 *
 * So MCP credentials get their own file. Beyond keeping upstream's types intact,
 * the separation removes a real defect class: while the two shared `auth.json`,
 * every consumer that listed "providers" had to remember to filter `mcp:` keys
 * out, and `/logout` had already shipped MCP servers into its picker as
 * unlabelled providers once.
 *
 * `client` and `tokens` are held as `unknown` on purpose: this file is
 * user-editable and the MCP SDK must not be imported on the startup path, so the
 * shapes are validated against the SDK's own schemas at read time in `oauth.ts`
 * rather than trusted from disk. `serverUrl` binds a credential to the origin it
 * was issued for, so a later `mcp.json` edit cannot replay the token to a new host.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface McpOAuthCredential {
	serverUrl: string;
	client?: unknown;
	tokens?: unknown;
}

/** Same posture as the provider credential file: owner-only, created on write. */
const WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export function mcpAuthPath(): string {
	return join(getAgentDir(), "mcp-auth.json");
}

export class McpCredentialStore {
	private readonly path: string;

	private constructor(path: string) {
		this.path = path;
	}

	/** Path is resolved per call, never at module load, so tests can inject a temp dir. */
	static create(path: string = mcpAuthPath()): McpCredentialStore {
		return new McpCredentialStore(path);
	}

	/**
	 * Reads fresh every time rather than caching. Logins are rare, the file is
	 * tiny, and a cache would go stale against a concurrent `/mcp login` in
	 * another session.
	 */
	private readAll(): Record<string, McpOAuthCredential> {
		if (!existsSync(this.path)) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
			// A hand-edited file can hold anything; a non-object means "no credentials"
			// rather than a crash on the connect path.
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, McpOAuthCredential>)
				: {};
		} catch {
			return {};
		}
	}

	private writeAll(data: Record<string, McpOAuthCredential>): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, WRITE_OPTIONS);
		// writeFileSync's mode applies only when it creates the file; an existing
		// file keeps whatever mode it had, so re-assert it.
		chmodSync(this.path, 0o600);
	}

	get(server: string): McpOAuthCredential | undefined {
		const entry = this.readAll()[server];
		return entry && typeof entry.serverUrl === "string" ? entry : undefined;
	}

	set(server: string, credential: McpOAuthCredential): void {
		const data = this.readAll();
		data[server] = credential;
		this.writeAll(data);
	}

	remove(server: string): void {
		const data = this.readAll();
		if (!(server in data)) return;
		delete data[server];
		this.writeAll(data);
	}
}
