/**
 * Workspace cleanup: the user, never a model, removes the worktree of a finished run of this session that edits. Its
 * sessions and Reports stay. A worktree that held changes cannot be made again, so its run can no longer be resumed;
 * one that held none is made again from its baseline by a Resume.
 */
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { processAlive } from "../../daemon/processes.ts";
import { formatRunLabel } from "./admission.ts";
import type { RunDirectory } from "./directory.ts";
import type { ParentScope } from "./parent-scope.ts";
import { readRpcHostState } from "./rpc-host.ts";
import { readRunDefinition, runDefinitionPath } from "./rpc-runs.ts";
import { within } from "./run-workspace.ts";
import { cleanWorktree, listChanges, UNLISTED } from "./run-worktree.ts";
import { subagentRunDir } from "./storage.ts";

const USAGE = "/clean-workspace <subagent name or run ID>";

export function registerWorkspaceCleanup(
	pi: ExtensionAPI,
	deps: {
		agentDir(): string;
		scope(): ParentScope | undefined;
		directory: Pick<RunDirectory, "find" | "list">;
	},
): void {
	pi.registerCommand("clean-workspace", {
		description: `Remove the worktree of a finished subagent of this session: ${USAGE}. Changes in it are lost, and it can then no longer be resumed; its transcript and Reports stay`,
		handler: async (args, ctx) => {
			const tell = (message: string, level: "info" | "warning" = "info") => ctx.ui.notify(message, level);
			const target = args.trim();
			if (!target) return tell(`Name the subagent: ${USAGE}`, "warning");
			const scope = deps.scope();
			const entry = scope && deps.directory.find(scope, target);
			if (!entry) return tell(`No subagent "${target}" in this session.`, "warning");
			const { record } = entry;
			const label = formatRunLabel(record);
			const agentDir = deps.agentDir();
			const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
			/** Why the run may not lose its worktree now: it, or a Resume of it, still runs. */
			const busy = () => {
				const now = deps.directory.find(scope, record.runId);
				const host = readRpcHostState(runDir);
				if (now?.state === "finished" && !(host && host.exit === undefined && processAlive(host.hostPid))) return;
				return `${label} is still ${now?.record.status ?? record.status}: stop it, or let it finish, before cleaning up its workspace.`;
			};
			const running = busy();
			if (running) return tell(running, "warning");
			const workspace = readRunDefinition(runDefinitionPath(runDir, 0))?.workspace;
			if (!workspace) {
				return tell(`${label} has no worktree of its own: it worked in ${record.cwd}, which stays.`, "warning");
			}
			/** A later step of the run's chain may work in its worktree. */
			const inUse = () => {
				const occupant = deps.directory
					.list(scope)
					.find(({ record: run }) => within(workspace.root, run.cwd))?.record;
				return (
					occupant &&
					`${workspace.root} is in use by ${formatRunLabel(occupant)}: let it finish, or stop it, first.`
				);
			};
			const occupied = inUse();
			if (occupied) return tell(occupied, "warning");
			const gone = !existsSync(workspace.root);
			try {
				const removal = await cleanWorktree(
					workspace,
					{ agentDir, runId: record.runId, runDir },
					() => busy() ?? inUse(),
				);
				if (gone) {
					return tell(
						`${workspace.root} was removed already; ${label} ${removal.restorable ? "can still be resumed, its worktree made again" : "can no longer be resumed"}.`,
					);
				}
				tell(
					removal.restorable
						? `Removed ${workspace.root}: it held no change since its baseline, so ${label} can still be resumed, its worktree made again.`
						: `Removed ${workspace.root} with its changes (${listChanges(removal.changes, UNLISTED)}); ${label} can no longer be resumed. Its transcript and Reports are kept.`,
				);
			} catch (error) {
				tell(
					`Could not remove ${workspace.root}: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		},
	});
}
