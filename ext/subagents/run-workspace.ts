import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { evaluateToolCallDeny } from "../permissions/policy.ts";
import type { WorkspaceSnapshot } from "./runs.ts";

export interface RunWorkspace {
	cwd: string;
	root: string;
	trusted(dir: string): boolean;
}

export interface LaunchingContext {
	cwd: string;
	projectTrusted: boolean;
	agentDir: string;
	denyRules: readonly string[];
}

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

export function within(base: string, dir: string): boolean {
	const rel = relative(base, dir);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function repositoryRoot(cwd: string): string | undefined {
	const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 2000 });
	const top = git.status === 0 ? git.stdout.trim() : "";
	return top ? realpathSync(top) : undefined;
}

export function captureWorkspaceSnapshot(cwd: string): WorkspaceSnapshot {
	try {
		const headRes = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
		});
		const headCommit = headRes.status === 0 ? headRes.stdout.trim() || null : null;

		const statusRes = spawnSync("git", ["status", "--porcelain=v1", "-uall"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
		});
		if (statusRes.status !== 0) {
			return { headCommit, dirty: false, statusDigest: "" };
		}
		const rawStatus = statusRes.stdout ?? "";
		const dirty = rawStatus.trim().length > 0;
		const statusDigest = dirty ? createHash("sha256").update(rawStatus).digest("hex").slice(0, 16) : "";
		return { headCommit, dirty, statusDigest };
	} catch {
		return { headCommit: null, dirty: false, statusDigest: "" };
	}
}
