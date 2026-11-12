/**
 * `--import`ed into `node bin.mjs`: the launcher's import of pi resolves to `stub-pi.mjs`, which
 * prints the arguments the launcher hands pi's `main`. Every other importer gets the real pi.
 */
import { registerHooks } from "node:module";

const stub = new URL("./stub-pi.mjs", import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent" && context.parentURL?.endsWith("/bin.mjs")) {
			return { url: stub, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
