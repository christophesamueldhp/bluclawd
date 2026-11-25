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
