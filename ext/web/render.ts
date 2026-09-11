/**
 * TUI rendering for `webfetch` / `websearch` (Ctrl+O collapse/expand).
 *
 * Neither tool defined `renderCall`/`renderResult`, so pi fell back to dumping
 * the raw `content` text for every call — a fetched page can be up to 8MB and
 * a search reply can carry ten full snippets, both far past what a collapsed
 * row should show. Same shape as `ext/subagents/render.ts`: a one-line
 * collapsed summary with a "(ctrl+o to expand)" hint, full content on expand.
 */

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { keyDisplayText } from "../_shared/key-display-text.ts";
import type { WebfetchResult } from "./fetch.ts";
import type { SearchResult } from "./search.ts";

interface WebfetchDetails {
	url: string;
	contentType: string;
	bytes: number;
	truncated: boolean;
	cached?: boolean;
	analyzed?: boolean;
	redirectedTo?: string;
}

const expandHint = (theme: Theme): string => theme.fg("muted", ` (${keyDisplayText("app.tools.expand")} to expand)`);

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function resultText(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

/** Collapsed: `webfetch <url>`. No result-slot state needed here. */
export function renderWebfetchCall(args: { url?: string }, theme: Theme): Text {
	return new Text(`${theme.fg("toolTitle", theme.bold("webfetch"))} ${theme.fg("muted", args.url ?? "")}`, 0, 0);
}

export function renderWebfetchResult(
	result: AgentToolResult<WebfetchDetails>,
	{ expanded }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { isError: boolean },
): Text {
	const { isError } = context;
	const details = result.details;
	const text = resultText(result);
	if (isError) return new Text(theme.fg("error", text), 0, 0);
	// A redirect notice or a model analysis is already short and self-contained —
	// collapsing either would hide the one thing the call was for.
	if (!details || details.redirectedTo || details.analyzed) {
		return new Text(theme.fg("toolOutput", text), 0, 0);
	}
	if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);

	const flags = [details.cached && "cached", details.truncated && "truncated"].filter(Boolean).join(", ");
	const summary = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", details.url)} ${theme.fg(
		"muted",
		`${details.contentType || "text"} · ${formatBytes(details.bytes)}${flags ? ` · ${flags}` : ""}`,
	)}`;
	return new Text(summary + expandHint(theme), 0, 0);
}

/** Collapsed: `websearch "<query>"`. */
export function renderWebsearchCall(args: { query?: string }, theme: Theme): Text {
	return new Text(
		`${theme.fg("toolTitle", theme.bold("websearch"))} ${theme.fg("muted", `"${args.query ?? ""}"`)}`,
		0,
		0,
	);
}

/** The human-facing list, without the untrusted-block wrapper or the citation reminder meant for the model. */
export function formatSearchResultsForDisplay(results: SearchResult[]): string {
	if (results.length === 0) return "(no results)";
	return results
		.map((r, i) => {
			const head = `${i + 1}. ${r.title || r.url}${r.published ? ` (${r.published})` : ""}\n   ${r.url}`;
			return r.snippet ? `${head}\n   ${r.snippet}` : head;
		})
		.join("\n\n");
}

export function renderWebsearchResult(
	result: AgentToolResult<SearchResult[]>,
	{ expanded }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { isError: boolean },
): Text {
	const { isError } = context;
	const results = result.details ?? [];
	if (isError) return new Text(theme.fg("error", resultText(result)), 0, 0);
	// An error-shaped non-exception result (e.g. "needs an API key") has no
	// results to list; show the message as-is rather than "0 results".
	if (results.length === 0 && resultText(result)) return new Text(theme.fg("toolOutput", resultText(result)), 0, 0);
	if (expanded) return new Text(theme.fg("toolOutput", formatSearchResultsForDisplay(results)), 0, 0);

	const summary = `${theme.fg("success", "✓")} ${theme.fg(
		"toolOutput",
		`${results.length} result${results.length === 1 ? "" : "s"}`,
	)}`;
	return new Text(summary + expandHint(theme), 0, 0);
}
