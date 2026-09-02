/**
 * The bluclawd feature layer, as a list of pi inline extensions.
 *
 * Each `ext/<name>/index.ts` file is a bare `export default function(pi) {...}` —
 * the shape pi's package loader requires for a file listed in `package.json`'s
 * `pi.extensions` manifest (`loadExtensionModule` in pi's own
 * `core/extensions/loader.ts` rejects anything that isn't `typeof === "function"`).
 * That manifest, not this file, is what `pi install` actually loads.
 *
 * This aggregator exists for the two callers that still compose extensions
 * in-process rather than loading them from disk: `bin.mjs` (kept for local
 * testing without a separate pi install) and `scripts/probe-extensions.ts` /
 * the test suite, both of which want each factory paired back up with its
 * name. `package.json`'s `pi.extensions` array is the source of truth for
 * ordering — keep this list in sync with it. Order matters only for
 * permissions, which must see `tool_call` before anything that might answer
 * it — keep it first.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import aliases from "./aliases/index.ts";
import backgroundBash from "./background-bash/index.ts";
import branding from "./branding/index.ts";
import checkpoints from "./checkpoints/index.ts";
import diagnostics from "./diagnostics/index.ts";
import fleet from "./fleet/index.ts";
import help from "./help/index.ts";
import mcp from "./mcp/index.ts";
import memory from "./memory/index.ts";
import permissions from "./permissions/index.ts";
import sandbox from "./sandbox/index.ts";
import statusline from "./statusline/index.ts";
import subagents from "./subagents/index.ts";
import web from "./web/index.ts";

export function bluclawdExtensions(): InlineExtension[] {
	return [
		{ name: "permissions", factory: permissions },
		{ name: "statusline", factory: statusline },
		{ name: "memory", factory: memory },
		{ name: "checkpoints", factory: checkpoints },
		{ name: "subagents", factory: subagents },
		{ name: "web", factory: web },
		{ name: "mcp", factory: mcp },
		{ name: "sandbox", factory: sandbox },
		{ name: "background-bash", factory: backgroundBash },
		{ name: "branding", factory: branding },
		{ name: "diagnostics", factory: diagnostics },
		{ name: "fleet", factory: fleet },
		{ name: "help", factory: help },
		{ name: "aliases", factory: aliases },
	];
}
