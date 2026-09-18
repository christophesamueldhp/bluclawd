/**
 * `manage_agents`: the model lists, reads, creates, updates and deletes agent
 * definitions (pi-subagents' agent management actions).
 *
 * Same boundaries as `/agents new|edit|delete`, which a human drives:
 *   - only USER defs are written (`<agentDir>/agents/<name>.md`); repository files
 *     never are, and a bundled def is overridden by writing a user one;
 *   - a project's defs are read only for a trusted project.
 * Two more, because the author here is the model:
 *   - every write asks the user first, in every mode. The agent dir is a protected
 *     path — a `write` there prompts even in auto — and this tool must not be the
 *     way around that. Headless, there is nobody to ask, so writes are blocked.
 *   - a def may not declare a `permissionMode` above the session's current mode.
 *     In `ask`, a model-written `permissionMode: auto` def with bash would run
 *     unprompted the moment it is delegated to: an escalation nobody authored.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getActivePermissionMode } from "../permissions/active-mode.ts";
import { PERMISSION_MODES } from "../permissions/modes.ts";
import { type AgentDef, agentListRows, bundledAgentsDir, discoverDefs, parseDef } from "./defs.ts";

/** A name that is both a valid agent identity and a safe file name. */
export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Where a user-scoped agent definition lives. */
export const userAgentPath = (name: string): string => join(getAgentDir(), "agents", `${name}.md`);

const ManageParams = Type.Object({
	action: StringEnum(["list", "get", "create", "update", "delete"] as const, {
		description: "list: every agent; get: one definition's file; create/update/delete: a user agent definition",
	}),
	name: Type.Optional(Type.String({ description: "Agent name (letters, digits, dashes); all actions but list" })),
	content: Type.Optional(
		Type.String({
			description:
				"create/update: the full definition — markdown with frontmatter (name, description, optional tools, model, …) and the system prompt as body",
		}),
	),
});

const reply = (text: string): AgentToolResult<undefined> => ({ content: [{ type: "text", text }], details: undefined });

/** Defs this context may see: a project's only when it is trusted. */
const visibleDefs = (ctx: ExtensionContext): AgentDef[] =>
	discoverDefs(ctx.cwd, ctx.isProjectTrusted() ? "both" : "user").defs;

async function confirmWrite(ctx: ExtensionContext, title: string, body: string): Promise<string | undefined> {
	if (!ctx.hasUI)
		return "Blocked: changing agent definitions needs the user's approval, and this session is headless.";
	return (await ctx.ui.confirm(title, body)) ? undefined : "Declined by the user; nothing was changed.";
}

export function createManageAgentsTool(): ToolDefinition<typeof ManageParams, undefined> {
	return {
		name: "manage_agents",
		label: "Manage Agents",
		description:
			"List, read, create, update or delete the subagent definitions the task tool delegates to. Writes go to the user's agent directory, each after the user approves it; project definitions are read-only here.",
		parameters: ManageParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const defs = visibleDefs(ctx);
			if (params.action === "list") {
				const rows = agentListRows(defs, bundledAgentsDir());
				return reply(
					rows.map((r) => `- ${r.name} (${r.origin}): ${r.description} [${r.notes}]`).join("\n") || "No agents.",
				);
			}

			const name = params.name?.trim() ?? "";
			if (!AGENT_NAME.test(name)) return reply("Give a name: letters, digits and dashes.");
			const path = userAgentPath(name);
			const current = defs.find((d) => d.name === name);

			if (params.action === "get") {
				if (!current) return reply(`No agent named "${name}".`);
				return reply(`${current.filePath}\n\n${readFileSync(current.filePath, "utf-8")}`);
			}

			if (current?.source === "project") {
				return reply(
					`"${name}" is a project agent at ${current.filePath}. Repository files are not written here, and a user definition of that name would be overridden by it.`,
				);
			}

			if (params.action === "delete") {
				if (!existsSync(path)) {
					return reply(
						current
							? `"${name}" is bundled and cannot be deleted; update it to override it.`
							: `No user agent named "${name}".`,
					);
				}
				const refused = await confirmWrite(ctx, "Delete agent?", `${name}\n${path}`);
				if (refused) return reply(refused);
				unlinkSync(path);
				const bundled = existsSync(join(bundledAgentsDir(), `${name}.md`));
				return reply(`Deleted ${path}${bundled ? ` — the bundled ${name} applies again.` : ""}`);
			}

			// create / update
			const content = params.content ?? "";
			if (!content.trim()) return reply("Give the full definition in content.");
			if (params.action === "create" && current) {
				return reply(`"${name}" already exists (${current.filePath}); use update.`);
			}
			if (params.action === "update" && !current) return reply(`No agent named "${name}"; use create.`);
			const parsed = parseDef(content);
			if ("problem" in parsed) return reply(`Not saved: ${parsed.problem}.`);
			if (parsed.name !== name) {
				return reply(
					`Not saved: the frontmatter says name: ${parsed.name}, the call says ${name}. Renames are not supported here.`,
				);
			}
			const active = getActivePermissionMode();
			if (
				parsed.permissionMode &&
				PERMISSION_MODES.indexOf(parsed.permissionMode) > PERMISSION_MODES.indexOf(active)
			) {
				return reply(
					`Not saved: permissionMode: ${parsed.permissionMode} is above this session's mode (${active}). Only the user can grant that, with /agents edit ${name}.`,
				);
			}

			const refused = await confirmWrite(
				ctx,
				`${params.action === "create" ? "Create" : "Update"} agent "${name}"?`,
				`${path}\n\n${content}`,
			);
			if (refused) return reply(refused);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
			return reply(`Saved ${path}. The task tool can delegate to "${name}" now.`);
		},
	};
}
