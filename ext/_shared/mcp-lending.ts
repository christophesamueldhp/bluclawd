/**
 * The parent session's MCP servers, lent to subagent children. A child has no
 * extensions of its own, and respawning each server per child would repeat the
 * approval gate, OAuth and startup, so a child's tools call through the parent's
 * live client. MCP and subagents are separate `pi.extensions` entries, hence
 * `sharedRef`. Kept free of the MCP SDK, which the subagents layer must not load.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "./global-state.ts";

export interface LendableMcpServer {
	name: string;
	/** The connection's status in the parent, e.g. `connected` or `needs-approval`. */
	status: string;
	error?: string;
	/** The namespaced tool names (`mcp__<server>__<tool>`) it would register. */
	toolNames: string[];
	instructions?: string;
	/** Register the server's tools on a child's pi; only meaningful while connected. */
	lend(pi: Pick<ExtensionAPI, "registerTool">): void;
}

const servers = sharedRef<() => LendableMcpServer[]>("mcp.lendable", () => []);

/** Called by the MCP extension with a live view of its connections. */
export function publishMcpServers(list: () => LendableMcpServer[]): void {
	servers.set(list);
}

export function lendableMcpServers(): LendableMcpServer[] {
	return servers.get()();
}
