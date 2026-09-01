/**
 * The bluclawd feature layer, as a list of pi inline extensions.
 *
 * `bin.mjs` hands this to `main(argv, { extensionFactories })`. Nothing here
 * reaches into pi's internals: if a feature cannot be expressed through the
 * `ExtensionAPI`, it does not ship on this branch — that is the trade this
 * branch exists to make.
 *
 * Order matters only for permissions, which must see `tool_call` before anything
 * that might answer it — keep it first.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import backgroundBash from "./background-bash/index.ts";
import branding from "./branding/index.ts";
import checkpoints from "./checkpoints/index.ts";
import commands from "./commands/index.ts";
import diagnostics from "./diagnostics/index.ts";
import diff from "./diff/index.ts";
import fleet from "./fleet/index.ts";
import help from "./help/index.ts";
import historySearch from "./history-search/index.ts";
import hooks from "./hooks/index.ts";
import mcp from "./mcp/index.ts";
import memory from "./memory/index.ts";
import modelControls from "./model-controls/index.ts";
import permissions from "./permissions/index.ts";
import sandbox from "./sandbox/index.ts";
import skills from "./skills/index.ts";
import statusline from "./statusline/index.ts";
import subagents from "./subagents/index.ts";
import web from "./web/index.ts";

export function bluclawdExtensions(): InlineExtension[] {
	return [
		permissions,
		hooks,
		modelControls,
		statusline,
		memory,
		checkpoints,
		subagents,
		web,
		mcp,
		sandbox,
		backgroundBash,
		branding,
		diagnostics,
		diff,
		fleet,
		skills,
		help,
		commands,
		historySearch,
	];
}
