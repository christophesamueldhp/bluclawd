/**
 * The parent session's MCP servers, as the subagents layer may lend them to a child.
 *
 * A child is built with no extensions, so it has no MCP bridge of its own; and
 * spawning each server again per child would repeat the approval gate, OAuth and
 * startup cost the parent already paid. Instead the MCP extension publishes its
 * connections here and a child borrows them: its tools call through the parent's
 * live client. MCP and subagents are separate `pi.extensions` entries, hence
 * `sharedRef` (see global-state.ts). Kept free of the SDK, which the subagents
 * layer must not load.
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
