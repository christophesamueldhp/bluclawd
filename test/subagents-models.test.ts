import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChildModelAndRuntime } from "../ext/subagents/models.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-models-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

async function createTestParentRegistry(agentDir: string) {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({
		provider: "faux-runner",
		models: [{ id: "faux-1", reasoning: true }],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const registry = new ModelRegistry(runtime);
	return { runtime, registry, faux, model: faux.getModel("faux-1")! };
}

describe("A run's model", () => {
	it("resolves inherited and explicit models and rejects missing or virtual models before starting work", async () => {
		const agentDir = makeTempDir("agent");
		const { registry, model } = await createTestParentRegistry(agentDir);

		// 1. Inherited physical model succeeds
		const inherited = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "inherit",
			parentModel: model,
			requestedThinkingLevel: "low",
			parentModelRegistry: registry,
		});
		expect(inherited).toMatchObject({ ok: true, model: { id: "faux-1" }, thinkingLevel: "low" });

		// 2. Missing parent model fails before starting work
		const missingParent = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "inherit",
			parentModel: undefined,
			requestedThinkingLevel: "off",
			parentModelRegistry: registry,
		});
		expect(missingParent).toMatchObject({ ok: false, error: expect.stringMatching(/no active model/i) });

		// 3. Virtual model is rejected explicitly without silent fallback
		registry.registerVirtualModel({
			provider: "faux-runner",
			id: "virtual-auto",
			name: "Virtual Auto",
			route: () => ({ model, thinkingLevel: "low" }),
		});
		await registry.refresh({ allowNetwork: false });
		const virtualModel = registry.find("faux-runner", "virtual-auto")!;
		const virtualRes = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "inherit",
			parentModel: virtualModel,
			requestedThinkingLevel: "low",
			parentModelRegistry: registry,
		});
		expect(virtualRes).toMatchObject({ ok: false, error: expect.stringMatching(/virtual model/i) });

		// 4. Explicit unknown provider/model fails before starting work
		const unknownExplicit = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "unknown-prov/missing-model",
			parentModel: model,
			requestedThinkingLevel: "low",
			parentModelRegistry: registry,
		});
		expect(unknownExplicit).toMatchObject({
			ok: false,
			error: expect.stringMatching(/unknown-prov\/missing-model/i),
		});
	});
});
