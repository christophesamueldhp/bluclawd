/**
 * pi loads this package's extensions through jiti and aliases every
 * `@earendil-works/*` import to its own bundled copies, so the installed package
 * never has those packages in its node_modules. The daemon is a separate node
 * process with no such alias, and `daemon/remote/http.ts` imports them at
 * runtime, so resolve them from the pi that launched us instead.
 * PI_PACKAGE_ROOT is that pi's package directory.
 */
import { register, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_ROOT;
if (root) {
	const parentURL = pathToFileURL(`${root}/`).href;
	if (typeof registerHooks === "function") {
		// Node 22.15 and later have synchronous in-thread hooks, and deprecate module.register().
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
