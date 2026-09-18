import { describe, expect, it } from "vitest";
import { evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";
import { childLoaderOptions, uiSupervisor } from "../ext/subagents/engine.ts";
import { createSupervisorExtension, UNANSWERED } from "../ext/subagents/supervisor.ts";

function loadTool(ext: any) {
	let tool: any;
	ext.factory({
		registerTool: (t: any) => {
			tool = t;
		},
	});
	return tool;
}

const text = (r: any) => r.content[0].text as string;

describe("contact_supervisor", () => {
	it("returns the user's answer, naming the asking agent", async () => {
		let asked: any;
		const tool = loadTool(
			createSupervisorExtension("worker", async (q) => {
				asked = q;
				return " use the v2 API ";
			}),
		);
		expect(tool.name).toBe("contact_supervisor");
		const result = await tool.execute("id", { question: "v1 or v2?" }, undefined);
		expect(asked).toMatchObject({ agent: "worker", question: "v1 or v2?" });
		expect(text(result)).toBe("The user answered: use the v2 API");
	});

	it("tells the child to decide conservatively when nobody answers or the dialog fails", async () => {
		const dismissed = loadTool(createSupervisorExtension("w", async () => undefined));
		expect(text(await dismissed.execute("id", { question: "q" }))).toBe(UNANSWERED);
		const broken = loadTool(
			createSupervisorExtension("w", async () => {
				throw new Error("ui gone");
			}),
		);
		expect(text(await broken.execute("id", { question: "q" }))).toBe(UNANSWERED);
	});
});

describe("uiSupervisor", () => {
	it("is absent without a UI, and asks through ui.input with one", async () => {
		expect(uiSupervisor({ hasUI: false } as any)).toBeUndefined();
		let title = "";
		const ask = uiSupervisor({
			hasUI: true,
			ui: {
				input: async (t: string) => {
					title = t;
					return "yes";
				},
			},
		} as any);
		expect(await ask?.({ agent: "oracle", question: "ship it?" })).toBe("yes");
		expect(title).toContain('Subagent "oracle" asks: ship it?');
	});

	it("does not show a question for a child already stopped", async () => {
		let shown = false;
		const ask = uiSupervisor({
			hasUI: true,
			ui: {
				input: async () => {
					shown = true;
					return "x";
				},
			},
		} as any);
		const controller = new AbortController();
		controller.abort();
		expect(await ask?.({ agent: "a", question: "q", signal: controller.signal })).toBeUndefined();
		expect(shown).toBe(false);
	});

	it("gives the child the tool only when there is someone to ask", () => {
		const ctx = { cwd: process.cwd(), isProjectTrusted: () => false } as any;
		const def = { name: "w", description: "d", systemPrompt: "", source: "user", filePath: "/x/w.md" } as any;
		const names = (ask?: any) =>
			childLoaderOptions(ctx, def, { mode: "auto", ask }).extensionFactories?.map((e: any) => e.name);
		expect(names()).not.toContain("subagent-supervisor");
		expect(names(async () => "a")).toContain("subagent-supervisor");
	});
});

describe("contact_supervisor and the permission modes", () => {
	it("never prompts for permission to ask the user a question", () => {
		const cfg = {
			mode: "ask" as const,
			rules: {},
			cliAllowRules: {},
			cwd: process.cwd(),
			agentDir: "/nowhere",
			configDirName: ".pi",
			hasUI: true,
		};
		const input = { question: "q" };
		const verdict =
			evaluatePreHook("contact_supervisor", input, cfg) ?? evaluatePostHook("contact_supervisor", input, cfg);
		expect(verdict.outcome).toBe("allow");
	});
});
