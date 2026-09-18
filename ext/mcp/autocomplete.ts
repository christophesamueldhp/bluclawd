/**
 * Editor completion for MCP: `/mcp__<server>__<prompt>` commands and `@server:uri`
 * resource mentions. pi snapshots the slash-command list when it builds its
 * provider, so prompt commands registered after a server connects would never
 * appear; this wrapper reads the live state on every keystroke instead.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";

export interface McpCompletionSource {
	/** Prompt commands of connected servers, without the leading `/`. */
	promptCommands(): { name: string; description?: string }[];
	/** Names of connected servers that serve resources. */
	resourceServers(): string[];
	/** A server's resources (cached by the caller); rejects or empties on failure. */
	resources(server: string): Promise<{ uri: string; name?: string; description?: string }[]>;
}

const SERVER_PREFIX = /(?:^|\s)(@([\w.-]*))$/;
const RESOURCE_PREFIX = /(?:^|\s)(@([\w.-]+):(\S*))$/;

export function mcpAutocomplete(current: AutocompleteProvider, source: McpCompletionSource): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);

			const resource = RESOURCE_PREFIX.exec(before);
			if (resource && source.resourceServers().includes(resource[2])) {
				const [, token, server, partial] = resource;
				const list = await source.resources(server).catch(() => []);
				const items = fuzzyFilter(list, partial, (r) => `${r.uri} ${r.name ?? ""}`).map((r) => ({
					value: `@${server}:${r.uri}`,
					// The base provider skips the trailing space after a label ending in "/".
					label: (r.name ?? r.uri).replace(/\/+$/, ""),
					description: r.description ?? r.uri,
				}));
				return items.length > 0 ? { items, prefix: token } : null;
			}

			const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);

			if (!options.force && cursorLine === 0 && before.startsWith("/") && !before.includes(" ")) {
				const have = new Set(base?.items.map((i) => i.value));
				const prompts = fuzzyFilter(
					source.promptCommands().filter((c) => !have.has(c.name)),
					before.slice(1),
					(c) => c.name,
				).map((c): AutocompleteItem => ({ value: c.name, label: c.name, description: c.description }));
				if (prompts.length === 0) return base;
				return { items: [...(base?.items ?? []), ...prompts], prefix: before };
			}

			const at = SERVER_PREFIX.exec(before);
			if (at) {
				const [, token, partial] = at;
				const servers = source
					.resourceServers()
					.filter((s) => s.startsWith(partial))
					.map((s): AutocompleteItem => ({ value: `@${s}:`, label: `@${s}:`, description: "MCP resources" }));
				if (servers.length === 0) return base;
				return { items: [...servers, ...(base?.items ?? [])], prefix: base?.prefix ?? token };
			}
			return base;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			// A server name completes to `@server:` and stays open for the uri.
			if (/^@[\w.-]+:$/.test(item.value) && prefix.startsWith("@")) {
				const line = lines[cursorLine] ?? "";
				const start = cursorCol - prefix.length;
				const next = [...lines];
				next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
				return { lines: next, cursorLine, cursorCol: start + item.value.length };
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	};
}
