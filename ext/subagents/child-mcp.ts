/**
 * MCP servers in a child (`mcpServers` frontmatter): the parent's live
 * connections, lent by name (see _shared/mcp-lending.ts). Only a server that is
 * connected in the parent can be lent, which is what keeps the approval gate in
 * force: a server awaiting `/mcp approve` has no connection to borrow.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { type LendableMcpServer, lendableMcpServers } from "../_shared/mcp-lending.ts";

/** The named servers, or why one of them cannot be lent. */
export function borrowMcpServers(names: readonly string[]): { servers: LendableMcpServer[] } | { problem: string } {
	const available = lendableMcpServers();
	const servers: LendableMcpServer[] = [];
	for (const name of names) {
		const server = available.find((s) => s.name === name);
		if (!server) return { problem: `MCP server "${name}" is not configured in this session.` };
		if (server.status !== "connected") {
			const why = server.error ? `${server.status}: ${server.error}` : server.status;
			return { problem: `MCP server "${name}" is not connected (${why}); see /mcp.` };
		}
		servers.push(server);
	}
	return { servers };
}

export function createChildMcpExtension(servers: readonly LendableMcpServer[]): InlineExtension {
	return {
		name: "subagent-mcp",
		factory: (pi) => {
			for (const server of servers) server.lend(pi);
		},
	};
}
