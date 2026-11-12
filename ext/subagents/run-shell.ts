/**
 * The shell of a run that may run commands (spec §6, §10): every command runs in Anthropic's sandbox runtime under a
 * policy of the run's own, whether or not the user's interactive sandbox is on, and its processes end with it. The
 * policy is built here, never taken from the user's `sandbox` setting, which may only narrow it: writes only in the
 * run's worktree and its own temp directory, never the worktree's `.git`, the Git state it shares, or the run's
 * directory (its approvals, inbox and definition); no reads of the pi config directory but the worktree, nor of what a
 * Read rule denies, in the checkout or its copy in the worktree; no Unix sockets, so no daemon or tmux; and no host
 * the user has not allowed, each asked for through the run's orchestrator. Every process a command starts is found by
 * the run's own profile (ext/sandbox/run-containment.ts) and ended before the command's result returns, so none runs
 * while another tool of the run does.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { runMarker } from "../../daemon/run-members.ts";
import { pathRule } from "../permissions/rules.ts";
import { checkRuntimeConfig, type RuntimeConfig, type SandboxSetting, sandboxPath } from "../sandbox/config.ts";
import { endRunProcesses, prepareRunContainment, type RunContainment } from "../sandbox/run-containment.ts";
import type { AskNetwork } from "../sandbox/runtime.ts";
import type { RpcDenyRules } from "./rpc-child.ts";

/** What a run's shell is confined to, as its Admission recorded it. */
export interface RunShellScope {
	runId: string;
	/** The run's directory: runtime-owned, never the shell's to write. */
	runDir: string;
	/** The worktree the run changes, the checkout it copies, and the Git directory both share; all real. */
	workspace: { root: string; source: string; gitDir: string };
	deny: RpcDenyRules[];
}

/** A run's own temp directory: outside its worktree, so nothing there counts as its changes. */
export const runShellTmp = (agentDir: string, runId: string): string =>
	join(realpathSync(agentDir), "bluclawd", "run-tmp", runId);

/** Paths the sandbox runtime keeps writable for every sandbox, shared between them, so closed to a run's. */
const SHARED_WRITABLE = ["/tmp/claude", "/private/tmp/claude", "~/.npm/_logs", "~/.claude/debug"];

/** A path, and its copy in the worktree when it is in the checkout the worktree copies. */
function withCopy(path: string, workspace: RunShellScope["workspace"]): string[] {
	const rel = relative(workspace.source, path);
	const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
	return inside ? [path, join(workspace.root, rel)] : [path];
}

/**
 * The sandbox runtime's config for a run's commands. `user` is the user's interactive sandbox setting: when on, its
 * hosts, denied reads and writes and hidden credentials hold for the run as well; nothing in it widens what the run
 * may write or reach.
 */
export function runShellConfig(
	scope: RunShellScope,
	user: SandboxSetting,
	agentDir: string,
	home = homedir(),
): { config: RuntimeConfig; hiddenEnv: string[] } {
	const { workspace } = scope;
	const ruled = (verbs: string[]) =>
		scope.deny.flatMap(({ cwd, rules }) =>
			rules.flatMap((rule) => {
				const parsed = pathRule(rule);
				return parsed && verbs.includes(parsed.verb)
					? withCopy(sandboxPath(parsed.path, cwd, home), workspace)
					: [];
			}),
		);
	const on = user.kind === "on" ? user.settings : undefined;
	const written = (on?.written ?? {}) as {
		network?: { deniedDomains?: unknown; strictAllowlist?: unknown };
		credentials?: { envVars?: { name?: unknown }[]; files?: { path?: unknown }[] };
	};
	const strings = (list: unknown[] | undefined) =>
		(list ?? []).filter((item): item is string => typeof item === "string");
	const userPaths = (list: string[]) => list.map((path) => sandboxPath(path, workspace.root, home));
	const unique = (list: string[]) => [...new Set(list)];
	const deniedDomains = written.network?.deniedDomains;
	return {
		config: {
			network: {
				allowedDomains: [...(on?.allowedDomains ?? [])],
				deniedDomains: Array.isArray(deniedDomains) ? strings(deniedDomains) : [],
				...(written.network?.strictAllowlist === true ? { strictAllowlist: true } : {}),
				allowMachLookup: [runMarker(scope.runId)],
			},
			filesystem: {
				denyRead: unique([
					realpathSync(agentDir),
					...ruled(["Read"]),
					...userPaths(on?.denyRead ?? []),
					...userPaths(strings(written.credentials?.files?.map((file) => file.path))),
				]),
				allowRead: [workspace.root, runShellTmp(agentDir, scope.runId)],
				allowWrite: [workspace.root, runShellTmp(agentDir, scope.runId)],
				denyWrite: unique([
					join(workspace.root, ".git"),
					workspace.gitDir,
					scope.runDir,
					...userPaths(SHARED_WRITABLE),
					...ruled(["Edit", "Write"]),
					...userPaths(on?.denyWrite ?? []),
				]),
			},
		},
		hiddenEnv: strings(written.credentials?.envVars?.map((entry) => entry.name)),
	};
}

type Exec = BashOperations["exec"];

/**
 * The exec of a run's bash: each command in the run's sandbox, refused when it cannot be, and every process it
 * started ended before it returns. A command whose processes could not all be ended leaves the run without a shell.
 */
export function createRunShell(
	scope: RunShellScope,
	options: { user: () => SandboxSetting; agentDir: string; ask: AskNetwork },
): { exec: Exec; uncontained(): string | undefined } {
	let ready: Promise<{ contained: RunContainment; hiddenEnv: string[] } | string> | undefined;
	let uncontained: string | undefined;
	const prepare = async () => {
		const containment = await prepareRunContainment();
		if (!containment.ok) return `this run's commands cannot be contained: ${containment.reason}`;
		const user = options.user();
		if (user.kind === "invalid")
			return `the user's sandbox setting, which holds for runs too, is malformed: ${user.reason}`;
		const { config, hiddenEnv } = runShellConfig(scope, user, options.agentDir);
		const checked = await checkRuntimeConfig(config);
		if (typeof checked === "string") return `its sandbox cannot be set up: ${checked}`;
		const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
		if (!SandboxManager.isSupportedPlatform()) return `the sandbox does not support ${process.platform}`;
		const { errors } = SandboxManager.checkDependencies();
		if (errors.length > 0) return `the sandbox cannot run: ${errors.join("; ")}`;
		mkdirSync(runShellTmp(options.agentDir, scope.runId), { recursive: true, mode: 0o700 });
		// The runtime gives commands this as their TMPDIR, instead of a temp directory every sandbox shares.
		process.env.CLAUDE_CODE_TMPDIR = runShellTmp(options.agentDir, scope.runId);
		await SandboxManager.initialize(checked as SandboxRuntimeConfig, options.ask, false);
		return { contained: { helper: containment.helper, marker: runMarker(scope.runId) }, hiddenEnv };
	};
	const exec: Exec = async (command, cwd, execOptions) => {
		if (uncontained) throw new Error(uncontained);
		ready ??= prepare().then((result) => {
			if (typeof result === "string") ready = undefined;
			return result;
		});
		const shell = await ready;
		if (typeof shell === "string") throw new Error(`Refused: ${shell}.`);
		const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
		const env: NodeJS.ProcessEnv = {
			...(execOptions.env ?? process.env),
			TMPDIR: runShellTmp(options.agentDir, scope.runId),
		};
		for (const name of shell.hiddenEnv) delete env[name];
		// A run's pi in a pane knows its tmux and the daemon (ADR-0013); its commands are not told of either.
		for (const name of Object.keys(env)) {
			if (name.startsWith("BLUCLAWD_") || ["PI_SERVER_DIR", "TMUX", "TMUX_PANE"].includes(name)) delete env[name];
		}
		const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", undefined, execOptions.signal, {
			commandId: randomUUID(),
			commandText: command,
		});
		try {
			return await createLocalBashOperations({ shellPath: "/bin/bash" }).exec(wrapped, cwd, {
				...execOptions,
				env,
			});
		} finally {
			SandboxManager.cleanupAfterCommand();
			if (!(await endRunProcesses(shell.contained))) {
				uncontained =
					"Refused: processes a shell command of this run started could not all be ended, so it runs nothing more.";
				// Its result says nothing of what those processes still do.
				// biome-ignore lint/correctness/noUnsafeFinally: the command is not done while its processes run
				throw new Error(uncontained);
			}
		}
	};
	return { exec, uncontained: () => uncontained };
}
