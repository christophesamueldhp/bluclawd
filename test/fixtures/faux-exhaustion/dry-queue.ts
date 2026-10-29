// Run only by test/faux-exhaustion.test.ts: a test that asks a faux provider for more responses than it queued.
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { it } from "vitest";

it("asks for one response more than it queued", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("Only one.")]);
	const model = faux.getModel();
	await models.complete(model, { messages: [] });
	await models.complete(model, { messages: [] });
});
