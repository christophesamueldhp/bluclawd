/**
 * Memory extension: the orchestrator keeps Memories for its Project across sessions.
 * The Memory index is taken once per session start and appended to the system prompt
 * unchanged, so saving mid-session never breaks the prompt cache.
 */

import { basename, dirname, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionFactory, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { sharedRef } from "../_shared/global-state.ts";
import { toolOffNoticeOnce, turnOnHint } from "../_shared/notice-once.ts";
import { readSettings, type StartupSettings, startupSettings } from "../_shared/startup-settings.ts";
import { timed } from "../_shared/timing.ts";
import { loadMemoryEnabled, saveMemoryEnabled } from "./prefs.ts";
import {
	capIndex,
	deleteMemory,
	invalidMemory,
	listMemories,
	MEMORY_TYPES,
	memoryDir,
	readIndex,
	readMemory,
	saveMemory,
} from "./store.ts";

const PARAMETERS = Type.Object(
	{
		action: Type.Union([Type.Literal("save"), Type.Literal("read"), Type.Literal("delete")]),
		name: Type.String({ description: "Kebab-case slug naming the Memory; saving an existing name replaces it." }),
		description: Type.Optional(Type.String({ description: "save: one line for the Memory index." })),
		type: Type.Optional(Type.Union(MEMORY_TYPES.map((type) => Type.Literal(type)))),
		body: Type.Optional(Type.String({ description: "save: the fact." })),
	},
	{ additionalProperties: false },
);

const reply = (text: string, isError = false) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
	isError,
});

const TIDY_UP = "Merge related Memories or delete stale ones.";
/**
 * How to turn the memory tool on, for a session without it. pi restores a resumed session's tools without applying
 * `defaultTools`, so a user whose setting names the tool needs a new session or `--tools`.
 */
const memoryHint = ({ settings }: StartupSettings) =>
	settings.getDefaultTools()?.includes("memory")
		? 'Your "defaultTools" setting has it, but this session was started without it, so it applies from a new session. For this session, resume it with pi --tools +memory.'
		: turnOnHint("memory");
const toolOff = (hint: string) => `The memory tool is off, so this session neither loads nor saves Memories. ${hint}`;
const memoriesUnread = (hint: string) =>
	`This Project has Memories, but the memory tool is off by default now, so this session neither loads nor saves them. ${hint}`;
/**
 * The sessions the user's `defaultTools` or `--tools` gave the memory tool. A /reload loads this extension anew,
 * and keeps the tool left out when `/memory` was off at the session's start.
 */
const sessionsGivenTool = sharedRef("memory.toolSessions", new Set<string>());
const lines = (count: number) => `${count} line${count === 1 ? "" : "s"}`;

/**
 * Where a session's Memories live: the git repository's main worktree, or, for a bare
 * repository or a submodule, its shared git directory; outside git, the session's directory.
 * Every worktree and subdirectory of a repository shares that git directory.
 */
async function resolveProject(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd });
	if (result.code !== 0) return cwd;
	const commonDir = resolve(cwd, result.stdout.trim());
	return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
}

const GUIDANCE = `# Memory

You keep Memories for this project across sessions with the \`memory\` tool: one fact per Memory. The Memory index below lists them as they were when this session started; \`memory\` read gives a Memory's full text when it is relevant.

Types:
- user: who the user is (role, expertise, preferences).
- feedback: guidance the user gave on how you should work, both corrections and approaches they confirmed.
- project: ongoing work, goals or constraints not visible in the code or git history.
- reference: pointers to external resources (URLs, dashboards, tickets).
For feedback and project Memories, follow the fact with **Why:** and **How to apply:** lines.

Be selective: most sessions save nothing. Never save secrets or credentials, anything the repository already records (code structure, file paths, past fixes, git history), anything AGENTS.md or CLAUDE.md already say, or what only matters to this conversation. Before saving, check the index for a Memory that already covers it and save under that name to update it. Delete a Memory that turns out to be wrong. Write an absolute date in place of a relative one ("Thursday" becomes the date).`;

function promptSection(index: string): string {
	const { kept, dropped } = capIndex(index);
	const note = dropped > 0 ? ["", `(Memory index truncated: ${lines(dropped)} more not shown. ${TIDY_UP})`] : [];
	return [GUIDANCE, "", "## Memory index", "", kept || "(No Memories yet.)", ...note].join("\n");
}

export function createMemoryExtension(options: { agentDir?: string } = {}): ExtensionFactory {
	return (pi) => {
		const agentDir = () => options.agentDir ?? getAgentDir();
		let dir: string | undefined;
		let section: string | undefined;
		/** Whether the user's `defaultTools` or `--tools` gave this session the memory tool, active or not. */
		let toolGiven = false;

		// The toggle is read once per session start, like the Memory index. pi registers tools
		// when it loads the extension, so turned off, the tool is left out of the active set.
		// The section goes with the tool.
		pi.on("session_start", async (event, ctx) => {
			const enabled = loadMemoryEnabled(agentDir());
			const toolActive = pi.getActiveTools().includes("memory");
			const session = ctx.sessionManager.getSessionId();
			toolGiven = toolActive || (event.reason === "reload" && sessionsGivenTool.get().has(session));
			if (toolGiven) sessionsGivenTool.get().add(session);
			if (!enabled) pi.setActiveTools(pi.getActiveTools().filter((tool) => tool !== "memory"));
			dir = enabled ? memoryDir(agentDir(), await resolveProject(pi, ctx.cwd)) : undefined;
			const index = dir ? readIndex(dir) : "";
			section = dir && toolActive ? promptSection(index) : undefined;
			if (!toolGiven && index.trim())
				toolOffNoticeOnce(
					ctx,
					agentDir(),
					"memory-tool-off",
					memoriesUnread(memoryHint(startupSettings(event, ctx))),
				);
		});

		pi.on("before_agent_start", (event) => {
			if (section) event.systemPromptOptions.sections.memory = section;
		});

		pi.registerTool({
			name: "memory",
			label: "Memory",
			exposure: "model-only",
			// Off unless the user's `defaultTools` or `--tools` names it: few sessions call it, and every request pays for it.
			defaultActive: false,
			description:
				"Save, read or delete a Memory of this Project. save needs description, type and body, and replaces a Memory of the same name.",
			parameters: PARAMETERS,
			execute: async (_toolCallId, params: Static<typeof PARAMETERS>) => {
				if (!dir)
					return reply("Memory is turned off for this session; the user can turn it on with /memory.", true);
				if (params.action === "read") {
					const memory = readMemory(dir, params.name);
					return memory === undefined ? reply(`No Memory "${params.name}".`, true) : reply(memory);
				}
				if (params.action === "delete") {
					const deleted = deleteMemory(dir, params.name);
					return reply(deleted ? `Deleted Memory "${params.name}".` : `No Memory "${params.name}".`, !deleted);
				}
				const { name, description, type, body } = params;
				if (description === undefined || type === undefined || body === undefined) {
					return reply("save needs description, type and body.", true);
				}
				const memory = { name, description, type, body };
				const invalid = invalidMemory(memory);
				if (invalid) return reply(invalid, true);
				saveMemory(dir, memory);
				const { dropped } = capIndex(readIndex(dir));
				return reply(
					dropped > 0
						? `Saved Memory "${name}", but the Memory index is now too long: its last ${lines(dropped)} will not be loaded in a later session. ${TIDY_UP}`
						: `Saved Memory "${name}".`,
				);
			},
		});

		pi.registerCommand("memory", {
			description: "List, view or delete this project's Memories, or turn memory on or off",
			handler: async (_args, ctx) => {
				const enabled = loadMemoryEnabled(agentDir());
				const project = dir ?? memoryDir(agentDir(), await resolveProject(pi, ctx.cwd));
				const memories = listMemories(project);
				const labels = memories.map((m) => `${m.name} (${m.type}) — ${m.description}`);
				const status = `Memory ${enabled ? "on" : "off"}`;
				const toolNote = toolGiven ? [] : [toolOff(memoryHint(readSettings(ctx)))];
				if (!ctx.hasUI) {
					ctx.ui.notify([`${status}: ${project}`, ...toolNote, ...labels].join("\n"), "info");
					return;
				}
				const toggle = enabled ? "Turn memory off" : "Turn memory on";
				const title = [
					`${status} · ${memories.length === 0 ? "no Memories yet" : `${memories.length} Memories`}`,
					project,
					...toolNote,
				].join("\n");
				const choice = await ctx.ui.select(title, [...labels, toggle]);
				if (!choice) return;
				if (choice === toggle) {
					saveMemoryEnabled(agentDir(), !enabled);
					// pi's /reload keeps a tool left out of the active set at session start left out.
					ctx.ui.notify(
						enabled
							? "Memory turned off. It applies from the next session or /reload."
							: ["Memory turned on. It applies from the next session.", ...toolNote].join("\n"),
						"info",
					);
					return;
				}
				const memory = memories[labels.indexOf(choice)];
				const action = await ctx.ui.select(readMemory(project, memory.name) ?? memory.name, ["Delete", "Back"]);
				if (action !== "Delete") return;
				ctx.ui.notify(
					deleteMemory(project, memory.name) ? `Deleted Memory "${memory.name}".` : `No Memory "${memory.name}".`,
					"info",
				);
			},
		});
	};
}

export default timed("memory", createMemoryExtension());
