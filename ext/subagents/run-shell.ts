import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { runMachMarker } from "../../daemon/run-members.ts";
import { resolveDenyRulePath } from "../_shared/deny-rule-path.ts";
import { pathRule } from "../permissions/rules.ts";
import {
	checkRuntimeConfig,
	linuxGlobRefusal,
	type SandboxSetting,
	sandboxPath,
	sandboxWriteDenies,
	type UncheckedRuntimeConfig,
} from "../sandbox/config.ts";
import { endRunProcesses, prepareRunContainment, type RunContainment } from "../sandbox/run-containment.ts";
import type { AskNetwork } from "../sandbox/runtime.ts";
import type { RpcDenyRules } from "./rpc-child.ts";

export interface RunShellScope {
	runId: string;
	runDir: string;
	workspace: { root: string; source: string; gitDir: string };
	deny: RpcDenyRules[];
}

export const runShellTmp = (agentDir: string, runId: string): string =>
	join(realpathSync(agentDir), "bluclawd", "run-tmp", runId);

/** Paths the sandbox runtime keeps writable for every sandbox, shared between them, so closed to a run's. */
const SHARED_WRITABLE = ["/tmp/claude", "/private/tmp/claude", "~/.npm/_logs", "~/.claude/debug"];

function withCopy(path: string, workspace: RunShellScope["workspace"]): string[] {
	const rel = relative(workspace.source, path);
	const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
	return inside ? [path, join(workspace.root, rel)] : [path];
}

export function runShellConfig(
	scope: RunShellScope,
	user: SandboxSetting,
	agentDir: string,
	home = homedir(),
): { config: UncheckedRuntimeConfig; hiddenEnv: string[] } {
	const { workspace } = scope;
	const ruled = (verbs: string[]) =>
		scope.deny.flatMap(({ cwd, rules }) =>
			rules.flatMap((rule) => {
				const parsed = pathRule(rule);
				return parsed && verbs.includes(parsed.verb)
					? withCopy(resolveDenyRulePath(parsed.path, cwd, home), workspace)
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
	const dotGit = join(workspace.root, ".git");
	const writeDenies = sandboxWriteDenies(workspace.root, home, on?.allowWrite ?? []).filter(
		({ path }) => !path.startsWith(dotGit + sep),
	);
	return {
		config: {
			network: {
				allowedDomains: [...(on?.allowedDomains ?? [])],
				deniedDomains: Array.isArray(deniedDomains) ? strings(deniedDomains) : [],
				...(written.network?.strictAllowlist === true ? { strictAllowlist: true } : {}),
				allowMachLookup: [runMachMarker(scope.runId)],
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
				denyWrite: [
					...unique([
						dotGit,
						workspace.gitDir,
						scope.runDir,
						...userPaths(SHARED_WRITABLE),
						...ruled(["Edit", "Write"]),
						...userPaths(on?.denyWrite ?? []),
					]),
					...writeDenies,
				],
			},
		},
		hiddenEnv: strings(written.credentials?.envVars?.map((entry) => entry.name)),
	};
}

type Exec = BashOperations["exec"];

const PANE_ONLY_ENV = ["PI_SERVER_DIR", "TMUX", "TMUX_PANE"];
/** A word of a variable's name that ends like a credential: `PGPASSWORD`, `API_KEY`, `authToken`; not `KEYTIMEOUT`. */
const CREDENTIAL_WORD = /(KEYS?|SECRETS?|TOKENS?|PASSWORD|PASSWD|CREDENTIALS?)$|^PASS$/i;

const namesCredential = (name: string) =>
	name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).some((word) => CREDENTIAL_WORD.test(word));

const commandEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(env).filter(
			([name]) => !name.startsWith("BLUCLAWD_") && !PANE_ONLY_ENV.includes(name) && !namesCredential(name),
		),
	);

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
		await SandboxManager.initialize(checked, options.ask, false);
		const globRefusal = linuxGlobRefusal(SandboxManager.getLinuxGlobPatternWarnings());
		if (globRefusal) {
			await SandboxManager.reset();
			return globRefusal;
		}
		return { contained: { helper: containment.helper, marker: runMachMarker(scope.runId) }, hiddenEnv };
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
		const env = commandEnv({
			...(execOptions.env ?? process.env),
			TMPDIR: runShellTmp(options.agentDir, scope.runId),
		});
		for (const name of shell.hiddenEnv) delete env[name];
		const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", undefined, execOptions.signal, {
			commandId: randomUUID(),
			commandText: command,
		});
		let ran: { exited: Awaited<ReturnType<Exec>> } | { failed: unknown };
		try {
			ran = {
				exited: await createLocalBashOperations({ shellPath: "/bin/bash" }).exec(wrapped, cwd, {
					...execOptions,
					env,
				}),
			};
		} catch (error) {
			ran = { failed: error };
		}
		SandboxManager.cleanupAfterCommand();
		if (!(await endRunProcesses(shell.contained))) {
			uncontained =
				"Refused: processes a shell command of this run started could not all be ended, so it runs nothing more.";
			throw new Error(uncontained);
		}
		if ("failed" in ran) throw ran.failed;
		return ran.exited;
	};
	return { exec, uncontained: () => uncontained };
}
