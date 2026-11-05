/**
 * Memory extension: the orchestrator keeps Memories for its Project across sessions.
 * The Memory index is taken once per session start and appended to the system prompt
 * unchanged, so saving mid-session never breaks the prompt cache.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionFactory, getAgentDir } from "@earendil-works/pi-coding-agent";
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
		type: Type.Optional(
			Type.Union(
				[Type.Literal("user"), Type.Literal("feedback"), Type.Literal("project"), Type.Literal("reference")],
				{ description: `save: one of ${MEMORY_TYPES.join(", ")}.` },
			),
		),
		body: Type.Optional(Type.String({ description: "save: the fact." })),
	},
	{ additionalProperties: false },
);

const text = (value: string, isError = false) => ({
	content: [{ type: "text" as const, text: value }],
	details: undefined,
	...(isError ? { isError } : {}),
});

/** Where a session's Memories live: the main worktree of its git repository, or its directory outside git. */
async function resolveProject(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
	const commonDir = result.code === 0 ? result.stdout.trim() : "";
	return commonDir.endsWith("/.git") ? commonDir.slice(0, -"/.git".length) : cwd;
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
	const { text: kept, dropped } = capIndex(index);
	const note =
		dropped > 0
			? [
					"",
					`(Memory index truncated: ${dropped} more line${dropped === 1 ? "" : "s"} not shown. Merge related Memories or delete stale ones.)`,
				]
			: [];
	return [GUIDANCE, "", "## Memory index", "", kept || "(No Memories yet.)", ...note].join("\n");
}

export function createMemoryExtension(options: { agentDir?: string } = {}): ExtensionFactory {
	return (pi) => {
		const agentDir = () => options.agentDir ?? getAgentDir();
		let dir: string | undefined;
		let section: string | undefined;
		let deactivated = false;

		// The toggle is read once per session start, like the Memory index.
		pi.on("session_start", async (_event, ctx) => {
			const enabled = loadMemoryEnabled(agentDir());
			const active = pi.getActiveTools();
			if (!enabled && active.includes("memory")) {
				pi.setActiveTools(active.filter((tool) => tool !== "memory"));
				deactivated = true;
			} else if (enabled && deactivated) {
				pi.setActiveTools([...active, "memory"]);
				deactivated = false;
			}
			dir = enabled ? memoryDir(agentDir(), await resolveProject(pi, ctx.cwd)) : undefined;
			section = dir ? promptSection(readIndex(dir)) : undefined;
		});

		pi.on("before_agent_start", (event) => {
			if (section) event.systemPromptOptions.sections.memory = section;
		});

		pi.registerTool({
			name: "memory",
			label: "Memory",
			exposure: "model-only",
			description:
				"Save, read or delete a Memory of this Project. save needs description, type and body, and replaces a Memory of the same name.",
			parameters: PARAMETERS,
			execute: async (_toolCallId, params: Static<typeof PARAMETERS>) => {
				if (!dir) return text("Memory is not ready yet.", true);
				if (params.action === "read") {
					const memory = readMemory(dir, params.name);
					return memory === undefined ? text(`No Memory "${params.name}".`, true) : text(memory);
				}
				if (params.action === "delete") {
					return deleteMemory(dir, params.name)
						? text(`Deleted Memory "${params.name}".`)
						: text(`No Memory "${params.name}".`, true);
				}
				const { name, description, type, body } = params;
				if (description === undefined || type === undefined || body === undefined) {
					return text("save needs description, type and body.", true);
				}
				const memory = { name, description, type, body };
				const invalid = invalidMemory(memory);
				if (invalid) return text(invalid, true);
				saveMemory(dir, memory);
				const { dropped } = capIndex(readIndex(dir));
				return text(
					dropped > 0
						? `Saved Memory "${name}", but the Memory index is now too long: its last ${dropped} line${dropped === 1 ? "" : "s"} will not be loaded in a later session. Merge related Memories or delete stale ones.`
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
				if (!ctx.hasUI) {
					const lines = memories.map((m) => `${m.name} (${m.type}) — ${m.description}`);
					ctx.ui.notify([`Memory ${enabled ? "on" : "off"}: ${project}`, ...lines].join("\n"), "info");
					return;
				}
				const toggle = enabled ? "Turn memory off" : "Turn memory on";
				const labels = memories.map((m) => `${m.name} (${m.type}) — ${m.description}`);
				const title = `Memory ${enabled ? "on" : "off"} · ${memories.length === 0 ? "no Memories yet" : `${memories.length} Memories`}\n${project}`;
				const choice = await ctx.ui.select(title, [...labels, toggle]);
				if (!choice) return;
				if (choice === toggle) {
					saveMemoryEnabled(agentDir(), !enabled);
					ctx.ui.notify(
						`Memory turned ${enabled ? "off" : "on"}. It applies from the next session or /reload.`,
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

export default createMemoryExtension();
