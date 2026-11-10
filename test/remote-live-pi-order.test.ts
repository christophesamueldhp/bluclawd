/**
 * The live forwarder names the entry pi wrote an assistant message to, which rests on pi's order:
 * extensions' message_end handlers first, then the entry. These tests fail if a pi version writes it later.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { forwardLive, LIVE_INTERVAL_MS, type LiveForwarder } from "../ext/remote/live.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What the forwarder sent and when the tool ran, in order: `end:<id>` for an end naming its entry. */
async function run(others: ExtensionFactory[] = []): Promise<{ log: string[]; assistantEntries: string[] }> {
	const cwd = mkdtempSync(join(tmpdir(), "bluclawd-live-order-"));
	dirs.push(cwd);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: join(cwd, "models.json"),
		modelsStorePath: join(cwd, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({ provider: "faux-live", models: [{ id: "faux-model", reasoning: false }] });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });

	const log: string[] = [];
	let live: LiveForwarder | undefined;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		extensionFactories: [
			(pi) => {
				live = forwardLive(pi, (snapshot, entryId) =>
					log.push(entryId ? `end:${entryId}` : snapshot ? "snapshot" : "null"),
				);
			},
			...others,
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await resourceLoader.reload();
	const probe = defineTool({
		name: "probe",
		label: "Probe",
		description: "Does nothing",
		parameters: Type.Object({}),
		async execute() {
			log.push("tool");
			return { content: [{ type: "text", text: "probed" }], details: {} };
		},
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime,
		model: faux.getModel("faux-model"),
		noTools: "builtin",
		customTools: [probe],
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	try {
		await session.bindExtensions({});
		live?.setWatched(true);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {}, { id: "call_1" })]),
			// Past the live interval, so the phone is sent this reply's text before it ends.
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 2 * LIVE_INTERVAL_MS));
				return fauxAssistantMessage("Probed.");
			},
		]);
		await session.prompt("Probe.", { expandPromptTemplates: false });
	} finally {
		session.dispose();
	}
	const assistantEntries = sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
		.map((entry) => entry.id);
	return { log, assistantEntries };
}

describe("the end of a live reply in a real pi session", () => {
	it("names the entry pi wrote each assistant message to, before its tools run", async () => {
		const { log, assistantEntries } = await run();
		expect(assistantEntries).toHaveLength(2);
		const [first, second] = assistantEntries;
		expect(log.filter((item) => item.startsWith("end:"))).toEqual([`end:${first}`, `end:${second}`]);
		expect(log.indexOf(`end:${first}`)).toBeLessThan(log.indexOf("tool"));
		expect(log.at(-1)).toBe(`end:${second}`);
	});

	it("still names the right entry when another extension's message_end handler holds pi up", async () => {
		const slow: ExtensionFactory = (pi) => {
			pi.on("message_end", () => new Promise<void>((resolve) => setTimeout(resolve, 50)));
		};
		const { log, assistantEntries } = await run([slow]);
		expect(assistantEntries).toHaveLength(2);
		const [first, second] = assistantEntries;
		expect(log.filter((item) => item.startsWith("end:"))).toEqual([`end:${first}`, `end:${second}`]);
		expect(log.indexOf(`end:${first}`)).toBeLessThan(log.indexOf("tool"));
		expect(log.at(-1)).toBe(`end:${second}`);
	});

	it("names the assistant's entry, not one another extension wrote meanwhile", async () => {
		// As checkpoints and background-bash do: an entry written while the reply is not yet.
		const noting: ExtensionFactory = (pi) => {
			pi.on("message_end", async (event) => {
				if (event.message.role !== "assistant") return;
				pi.appendEntry("note", {});
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
			});
		};
		const { log, assistantEntries } = await run([noting]);
		expect(assistantEntries).toHaveLength(2);
		const [first, second] = assistantEntries;
		expect(log.filter((item) => item.startsWith("end:"))).toEqual([`end:${first}`, `end:${second}`]);
	});
});
