// Measures the Prompt footprint (GLOSSARY.md): the text bluclawd adds to what a session's model reads with a request.
// Each session runs in-process on a faux provider, so no model is called, and what the provider receives is compared
// with pi's own baseline: the same session without bluclawd. Prints the orchestrator's in its default profile and with
// all tools declared, then a run's for each bundled role.
//
//   node scripts/prompt-footprint.ts
//
// `capturePrompt` and `capturePrefixes` are also used by test/prompt-footprint.test.ts, which holds the
// orchestrator's footprint in both profiles and each bundled role's run footprint under a ceiling, and the request
// prefix stable.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentTools,
	type Message,
	type SystemMessage,
	type Tool,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { toolChars } from "../ext/help/diagnostics.ts";
import { type AgentDefinition, discoverAgentDefinitions } from "../ext/subagents/definitions.ts";
import { SUBAGENT_MESSAGE_TOOL } from "../ext/subagents/messages.ts";
import { REPORT_INSTRUCTIONS, rpcGrantableTools, rpcRunTools, WORKTREE_TOOLS } from "../ext/subagents/rpc-runs.ts";
import { type IsolatedWorkspace, workspaceInstructions } from "../ext/subagents/run-worktree.ts";
import { createRunId } from "../ext/subagents/runs.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The extensions that register tools, in package.json's order: the orchestrator's footprint is theirs. */
export const ORCHESTRATOR_EXTENSIONS = [
	"ext/background-bash/index.ts",
	"ext/subagents/index.ts",
	"ext/web/index.ts",
	"ext/memory/index.ts",
];

/** The one bluclawd extension a run's pi loads. */
const RUN_EXTENSIONS = ["ext/subagents/rpc-child.ts"];

/** pi's built-in extensions left out: a run's pi has none (`-ne`), and the orchestrator is measured as in #337. */
const DISABLED_BUILTINS = ["mcp", "codemode", "tool_search"];

/** A user's settings that change the text of bluclawd's tools, unset while measuring. */
const PROMPT_ENV = ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS", "BLUCLAWD_DISABLE_BACKGROUND_TASKS"];

const CHARS_PER_TOKEN = 4;

/** The tools a session declares, as the user picks them in pi: its `defaultTools` setting, or `--tools`; pi's defaults when neither is set. */
export interface Profile {
	defaultTools?: string[];
	tools?: string[];
}

/** Every tool bluclawd registers inactive turned on, except `collaborator_message`, which a collaboration turns on. */
export const ALL_TOOLS: Profile = { defaultTools: ["+monitor", "+schedule_wakeup", "+memory"] };

export interface Contribution {
	name: string;
	/** Negative where bluclawd's text replaces a longer one of pi's. */
	chars: number;
}

export interface CapturedPrompt {
	/** The system message and tools of the session's first request. */
	system: SystemMessage;
	tools: Tool[];
	/** For a role, the tools its run gets. */
	runTools?: string[];
	/** Characters of the whole prompt, with bluclawd and in pi's own baseline. */
	total: number;
	baseline: number;
	footprint: number;
	contributions: Contribution[];
}

interface Scratch {
	cwd: string;
	agentDir: string;
}

/** Runs `fn` in fresh directories, with pi's agent and server directories in them; removes them after. */
async function inScratch<T>(fn: (scratch: Scratch) => Promise<T>): Promise<T> {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-footprint-")));
	const scratch = { cwd: join(base, "work"), agentDir: join(base, "agent") };
	for (const dir of Object.values(scratch)) mkdirSync(dir);
	mkdirSync(join(base, "server"));
	// Its own Project: no Memories, roles or instructions of the checkout it runs from.
	execFileSync("git", ["init", "-q"], { cwd: scratch.cwd });
	const set: Record<string, string | undefined> = {
		PI_CODING_AGENT_DIR: scratch.agentDir,
		PI_SERVER_DIR: join(base, "server"),
		...Object.fromEntries(PROMPT_ENV.map((name) => [name, undefined])),
	};
	const saved = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
	const assign = (values: Record<string, string | undefined>) => {
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	assign(set);
	try {
		return await fn(scratch);
	} finally {
		assign(saved);
		rmSync(base, { recursive: true, force: true });
	}
}

async function loadExtensions(paths: readonly string[]): Promise<ExtensionFactory[]> {
	return Promise.all(
		paths.map(
			async (path) => (await import(isAbsolute(path) ? path : resolve(REPO, path))).default as ExtensionFactory,
		),
	);
}

interface SessionSpec extends Profile {
	extensions?: ExtensionFactory[];
	appendSystemPrompt?: string;
	/** An orchestrator runs in pi's TUI, a run on its RPC. */
	mode: "tui" | "rpc";
}

const silentUi = new Proxy({}, { get: () => () => {} }) as ExtensionUIContext;

async function openSession({ cwd, agentDir }: Scratch, spec: SessionSpec) {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({ provider: "faux-footprint", models: [{ id: "faux-main" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		...(spec.defaultTools ? { defaultTools: spec.defaultTools } : {}),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: spec.extensions ?? [],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: DISABLED_BUILTINS,
		...(spec.appendSystemPrompt ? { appendSystemPrompt: [spec.appendSystemPrompt] } : {}),
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel("faux-main"),
		thinkingLevel: "low",
		...(spec.tools ? { tools: spec.tools } : {}),
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	await session.bindExtensions(spec.mode === "tui" ? { mode: "tui", uiContext: silentUi } : { mode: spec.mode });
	return { session, faux };
}

/** The context of the session's first request, for one prompt answered at once. */
async function firstRequest(scratch: Scratch, spec: SessionSpec): Promise<{ context: Context; session: AgentSession }> {
	const { session, faux } = await openSession(scratch, spec);
	let context: Context | undefined;
	faux.setResponses([
		(seen) => {
			context = seen;
			return fauxAssistantMessage("ok");
		},
	]);
	await session.prompt("hi", { expandPromptTemplates: false });
	session.dispose();
	if (!context) throw new Error("The session made no request.");
	return { context, session };
}

interface Prompt {
	system: SystemMessage;
	sections: Record<string, string>;
	tools: Tool[];
	/** What the request carries besides the system messages and the user's prompt. */
	reminders: Message[];
}

function promptOf(context: Context): Prompt {
	const system = getCurrentSystemMessage(context.messages);
	if (typeof system?.content !== "string" || system.content) throw new Error("Expected a sectioned system prompt.");
	const conversation = context.messages.filter((message) => message.role !== "system");
	return {
		system,
		sections: Object.fromEntries(
			Object.entries(system.sections ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
		),
		tools: getCurrentTools(context.messages),
		reminders: conversation.slice(0, -1),
	};
}

const reminderChars = (message: Message) => JSON.stringify("content" in message ? message.content : "").length;

function promptChars(prompt: Prompt): number {
	return (
		Object.values(prompt.sections).reduce((sum, text) => sum + text.length, 0) +
		prompt.tools.reduce((sum, tool) => sum + toolChars(tool), 0) +
		prompt.reminders.reduce((sum, message) => sum + reminderChars(message), 0)
	);
}

/** The lines of `text` not in `other`, each as often as it is there more. */
function extraLines(text: string, other: string): string[] {
	const left = other.split("\n");
	return text.split("\n").filter((line) => {
		const at = left.indexOf(line);
		if (at === -1) return true;
		left.splice(at, 1);
		return false;
	});
}

const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

/** What `measured` has that `baseline` does not, one row per tool, section, snippet, guideline and reminder. */
function contributions(measured: Prompt, baseline: Prompt): Contribution[] {
	const rows: Contribution[] = [];
	for (const tool of measured.tools) {
		const piTool = baseline.tools.find((candidate) => candidate.name === tool.name);
		const parts = `description ${tool.description.length}, schema ${JSON.stringify(tool.parameters).length}`;
		if (!piTool) rows.push({ name: `tool ${tool.name} (${parts})`, chars: toolChars(tool) });
		else if (JSON.stringify(piTool) !== JSON.stringify(tool)) {
			rows.push({ name: `tool ${tool.name}, changed from pi's`, chars: toolChars(tool) - toolChars(piTool) });
		}
	}
	for (const tool of baseline.tools) {
		if (!measured.tools.some((candidate) => candidate.name === tool.name)) {
			rows.push({ name: `tool ${tool.name}, removed`, chars: -toolChars(tool) });
		}
	}
	// pi's snippet per tool and its guidelines are lines of its `tools` and `rules` sections.
	const kinds: Record<string, string> = { tools: "snippet", rules: "guideline" };
	for (const [name, text] of Object.entries(measured.sections)) {
		const piText = baseline.sections[name];
		if (piText === undefined) rows.push({ name: `section <${name}>`, chars: text.length });
		else if (piText !== text && kinds[name]) {
			for (const line of extraLines(text, piText))
				rows.push({ name: `${kinds[name]} ${clip(line)}`, chars: line.length + 1 });
			for (const line of extraLines(piText, text)) {
				rows.push({ name: `${kinds[name]} removed: ${clip(line)}`, chars: -(line.length + 1) });
			}
		} else if (piText !== text) rows.push({ name: `section <${name}>, changed`, chars: text.length - piText.length });
	}
	for (const [name, text] of Object.entries(baseline.sections)) {
		if (measured.sections[name] === undefined) rows.push({ name: `section <${name}>, removed`, chars: -text.length });
	}
	for (const message of measured.reminders) {
		const kind = "customType" in message ? String(message.customType) : message.role;
		rows.push({ name: `reminder ${kind}`, chars: reminderChars(message) });
	}
	return rows;
}

/**
 * What a run of `definition` is told besides pi's prompt, as rpc-runs.ts writes it: its role's instructions, its
 * workspace's, then its Report's.
 */
function runInstructions(definition: AgentDefinition, tools: string[]): string {
	const runId = createRunId();
	// A run given a tool that changes files works in a worktree of its own, which it is told of.
	const writes = tools.some((tool) => WORKTREE_TOOLS.includes(tool));
	// Paths of a typical machine, not this one's: the figure does not move with where it is measured.
	const workspace = {
		root: `/Users/user/.pi/agent/bluclawd/worktrees/${runId}`,
		baseline: { source: "/Users/user/Projects/project" },
	};
	return (
		definition.instructions +
		(writes ? `\n${workspaceInstructions(workspace as IsolatedWorkspace, true, tools.includes("bash"))}` : "") +
		REPORT_INSTRUCTIONS
	);
}

/**
 * The prompt of a session loading `extensions` in `profile`, with what each contributes against pi's own baseline.
 * With `role`, the session is a run of that bundled role, given what pi's default orchestrator can give it, with a
 * shell where this platform contains a run's commands.
 */
export async function capturePrompt(
	options: { extensions?: readonly string[]; role?: string } & Profile = {},
): Promise<CapturedPrompt> {
	const { role, extensions: paths, ...profile } = options;
	const extensions = await loadExtensions(paths ?? (role ? RUN_EXTENSIONS : ORCHESTRATOR_EXTENSIONS));
	return inScratch(async (scratch) => {
		const piDefault = await firstRequest(scratch, { mode: "tui" });
		let measuredSpec: SessionSpec = { extensions, ...profile, mode: "tui" };
		let baselineSpec: SessionSpec | undefined;
		let runTools: string[] | undefined;
		if (role) {
			const definition = discoverAgentDefinitions({ cwd: scratch.cwd, agentDir: scratch.agentDir }).definitions.find(
				(candidate) => candidate.name === role && candidate.source === "bundled",
			);
			if (!definition) throw new Error(`No bundled role ${role}.`);
			const available = rpcGrantableTools(
				piDefault.session.getActiveToolNames(),
				piDefault.session.getAllTools().map((tool) => tool.name),
			);
			const shell =
				process.platform === "darwin"
					? ({ ok: true, helper: "" } as const)
					: ({ ok: false, reason: `no run gets a shell on ${process.platform}` } as const);
			const granted = rpcRunTools(definition, available, shell);
			if (!granted.ok) throw new Error(granted.error);
			runTools = granted.tools;
			baselineSpec = { tools: runTools, mode: "rpc" };
			measuredSpec = {
				extensions,
				tools: [...runTools, SUBAGENT_MESSAGE_TOOL],
				appendSystemPrompt: runInstructions(definition, runTools),
				mode: "rpc",
			};
		}
		const baseline = promptOf(baselineSpec ? (await firstRequest(scratch, baselineSpec)).context : piDefault.context);
		const { context } = await firstRequest(scratch, measuredSpec);
		const measured = promptOf(context);
		const total = promptChars(measured);
		return {
			system: measured.system,
			tools: measured.tools,
			...(runTools ? { runTools } : {}),
			total,
			baseline: promptChars(baseline),
			footprint: total - promptChars(baseline),
			contributions: contributions(measured, baseline),
		};
	});
}

/**
 * The system messages and tools of three requests in a row of a session loading `extensions` in `profile`: a tool
 * call, its result, then a second prompt. The provider caches a request's prefix only while these stay the same.
 */
export async function capturePrefixes(
	profile: Profile = {},
	extensions: readonly string[] = ORCHESTRATOR_EXTENSIONS,
): Promise<string[]> {
	const factories = await loadExtensions(extensions);
	return inScratch(async (scratch) => {
		const { session, faux } = await openSession(scratch, { extensions: factories, ...profile, mode: "tui" });
		const prefixes: string[] = [];
		const prefix = (context: Context) => {
			const system = context.messages
				.filter((message) => message.role === "system")
				.map(({ timestamp: _, ...message }) => message);
			prefixes.push(JSON.stringify({ system, tools: getCurrentTools(context.messages) }));
		};
		faux.setResponses([
			(context) => {
				prefix(context);
				return fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi", description: "Print hi" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				prefix(context);
				return fauxAssistantMessage("done");
			},
			(context) => {
				prefix(context);
				return fauxAssistantMessage("again");
			},
		]);
		await session.prompt("hi", { expandPromptTemplates: false });
		await session.prompt("more", { expandPromptTemplates: false });
		session.dispose();
		return prefixes;
	});
}

const tokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

function print(title: string, captured: CapturedPrompt): void {
	console.log(`\n${title}`);
	if (captured.runTools) console.log(`Tools: ${captured.runTools.join(", ")}, ${SUBAGENT_MESSAGE_TOOL}`);
	const rows = [...captured.contributions].sort((a, b) => b.chars - a.chars);
	const width = Math.max(...rows.map((row) => row.name.length), 20);
	console.log(`${"Contribution".padEnd(width)}  ${"Chars".padStart(7)}  ${"~Tokens".padStart(7)}`);
	for (const row of rows) {
		console.log(
			`${row.name.padEnd(width)}  ${String(row.chars).padStart(7)}  ${String(tokens(row.chars)).padStart(7)}`,
		);
	}
	for (const [name, chars] of [
		["Footprint", captured.footprint],
		["pi's baseline", captured.baseline],
		["Total", captured.total],
	] as const) {
		console.log(`${name.padEnd(width)}  ${String(chars).padStart(7)}  ${String(tokens(chars)).padStart(7)}`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	console.log(
		`Prompt footprint on ${process.platform}, TUI mode, empty Memory index, no AGENTS.md or skills, the bundled roles.`,
	);
	print("Orchestrator, default profile", await capturePrompt());
	print(
		`Orchestrator, all tools declared (defaultTools ${ALL_TOOLS.defaultTools?.join(", ")})`,
		await capturePrompt(ALL_TOOLS),
	);
	const roles = readdirSync(resolve(REPO, "ext/subagents/agents")).map((file) => file.replace(/\.md$/, ""));
	for (const name of roles) print(`Run of ${name}`, await capturePrompt({ role: name }));
}
