/**
 * The bluclawd feature layer, as a list of pi inline extensions.
 *
 * `bin.mjs` hands this to `main(argv, { extensionFactories })`. Nothing here
 * reaches into pi's internals: if a feature cannot be expressed through the
 * `ExtensionAPI`, it does not ship on this branch — that is the trade this
 * branch exists to make.
 *
 * Registration order matters only where two extensions touch the same tool or
 * event; keep it explicit rather than alphabetical.
 */
import type { InlineExtension } from "../../packages/coding-agent/src/core/extensions/types.ts";
import commands from "./commands/index.ts";

export function bluclawdExtensions(): InlineExtension[] {
	return [commands];
}
