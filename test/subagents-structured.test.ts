import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";
import { parseDef } from "../ext/subagents/defs.ts";
import { childLoaderOptions, childToolLists, runSubagent } from "../ext/subagents/engine.ts";
import { UNLIMITED_TOOLS } from "../ext/subagents/limits.ts";
import { getFinalOutput } from "../ext/subagents/render.ts";
import {
	createStructuredOutputExtension,
	outputSchemaProblem,
	parseOutputSchema,
	STRUCTURED_OUTPUT_TOOL,
	structuredOutputOf,
} from "../ext/subagents/structured-output.ts";
import { expandWorkflow, parseWorkflow } from "../ext/subagents/workflows.ts";

const SCHEMA = {
	type: "object",
	properties: { files: { type: "array", items: { type: "string" } } },
	required: ["files"],
	additionalProperties: false,
};

function loadTool(ext: any) {
	let tool: any;
	ext.factory({
		registerTool: (t: any) => {
			tool = t;
		},
	});
	return tool;
}

const assistantText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as any;
const outputResult = (text: string, isError = false) =>
	({ role: "toolResult", toolName: STRUCTURED_OUTPUT_TOOL, content: [{ type: "text", text }], isError }) as any;

describe("the structured_output tool", () => {
	it("takes the value under the schema, and ends the child's run with it as JSON", async () => {
		const tool = loadTool(createStructuredOutputExtension(SCHEMA));
		expect(tool.name).toBe(STRUCTURED_OUTPUT_TOOL);
		const call = (args: unknown) =>
			validateToolArguments(tool, { type: "toolCall", id: "1", name: tool.name, arguments: args } as any);
		expect(() => call({ value: { files: ["a.ts"] } })).not.toThrow();
		expect(() => call({ value: { files: [{ path: "a.ts" }] } })).toThrow(/value/);
		expect(() => call({ value: { other: true } })).toThrow(/files/);

		const result = await tool.execute("1", { value: { files: ["a.ts"] } });
		expect(result.terminate).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({ files: ["a.ts"] });
	});
});

describe("parseOutputSchema and outputSchemaProblem", () => {
	it("takes only a non-empty object: an empty one a model filled in is no schema", () => {
		expect(parseOutputSchema(SCHEMA)).toEqual(SCHEMA);
		expect(parseOutputSchema({})).toBeUndefined();
		expect(parseOutputSchema([])).toBeUndefined();
		expect(parseOutputSchema("object")).toBeUndefined();
		expect(parseOutputSchema(undefined)).toBeUndefined();
	});

	it("refuses $ref, which cannot resolve once the schema is nested under value", () => {
		expect(outputSchemaProblem(SCHEMA)).toBeUndefined();
		expect(outputSchemaProblem({ type: "object", properties: { a: { $ref: "#/$defs/a" } } })).toMatch(/\$ref/);
	});
});

describe("the output a structured child hands back", () => {
	it("is its last accepted structured_output, even with text after it", () => {
		const messages = [assistantText("working"), outputResult('{"files":["a"]}'), assistantText("all done")];
		expect(structuredOutputOf(messages)).toBe('{"files":["a"]}');
		expect(getFinalOutput(messages)).toBe('{"files":["a"]}');
	});

	it("skips a rejected call, and falls back to the last text without one", () => {
		expect(structuredOutputOf([outputResult("Validation failed", true)])).toBeUndefined();
		expect(getFinalOutput([outputResult("Validation failed", true), assistantText("prose")])).toBe("prose");
	});
});

describe("giving a child the tool", () => {
	const def = (over: object = {}) =>
		({ name: "w", description: "d", systemPrompt: "", source: "user", filePath: "/x/w.md", ...over }) as any;

	it("adds it to an allowlist, which would otherwise hide it", () => {
		expect(childToolLists(def({ tools: ["read"] }), false, true).tools).toEqual(["read", STRUCTURED_OUTPUT_TOOL]);
		expect(childToolLists(def(), false, true).tools).toBeUndefined();
		expect(childToolLists(def({ tools: ["read"] })).tools).toEqual(["read"]);
	});

	it("loads the extension and tells the child to finish with it, only with a schema", () => {
		const ctx = { cwd: process.cwd(), isProjectTrusted: () => false } as any;
		const without = childLoaderOptions(ctx, def(), { mode: "auto" });
		const withSchema = childLoaderOptions(ctx, def(), { mode: "auto", outputSchema: SCHEMA });
		const names = (o: any) => o.extensionFactories.map((e: any) => e.name);
		expect(names(without)).not.toContain("subagent-structured-output");
		expect(names(withSchema)).toContain("subagent-structured-output");
		expect(withSchema.appendSystemPrompt?.join("\n")).toContain(STRUCTURED_OUTPUT_TOOL);
	});

	it("never counts against a tool budget, and never prompts for permission", () => {
		expect(UNLIMITED_TOOLS.has(STRUCTURED_OUTPUT_TOOL)).toBe(true);
		const cfg = {
			mode: "ask" as const,
			rules: {},
			cliAllowRules: {},
			cwd: process.cwd(),
			agentDir: "/nowhere",
			configDirName: ".pi",
			hasUI: true,
		};
		const input = { value: {} };
		const verdict =
			evaluatePreHook(STRUCTURED_OUTPUT_TOOL, input, cfg) ?? evaluatePostHook(STRUCTURED_OUTPUT_TOOL, input, cfg);
		expect(verdict.outcome).toBe("allow");
	});
});

describe("where a schema comes from", () => {
	it("an agent's outputSchema frontmatter", () => {
		const parsed = parseDef(
			"---\nname: x\ndescription: d\noutputSchema:\n  type: object\n  properties:\n    ok: { type: boolean }\n---\nbody\n",
		);
		expect((parsed as any).outputSchema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
		expect(parseDef("---\nname: x\ndescription: d\noutputSchema: yes\n---\nbody\n")).not.toHaveProperty(
			"outputSchema",
		);
	});

	it("a workflow step's outputSchema, kept through expansion; a non-object one fails the file", () => {
		const file = (schema: string) =>
			`---\nname: w\ndescription: d\nchain:\n  - agent: a\n    task: "{input}"\n    outputSchema: ${schema}\n---\n`;
		const ok = parseWorkflow(file('{"type":"object"}'));
		if ("problem" in ok) throw new Error(ok.problem);
		const [step] = expandWorkflow({ ...ok, origin: "user", filePath: "/w.md" }, "go");
		expect(step).toMatchObject({ task: "go", outputSchema: { type: "object" } });
		expect(parseWorkflow(file("nope"))).toHaveProperty("problem");
	});
});

describe("runSubagent with an output schema", () => {
	let home: string;
	let cwd: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-so-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-so-cwd-"));
		saved = { HOME: process.env.HOME };
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	const model = { provider: "p", id: "m" } as any;
	const ctx = () =>
		({
			cwd,
			isProjectTrusted: () => true,
			model,
			modelRegistry: { find: () => model, getAll: () => [model] },
		}) as any;
	const def = (over: object = {}) =>
		({ name: "w", description: "d", systemPrompt: "", source: "user", filePath: "/x/w.md", ...over }) as any;

	/** A child whose prompts each end with the scripted replies, in order. */
	function scripted(...replies: Array<"text" | "output">) {
		const messages: any[] = [];
		const prompts: string[] = [];
		let received: any;
		const session = {
			state: { messages },
			sessionId: "child-1",
			subscribe: () => () => {},
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
				assistantMessages: messages.filter((m) => m.role === "assistant").length,
			}),
			async prompt(text: string) {
				prompts.push(text);
				const at = Date.now();
				messages.push({ role: "user", content: [{ type: "text", text }], timestamp: at });
				const reply = replies.shift();
				if (reply === "output") {
					messages.push({ ...outputResult('{"files":["a.ts"]}'), timestamp: at });
				} else {
					messages.push({ ...assistantText("here is prose"), stopReason: "stop", timestamp: at });
				}
			},
		};
		return {
			prompts,
			received: () => received,
			create: async (o: any) => {
				received = o;
				return { session: session as any };
			},
		};
	}

	it("hands back the JSON, and gives the child the tool even past its allowlist", async () => {
		const child = scripted("output");
		const result = await runSubagent({
			def: def({ tools: ["read"] }),
			task: "t",
			ctx: ctx(),
			outputSchema: SCHEMA,
			createSession: child.create,
		});
		expect(result.status).toBe("ok");
		expect(getFinalOutput(result.messages)).toBe('{"files":["a.ts"]}');
		expect(child.received().tools).toEqual(["read", STRUCTURED_OUTPUT_TOOL]);
	});

	it("reminds a child that ended in prose once, and fails it if it still has not called the tool", async () => {
		const late = scripted("text", "output");
		const recovered = await runSubagent({
			def: def({ outputSchema: SCHEMA }),
			task: "t",
			ctx: ctx(),
			createSession: late.create,
		});
		expect(recovered.status).toBe("ok");
		expect(late.prompts).toHaveLength(2);
		expect(late.prompts[1]).toContain(STRUCTURED_OUTPUT_TOOL);

		const never = scripted("text", "text");
		const failed = await runSubagent({
			def: def({ outputSchema: SCHEMA }),
			task: "t",
			ctx: ctx(),
			createSession: never.create,
		});
		expect(failed.status).toBe("failed");
		expect(failed.stopReason).toBe("no-structured-output");
		expect(never.prompts).toHaveLength(2);
	});

	it("refuses a schema it cannot use, and an external runner, before starting anything", async () => {
		const child = scripted("output");
		const badSchema = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			outputSchema: { type: "object", properties: { a: { $ref: "#/x" } } },
			createSession: child.create,
		});
		expect(badSchema.status).toBe("failed");
		expect(badSchema.errorMessage).toMatch(/\$ref/);

		const runner = await runSubagent({
			def: def({ runner: { command: "cat", args: [] } }),
			task: "t",
			ctx: ctx(),
			outputSchema: SCHEMA,
			createSession: child.create,
		});
		expect(runner.status).toBe("failed");
		expect(runner.errorMessage).toMatch(/structured output/i);
		expect(child.received()).toBeUndefined();
	});
});
