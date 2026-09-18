import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { type McpCompletionSource, mcpAutocomplete } from "../ext/mcp/autocomplete.ts";
import { type ClientHandlers, createClient } from "../ext/mcp/client.ts";
import { answerElicitation, type ElicitUI } from "../ext/mcp/elicit.ts";
import { answerSampling, samplingPrompt } from "../ext/mcp/sampling.ts";
import { decide } from "../ext/permissions/rules.ts";

/** A dialog UI that replays scripted answers in order and records every title. */
function scriptedUI(answers: (string | boolean | undefined)[]): ElicitUI & { titles: string[] } {
	const titles: string[] = [];
	const next = (title: string) => {
		titles.push(title);
		return answers.shift();
	};
	return {
		titles,
		select: async (title) => next(title) as string | undefined,
		confirm: async (title) => next(title) as boolean,
		input: async (title) => next(title) as string | undefined,
	};
}

describe("answerElicitation", () => {
	const schema = {
		properties: {
			name: { type: "string", title: "Name" },
			age: { type: "integer" },
			color: { type: "string", enum: ["red", "blue"] },
			size: { type: "string", oneOf: [{ const: "s", title: "Small" }] },
			ok: { type: "boolean" },
		},
		required: ["name", "age", "color", "size"],
	};

	it("asks one dialog per field and returns typed values", async () => {
		const ui = scriptedUI(["Ada", "36", "blue", "Small", true]);
		expect(await answerElicitation("srv", { message: "Who?", requestedSchema: schema }, ui)).toEqual({
			action: "accept",
			content: { name: "Ada", age: 36, color: "blue", size: "s", ok: true },
		});
		expect(ui.titles[0]).toContain("MCP srv: Who?");
	});

	it("re-asks a number that does not parse, and an empty required field", async () => {
		const ui = scriptedUI(["", "Ada", "x", "3.5", "4", "red", "Small", false]);
		const result = await answerElicitation("srv", { requestedSchema: schema }, ui);
		expect(result).toMatchObject({ action: "accept", content: { name: "Ada", age: 4 } });
	});

	it("cancels the whole request when a dialog is dismissed", async () => {
		expect(await answerElicitation("srv", { requestedSchema: schema }, scriptedUI(["Ada", undefined]))).toEqual({
			action: "cancel",
		});
	});

	it("leaves out an optional field the user skips", async () => {
		const ui = scriptedUI(["", "(skip)"]);
		const optional = {
			properties: { note: { type: "string" }, tone: { type: "string", enum: ["calm"] } },
		};
		expect(await answerElicitation("srv", { requestedSchema: optional }, ui)).toEqual({
			action: "accept",
			content: {},
		});
	});

	it("maps a multi-select to the listed values only", async () => {
		const ui = scriptedUI(["a, zzz, B"]);
		const multi = {
			properties: {
				tags: { type: "array", items: { anyOf: [{ const: "a" }, { const: "b", title: "B" }] } },
			},
		};
		expect(await answerElicitation("srv", { requestedSchema: multi }, ui)).toEqual({
			action: "accept",
			content: { tags: ["a", "b"] },
		});
	});

	it("declines URL-mode requests without asking", async () => {
		const ui = scriptedUI([]);
		expect(await answerElicitation("srv", { mode: "url", message: "open" }, ui)).toEqual({ action: "decline" });
		expect(ui.titles).toEqual([]);
	});
});

async function connectWith(server: McpServer, handlers: ClientHandlers) {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = createClient(handlers);
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	return client;
}

describe("elicitation and sampling against a live server", () => {
	function interactiveServer(): McpServer {
		const server = new McpServer({ name: "s", version: "0" });
		server.registerTool("ask", { description: "asks the user" }, async () => {
			const answer = await server.server.elicitInput({
				message: "Pick a name",
				requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			});
			return { content: [{ type: "text", text: JSON.stringify(answer) }] };
		});
		server.registerTool("think", { description: "samples the client model" }, async () => {
			const reply = await server.server.createMessage({
				messages: [{ role: "user", content: { type: "text", text: "2+2?" } }],
				maxTokens: 50,
			});
			return { content: [{ type: "text", text: JSON.stringify(reply) }] };
		});
		return server;
	}

	it("routes an elicitation to the handler and returns its answer to the server", async () => {
		const client = await connectWith(interactiveServer(), {
			onElicit: async (params) => answerElicitation("s", params, scriptedUI(["Ada"])),
		});
		const result = await client.callTool({ name: "ask" });
		expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({
			action: "accept",
			content: { name: "Ada" },
		});
		await client.close();
	});

	it("routes a sampling request to the handler", async () => {
		const client = await connectWith(interactiveServer(), {
			onSample: async (params) => ({
				role: "assistant",
				content: { type: "text", text: `got ${samplingPrompt(params).text}` },
				model: "m",
				stopReason: "endTurn",
			}),
		});
		const result = await client.callTool({ name: "think" });
		expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({
			content: { text: "got 2+2?" },
			model: "m",
		});
		await client.close();
	});

	it("does not advertise either capability without a handler, so the server's request fails", async () => {
		const client = await connectWith(interactiveServer(), {});
		const result = await client.callTool({ name: "ask" });
		expect(result.isError).toBe(true);
		await client.close();
	});
});

describe("samplingPrompt", () => {
	it("keeps images apart and role-marks a conversation", () => {
		const { text, images } = samplingPrompt({
			maxTokens: 10,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Q" },
						{ type: "image", data: "AA", mimeType: "image/png" },
					],
				},
				{ role: "assistant", content: { type: "text", text: "A" } },
			],
		});
		expect(text).toBe("[user]\nQ\n\n[assistant]\nA");
		expect(images).toEqual([{ type: "image", data: "AA", mimeType: "image/png" }]);
	});
});

describe("answerSampling", () => {
	const params = { maxTokens: 10, messages: [{ role: "user", content: { type: "text", text: "hi" } }] };

	it("refuses without a UI to ask on", async () => {
		const ctx = { hasUI: false } as unknown as ExtensionContext;
		await expect(answerSampling(ctx, "s", params)).rejects.toThrow(/no UI/);
	});

	it("never calls the model when the user declines", async () => {
		let credentialsRead = false;
		const ctx = {
			hasUI: true,
			model: { id: "m", name: "M", provider: "p" },
			ui: { confirm: async () => false },
			modelRegistry: {
				getApiKeyAndHeaders: async () => {
					credentialsRead = true;
					return { ok: false };
				},
			},
		} as unknown as ExtensionContext;
		await expect(answerSampling(ctx, "s", params)).rejects.toThrow(/declined/);
		expect(credentialsRead).toBe(false);
	});
});

describe("mcpAutocomplete", () => {
	const base: AutocompleteProvider = {
		getSuggestions: async (lines, _l, col): Promise<AutocompleteSuggestions | null> => {
			const before = lines[0].slice(0, col);
			if (before === "/he") return { items: [{ value: "help", label: "help" }], prefix: before };
			if (before.endsWith("@do")) return { items: [{ value: "@docs.md", label: "docs.md" }], prefix: "@do" };
			return null;
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
			const line = lines[cursorLine];
			const start = cursorCol - prefix.length;
			const text = `${line.slice(0, start)}${item.value} ${line.slice(cursorCol)}`;
			return { lines: [text], cursorLine, cursorCol: start + item.value.length + 1 };
		},
	};
	let listed = 0;
	const source: McpCompletionSource = {
		promptCommands: () => [{ name: "mcp__docs__review", description: "<pr> — Review (MCP: docs)" }],
		resourceServers: () => ["docs"],
		resources: async () => {
			listed++;
			return [
				{ uri: "docs://readme/", name: "readme", description: "The readme" },
				{ uri: "docs://logo", name: "logo" },
			];
		},
	};
	const provider = mcpAutocomplete(base, source);
	const suggest = (text: string) =>
		provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });

	it("offers connected servers' prompt commands in the slash menu", async () => {
		expect((await suggest("/mcp__"))?.items.map((i) => i.value)).toEqual(["mcp__docs__review"]);
		expect((await suggest("/he"))?.items.map((i) => i.value)).toEqual(["help"]);
	});

	it("adds @server: ahead of file matches, and completes it without a space", async () => {
		const result = await suggest("see @do");
		expect(result?.items.map((i) => i.value)).toEqual(["@docs:", "@docs.md"]);
		const applied = provider.applyCompletion(["see @do"], 0, 7, result?.items[0] as never, result?.prefix ?? "");
		expect(applied).toEqual({ lines: ["see @docs:"], cursorLine: 0, cursorCol: 10 });
	});

	it("lists a server's resources after @server:, filtered by what follows", async () => {
		const result = await suggest("read @docs:read");
		expect(result).toEqual({
			prefix: "@docs:read",
			items: [{ value: "@docs:docs://readme/", label: "readme", description: "The readme" }],
		});
		expect(listed).toBeGreaterThan(0);
	});

	it("leaves @unknown:… to the file completer", async () => {
		expect(await suggest("@nope:x")).toBeNull();
	});
});

describe("confirming chosen MCP tools", () => {
	it("is an ask rule with a glob, so no separate approveTools setting is needed", () => {
		const rules = { allow: [], ask: ["Mcp(github:delete_*)"], deny: [] } as unknown as Parameters<typeof decide>[0];
		expect(decide(rules, "mcp__github__delete_repo", {})).toBe("ask");
		expect(decide(rules, "mcp__github__get_me", {})).toBeNull();
	});
});
