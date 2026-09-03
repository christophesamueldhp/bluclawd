/** Module customization hooks registered by pi-resolve-hook.mjs — see there for why. */
let piParentURL;

export async function initialize(data) {
	piParentURL = data?.parentURL;
}

export async function resolve(specifier, context, nextResolve) {
	if (piParentURL && specifier.startsWith("@earendil-works/")) {
		return nextResolve(specifier, { ...context, parentURL: piParentURL });
	}
	return nextResolve(specifier, context);
}
