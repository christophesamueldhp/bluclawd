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
