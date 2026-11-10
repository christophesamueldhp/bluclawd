/** A virtual model, faux-router/auto, that routes every request to faux-2 at the level selected. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fauxRouter(pi: ExtensionAPI): void {
	pi.registerVirtualModel({
		provider: "faux-router",
		id: "auto",
		name: "Auto",
		thinkingLevels: ["low", "high"],
		route: (request, ctx) => ({
			model: ctx.modelRegistry.find("faux", "faux-2")!,
			thinkingLevel: request.thinkingLevel,
		}),
	});
}
