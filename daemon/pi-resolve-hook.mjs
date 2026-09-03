/**
 * `--import`ed into the daemon process by FleetView's auto-start.
 *
 * pi loads this package's extensions through jiti and aliases every
 * `@earendil-works/*` import to its own bundled copies, so the installed package
 * never has those packages in its node_modules. The daemon is a separate node
 * process with no such alias, and `daemon/radius.ts` + `daemon/rpc-process.ts`
 * import them at runtime — so resolve them from the pi that launched us instead
 * (PI_PACKAGE_ROOT = that pi's package directory). Without the env var this is a
 * no-op: a dev checkout resolves them from its own node_modules.
 */
import { register, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_ROOT;
if (root) {
	const parentURL = pathToFileURL(`${root}/`).href;
	if (typeof registerHooks === "function") {
		// Node ≥ 22.15: synchronous in-thread hooks (module.register() is deprecated there).
		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (specifier.startsWith("@earendil-works/")) return nextResolve(specifier, { ...context, parentURL });
				return nextResolve(specifier, context);
			},
		});
	} else {
		register("./pi-resolve-hooks.mjs", import.meta.url, { data: { parentURL } });
	}
}
