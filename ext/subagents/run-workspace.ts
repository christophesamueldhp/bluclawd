/**
 * Where an RPC run works, as Admission resolves it: the directory it was given, or its orchestrator's; how far up
 * its project roles are looked for; and which of those directories the user trusts.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { evaluateToolCallDeny } from "../permissions/policy.ts";

export interface RunWorkspace {
	/** The run's directory, real. */
	cwd: string;
	/**
	 * Where the search for project roles stops: the repository's root; outside Git, the orchestrator's directory
	 * when the run's is in it, else the run's own.
	 */
	root: string;
	/**
	 * Whether the user trusts the project resources of `dir`, real: the orchestrator's own directory as its session
	 * does; any other, under it or not, only by a decision the user saved, as pi decides per directory. A directory
	 * never gains trust by being chosen.
	 */
	trusted(dir: string): boolean;
}

export interface LaunchingContext {
	cwd: string;
	/** Whether its own session trusts its directory's project resources. */
	projectTrusted: boolean;
	agentDir: string;
	/** The orchestrator's own deny rules. */
	denyRules: readonly string[];
}

/** The run's workspace, its directory real, readable, and one the orchestrator's own Read rules let it look into. */
export function resolveRunWorkspace(
	requested: string | undefined,
	launching: LaunchingContext,
): { ok: true; workspace: RunWorkspace } | { ok: false; error: string } {
	const path = resolve(launching.cwd, requested ?? ".");
	let cwd: string;
	try {
		cwd = realpathSync(path);
		if (!statSync(cwd).isDirectory()) return { ok: false, error: `Subagent cwd "${path}" is not a directory.` };
		accessSync(cwd, constants.R_OK | constants.X_OK);
	} catch (error) {
		return {
			ok: false,
			error: `Subagent cwd "${path}" cannot be used: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const denied = evaluateToolCallDeny(launching.denyRules, "ls", { path: cwd }, launching.cwd);
	if (denied) return { ok: false, error: `Subagent cwd "${path}": ${denied.reason}` };

	const launchingCwd = realpathSync(launching.cwd);
	const store = new ProjectTrustStore(launching.agentDir);
	return {
		ok: true,
		workspace: {
			cwd,
			root: repositoryRoot(cwd) ?? (within(launchingCwd, cwd) ? launchingCwd : cwd),
			trusted: (dir) => (dir === launchingCwd ? launching.projectTrusted : store.get(dir) === true),
		},
	};
}

function within(base: string, dir: string): boolean {
	const rel = relative(base, dir);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function repositoryRoot(cwd: string): string | undefined {
	const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 2000 });
	const top = git.status === 0 ? git.stdout.trim() : "";
	return top ? realpathSync(top) : undefined;
}
