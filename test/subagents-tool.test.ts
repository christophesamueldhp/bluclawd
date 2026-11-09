import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type TranscriptContext,
	Type,
} from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANE_ENV } from "../daemon/tmux.ts";
import { readPersistedRunRecord, subagentReportPath } from "../ext/subagents/storage.ts";
import { createParentSessionWithSubagents } from "./helpers/subagent-session.ts";
import { createSubagentTui, launch, type SubagentTui } from "./helpers/subagent-tui.ts";

const tempDirs: string[] = [];
let tui: SubagentTui | undefined;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-tool-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	tui?.dispose();
	tui = undefined;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
	}
});

/** What a run is started with: its launch flags, and the instructions file they name. */
function launchOf(t: SubagentTui, name: string) {
	const run = t.runs.find((candidate) => candidate.name === name);
	if (!run) throw new Error(`No run ${name} started.`);
	const flag = (key: string) => (run.args.includes(key) ? run.args[run.args.indexOf(key) + 1] : undefined);
	const instructions = flag("--append-system-prompt");
	return {
		model: flag("--model"),
		thinking: flag("--thinking"),
		tools: flag("--tools"),
		instructions: instructions ? readFileSync(instructions, "utf8") : undefined,
	};
}

describe("A run's role, as its launch flags", () => {
	it("runs an inline role over a same-named saved role, records its source as inline, and writes no definition file", async () => {
		const t = await createSubagentTui({ builtinTools: ["read"] });
		tui = t;
		const savedPath = join(t.agentDir, "agents", "schema-checker.md");
		mkdirSync(dirname(savedPath), { recursive: true });
		writeFileSync(savedPath, "---\nname: schema-checker\ndescription: Saved role.\n---\nSAVED-MARKER\n");
		const savedBefore = statSync(savedPath).mtimeMs;
		t.script([
			() =>
				fauxAssistantMessage([
					fauxToolCall(
						"subagent",
						{
							agent: {
								name: "schema-checker",
								description: "Checks schema files.",
								instructions: "INLINE-MARKER: inspect only the schema directory.",
								tools: ["read"],
							},
							name: "checker",
							task: "Check the schema.",
							background: true,
						},
						{ id: "inline_ok" },
					),
				]),
		]);
		await t.session.prompt("Delegate.", { expandPromptTemplates: false });
		await t.started("checker");

		expect(launchOf(t, "checker")).toMatchObject({
			instructions: "INLINE-MARKER: inspect only the schema directory.",
			tools: "read",
		});
		const runId = JSON.stringify(t.session.messages).match(/sub_[0-9a-f-]{36}/)?.[0] ?? "";
		expect(readPersistedRunRecord(t.agentDir, t.session.sessionId, runId)).toMatchObject({
			agentName: "schema-checker",
			definitionSource: "inline",
		});
		expect(readdirSync(join(t.agentDir, "agents"))).toEqual(["schema-checker.md"]);
		expect(readFileSync(savedPath, "utf8")).toContain("SAVED-MARKER");
		expect(statSync(savedPath).mtimeMs).toBe(savedBefore);
		expect(existsSync(join(t.cwd, ".pi"))).toBe(false);
	});

	it("refuses a role that names a tool the orchestrator does not have", async () => {
		const t = await createSubagentTui({ builtinTools: ["read"] });
		tui = t;
		t.script([
			() =>
				fauxAssistantMessage([
					fauxToolCall(
						"subagent",
						{
							agent: {
								name: "deployer",
								description: "Deploys.",
								instructions: "Deploy.",
								tools: ["read", "deploy"],
							},
							task: "Deploy it.",
							background: true,
						},
						{ id: "unknown_tool" },
					),
				]),
		]);
		await t.session.prompt("Delegate.", { expandPromptTemplates: false });

		const { result, text } = toolResultText(t.session, "unknown_tool");
		expect(result?.isError).toBe(true);
		expect(text).toContain('Subagent role "deployer" names tools the orchestrator cannot give a child: deploy.');
		expect(t.runs).toEqual([]);
	});

	it("starts a run on the spawn-selected model and thinking level", async () => {
		const t = await createSubagentTui();
		tui = t;
		t.script([
			() =>
				fauxAssistantMessage([
					fauxToolCall(
						"subagent",
						{
							agent: "explorer",
							name: "alt",
							task: "Report.",
							background: true,
							model: "faux-tool/faux-alt",
							thinkingLevel: "off",
						},
						{ id: "alt" },
					),
					fauxToolCall(
						"subagent",
						{ agent: "explorer", name: "deep", task: "Report.", background: true, thinkingLevel: "high" },
						{ id: "deep" },
					),
				]),
		]);
		await t.session.prompt("Delegate.", { expandPromptTemplates: false });
		await t.started("alt");
		await t.started("deep");

		expect(launchOf(t, "alt")).toMatchObject({ model: "faux-tool/faux-alt", thinking: "off" });
		expect(launchOf(t, "deep")).toMatchObject({ model: "faux-tool/faux-main", thinking: "high" });
	});
});

function toolResultText(session: { messages: readonly unknown[] }, id: string) {
	const result = session.messages.find(
		(m) => (m as { role?: string }).role === "toolResult" && (m as { toolCallId?: string }).toolCallId === id,
	) as { isError?: boolean; content: Array<{ type: string; text?: string }>; details?: unknown } | undefined;
	const text = result?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
	return { result, text };
}

describe("The subagent tool", () => {
	it("gives a foreground call only the end of a Report over 2000 lines, and where its full text is", async () => {
		const t = await createSubagentTui();
		tui = t;
		t.script([launch(["scout", "mapper"])]);
		const turn = t.session.prompt("Scout and map.", { expandPromptTemplates: false });
		await t.started("scout");
		await t.started("mapper");
		t.report("scout", Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
		t.report("mapper", "Mapped.");
		await turn;

		const scout = toolResultText(t.session, "call_scout");
		const { runId } = scout.result?.details as { runId: string };
		const reportFile = subagentReportPath(t.agentDir, t.session.sessionId, runId);
		expect(scout.text).toMatch(/\n\nline 501\n/);
		expect(scout.text).not.toMatch(/\nline 500\n/);
		expect(scout.text.endsWith(`\nline 2500\n\n[Report truncated, full text: ${reportFile}]`)).toBe(true);
		expect(scout.result?.details).toMatchObject({ truncated: true });
		const mapper = toolResultText(t.session, "call_mapper");
		expect(mapper.text).toMatch(/\n\nMapped\.$/);
		expect(mapper.result?.details).toMatchObject({ truncated: false });
	});

	it("refuses a launch outside tmux, where no run can be a pi session of its own", async () => {
		vi.stubEnv(PANE_ENV, "");
		const cwd = makeTempDir("no-tmux-cwd");
		const agentDir = makeTempDir("no-tmux-agent");
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent", { agent: "explorer", task: "Look." }, { id: "c_no_tmux" })]),
				fauxAssistantMessage("Did it myself."),
			]);
			await session.prompt("Delegate the look.", { expandPromptTemplates: false });

			const { result, text } = toolResultText(session, "c_no_tmux");
			expect(result?.isError).toBe(true);
			expect(text).toBe(
				"Subagents need tmux: each run is a pi session of its own in agent view's tmux server, and this pi does not run there. Install tmux if it is missing (brew install tmux), then start pi again in a terminal.",
			);
			expect(existsSync(join(agentDir, "bluclawd", "subagents"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("warns on conflicting third-party subagent tool registration", async () => {
		const cwd = makeTempDir("conflict-cwd");
		const agentDir = makeTempDir("conflict-agent");
		const warnings: string[] = [];

		const conflictingTool = defineTool({
			name: "subagent",
			label: "ThirdPartySubagent",
			description: "Conflicting tool",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "conflict" }], details: undefined };
			},
		});

		const { session: conflictSession } = await createParentSessionWithSubagents({
			cwd,
			agentDir,
			extraTools: [conflictingTool],
		});
		try {
			await conflictSession.bindExtensions({
				mode: "tui",
				uiContext: {
					notify: (msg: string) => warnings.push(msg),
					setStatus: () => {},
					theme: { fg: (_c: string, t: string) => t },
				} as any,
			});
			expect(warnings.some((w) => w.includes("Conflicting third-party `subagent` tool"))).toBe(true);
		} finally {
			conflictSession.dispose();
		}
	});
	describe("Ticket #7 — Uncapped saved roles", () => {
		function writeRole(dir: string, name: string, extra: string[] = []) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, `${name}.md`),
				["---", `name: ${name}`, `description: Role ${name}.`, ...extra, "---", "Do the assigned work."].join("\n"),
			);
		}

		async function routedDescription(cwd: string, agentDir: string) {
			const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
			try {
				await session.bindExtensions({ mode: "print" });
				let description = "";
				faux.setResponses([
					(context) => {
						description = getCurrentTools(context.messages).find((t) => t.name === "subagent")?.description ?? "";
						return fauxAssistantMessage("Done.");
					},
				]);
				await session.prompt("Which roles exist?", { expandPromptTemplates: false });
				return description;
			} finally {
				session.dispose();
			}
		}

		it("offers every one of 40 saved roles to the orchestrator", async () => {
			const cwd = makeTempDir("roles40-cwd");
			const agentDir = makeTempDir("roles40-agent");
			for (let i = 0; i < 30; i++) writeRole(join(agentDir, "agents"), `user-role-${i}`);
			for (let i = 0; i < 10; i++) writeRole(join(cwd, ".pi", "agents"), `project-role-${i}`);

			const description = await routedDescription(cwd, agentDir);

			for (let i = 0; i < 30; i++) expect(description).toContain(`user-role-${i}`);
			for (let i = 0; i < 10; i++) expect(description).toContain(`project-role-${i}`);
			expect(description).not.toMatch(/maxTurns/);
		});

		it("offers a saved role with a long description and large instructions", async () => {
			const cwd = makeTempDir("large-cwd");
			const agentDir = makeTempDir("large-agent");
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			const description = `Large role ${"d".repeat(600)}`;
			writeFileSync(
				join(agentDir, "agents", "large-role.md"),
				["---", "name: large-role", `description: ${description}`, "---", "x".repeat(40 * 1024)].join("\n"),
			);

			expect(await routedDescription(cwd, agentDir)).toContain(description);
		});
	});
});

describe("Ticket #10 — Per-spawn model and thinking selection", () => {
	it("lists subagent models with auth, thinking levels and execution support, without secrets", async () => {
		const cwd = makeTempDir("models-cwd");
		const agentDir = makeTempDir("models-agent");
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "sk-test-secret-123" } }),
		);
		const { session, faux, modelRuntime } = await createParentSessionWithSubagents({ cwd, agentDir });
		modelRuntime.registerVirtualModel({
			provider: "virtual-router",
			id: "auto",
			name: "Virtual Auto Router",
			thinkingLevels: ["low", "high"],
			route: () => ({ model: faux.getModel("faux-main")!, thinkingLevel: "low" }),
		});
		modelRuntime.registerNativeProvider({
			...fauxProvider({ provider: "native-unconfigured" }).provider,
			auth: { apiKey: { name: "Unconfigured", resolve: async () => undefined } },
		});
		await modelRuntime.refresh({ allowNetwork: false });
		try {
			await session.bindExtensions({ mode: "print" });
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("subagent_models", {}, { id: "all" }),
					fauxToolCall("subagent_models", { provider: "faux-tool" }, { id: "faux_only" }),
				]),
				fauxAssistantMessage("Listed."),
			]);
			await session.prompt("Which models can subagents use?", { expandPromptTemplates: false });

			const all = toolResultText(session, "all");
			expect(all.result?.isError, all.text).toBe(false);
			expect(all.text).not.toContain("sk-test-secret-123");
			const models = JSON.parse(all.text).models as Array<Record<string, unknown>>;
			expect(models.find((m) => m.provider === "anthropic" && m.auth === "configured")).toBeDefined();
			expect(models.find((m) => m.provider === "openai")).toMatchObject({
				auth: "missing",
				executionSupport: "supported",
			});
			// A native provider without stored credentials may still resolve its own auth.
			expect(models.find((m) => m.provider === "native-unconfigured")).toMatchObject({ auth: "unknown" });
			expect(models.find((m) => m.provider === "virtual-router")).toMatchObject({
				id: "auto",
				thinkingLevels: null,
				executionSupport: "unavailable",
				reason: expect.stringMatching(/router/i),
			});

			const fauxOnly = JSON.parse(toolResultText(session, "faux_only").text).models;
			expect(fauxOnly).toEqual([
				{
					provider: "faux-tool",
					id: "faux-main",
					name: "faux-main",
					auth: expect.stringMatching(/^(configured|unknown)$/),
					thinkingLevels: ["off", "minimal", "low", "medium", "high"],
					executionSupport: "supported",
				},
				{
					provider: "faux-tool",
					id: "faux-alt",
					name: "faux-alt",
					auth: expect.stringMatching(/^(configured|unknown)$/),
					thinkingLevels: ["off"],
					executionSupport: "supported",
				},
			]);
		} finally {
			session.dispose();
		}
	});

	it("lists a provider registered after the first listing without a restart", async () => {
		const cwd = makeTempDir("late-provider-cwd");
		const agentDir = makeTempDir("late-provider-agent");
		const { session, faux, modelRuntime } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			const listLate = async (id: string) => {
				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("subagent_models", { provider: "faux-late" }, { id })]),
					fauxAssistantMessage("Listed."),
				]);
				await session.prompt("List.", { expandPromptTemplates: false });
				return JSON.parse(toolResultText(session, id).text).models as Array<{ id: string }>;
			};

			expect(await listLate("before")).toEqual([]);
			modelRuntime.registerNativeProvider(
				fauxProvider({ provider: "faux-late", models: [{ id: "late-1" }] }).provider,
			);
			await modelRuntime.refresh({ allowNetwork: false });
			expect((await listLate("after")).map((m) => m.id)).toEqual(["late-1"]);
		} finally {
			session.dispose();
		}
	});
});

describe("Live finding — background availability in the subagent description", () => {
	it.each([
		["print", true],
		["rpc", false],
	] as const)("tells the %s-mode orchestrator whether background runs are available", async (mode, oneShot) => {
		const cwd = makeTempDir(`desc-${mode}-cwd`);
		const agentDir = makeTempDir(`desc-${mode}-agent`);
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode });
			let description = "";
			faux.setResponses([
				(context: TranscriptContext) => {
					description = getCurrentTools(context.messages).find((t) => t.name === "subagent")?.description ?? "";
					return fauxAssistantMessage("Done.");
				},
			]);
			await session.prompt("Look at your tools.", { expandPromptTemplates: false });
			expect(description).toContain("Available subagent roles:");
			expect(description.includes("Background runs are unavailable in this one-shot mode")).toBe(oneShot);
		} finally {
			session.dispose();
		}
	});
});
