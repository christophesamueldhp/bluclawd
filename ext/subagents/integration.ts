/**
 * Integration (GLOSSARY): the orchestrator applies what a finished run that edits changed in its worktree onto its
 * checkout as it is now. Only the run's own delta goes, from its baseline (or from what an earlier Integration of it
 * applied) to its worktree, merged three ways with the checkout, so every change made there meanwhile stays, and the
 * checkout's state at the run's Admission is never applied again as if it were the run's. A path that would conflict
 * leaves the whole checkout as it was: the orchestrator resolves a routine conflict itself, and asks the user about one
 * that changes intent. Integrations into one repository happen one at a time. Nothing is staged, committed, pushed or
 * removed, and the worktree stays. A check the orchestrator names validates the combined result, reported apart from
 * the run's outcome and its claims.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createLocalBashOperations, type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { processAlive, processGroupAlive } from "../../daemon/processes.ts";
import { runMarker } from "../../daemon/run-members.ts";
import { evaluateToolCallDeny } from "../permissions/policy.ts";
import { prepareRunContainment, runProcesses } from "../sandbox/run-containment.ts";
import { sandboxStatus, sandboxWraps, wrapExec } from "../sandbox/runtime.ts";
import { CHAIN_ID_PREFIX, formatRunLabel } from "./admission.ts";
import { type ChainResultDetails, chainResultPath } from "./chains.ts";
import type { RunDirectory } from "./directory.ts";
import type { ParentScope } from "./parent-scope.ts";
import { sanitizeReportText, truncateUtf8Safe } from "./results.ts";
import type { RpcDenyRules } from "./rpc-child.ts";
import { readRpcHostState } from "./rpc-host.ts";
import { readRunDefinition, rpcDenyRules, runDefinitionPath } from "./rpc-runs.ts";
import { within } from "./run-workspace.ts";
import {
	describeWorkspace,
	git,
	gitEnv,
	gitSync,
	type IsolatedWorkspace,
	listChanges,
	withScratchIndex,
	worktreeInPlace,
} from "./run-worktree.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord } from "./runs.ts";
import { readRunReports, subagentRunDir, writeAtomicPrivateFile } from "./storage.ts";

/** How long a call waits for another Integration into the same repository, its check included, before it gives up. */
const CHECK_TIMEOUT_MS = 10 * 60_000;
const LOCK_WAIT_MS = CHECK_TIMEOUT_MS + 2 * 60_000;
/** How long a run's record may take to become final after its Report reached a foreground call. */
const FINAL_WAIT_MS = 500;
const MAX_CHECK_OUTPUT_BYTES = 2 * 1024;
const MAX_PATCH_BYTES = 16 * 1024;
const GITLINK = "160000";
const SYMLINK = "120000";
const NO_OBJECT = /^0+$/;

export interface IntegrationDeps {
	agentDir(): string;
	scope(): ParentScope | undefined;
	/** Whether the orchestrator's session still holds the entry a run was launched from. */
	onBranch(entryId: string | undefined): boolean;
	directory: Pick<RunDirectory, "find" | "list">;
	/** Settles once the run's record is final; undefined when it is already, or unknown here. */
	whenFinal(runId: string): Promise<unknown> | undefined;
}

interface IntegrationContext {
	cwd: string;
	isProjectTrusted(): boolean;
}

/** What is integrated: one run's worktree, or the one a chain's steps shared. */
interface Target {
	label: string;
	workspace: IsolatedWorkspace;
	/** The run whose directory keeps the worktree's records: its removal, and what was integrated of it. */
	ownerDir: string;
	runs: { record: Readonly<SubagentRunRecord>; runDir: string }[];
	outcome: string;
}

/** What an earlier Integration of the worktree applied: its tree then, from which the next one goes on. */
interface IntegrationRecord {
	tree: string;
	at: number;
}

/** One path of a tree diff: the modes and objects on each side, and its status letter. */
interface TreeChange {
	path: string;
	status: string;
	fromMode: string;
	toMode: string;
	to: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; details: undefined; isError?: boolean };
const result = (text: string, isError = false): ToolResult => ({
	content: [{ type: "text", text }],
	details: undefined,
	...(isError ? { isError } : {}),
});

const integrationPath = (runDir: string) => join(runDir, "integration.json");

function readIntegration(runDir: string): IntegrationRecord | undefined {
	try {
		const stored = JSON.parse(readFileSync(integrationPath(runDir), "utf8")) as IntegrationRecord;
		return typeof stored.tree === "string" ? stored : undefined;
	} catch {
		return undefined;
	}
}

export function registerIntegration(pi: ExtensionAPI, deps: IntegrationDeps): void {
	pi.registerTool({
		name: "subagent_integrate",
		label: "Integrate subagent",
		exposure: "model-only",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		description:
			"Integrate what a finished subagent that edits changed in its worktree, by name or run ID, or what a completed chain changed, by its ID (chain_…), into your checkout: only its own changes since its baseline are applied, onto your checkout as it is now, and every change made there meanwhile is kept. Nothing is staged, committed or pushed, and its worktree stays. Work that is still running, did not complete, or whose processes may still run is refused. On a conflict nothing is applied: resolve a routine one within what the user asked by editing your own file, then call again with that path in `keep`; a conflict whose resolution would change what the user or the run meant is for the user: ask them, and do not choose. `preview` shows its changes and what would conflict, applying nothing. `check` is a shell command run in the checkout once applied, as your own bash runs it and only while you have bash, to validate the combined result; its exit code and output are reported, and nothing is undone when it fails.",
		parameters: Type.Object(
			{
				agent: Type.String({ description: "The finished subagent's name or run ID (sub_…), or a chain's ID." }),
				preview: Type.Optional(
					Type.Boolean({ description: "Show its changes and what would conflict; apply nothing." }),
				),
				keep: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Paths, relative to the checkout's root, to leave as they are in your checkout: conflicts you resolved there.",
					}),
				),
				check: Type.Optional(
					Type.String({
						description: "A shell command to validate the combined result, run in the checkout's root.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const scope = deps.scope();
			if (!scope || !ctx) return result("Subagent runtime is not initialized for this session.", true);
			try {
				// A check is one of the orchestrator's own commands: only one that may run bash may give one.
				const mayShell = pi.getActiveTools().includes("bash");
				return await integrate(deps, scope, ctx, { ...params, agent: params.agent.trim() }, mayShell, signal);
			} catch (error) {
				return result(
					`Not integrated: ${error instanceof Error ? error.message : String(error)}. Nothing more was applied.`,
					true,
				);
			}
		},
	});
}

async function integrate(
	deps: IntegrationDeps,
	scope: ParentScope,
	ctx: IntegrationContext,
	params: { agent: string; preview?: boolean; keep?: string[]; check?: string },
	mayShell: boolean,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const target = resolveTarget(deps, scope, params.agent);
	if (typeof target === "string") return result(target, true);
	for (const run of target.runs) {
		const why = await unsettled(deps, scope, run);
		if (why) return result(`Not integrated: ${why}`, true);
	}
	const { workspace, ownerDir, label } = target;
	const { root, baseline } = workspace;
	if (!worktreeInPlace(workspace, ownerDir)) {
		const [where] = await describeWorkspace(workspace, ownerDir);
		return result(`Not integrated: the worktree of ${label} is not there. ${where}`, true);
	}
	const occupied = occupant(deps, scope, workspace);
	if (occupied) return result(`Not integrated: ${occupied}`, true);

	const release = await lockRepository(baseline.gitDir, signal);
	try {
		const after = await worktreeTree(workspace);
		// Asked again once its state is taken: nothing of it may have started meanwhile.
		for (const run of target.runs) {
			const why = processesLeft(run.runDir) ?? occupant(deps, scope, workspace);
			if (why) return result(`Not integrated: ${why}`, true);
		}
		const earlier = readIntegration(ownerDir);
		if (earlier?.tree === after) {
			return result(
				`Nothing to integrate: every change of ${label} since its baseline was already integrated, at ${new Date(earlier.at).toISOString()}.`,
			);
		}
		const base = earlier?.tree ?? baseline.tree;
		const source = baseline.source;
		const delta = await treeChanges(source, baseline.gitDir, base, after);
		if (delta.length === 0) return result(`Nothing to integrate: ${label} changed nothing since its baseline.`);
		const paths = delta.map((change) => change.path);
		const keep = new Set((params.keep ?? []).map((path) => path.replace(/^\.\//, "")));

		const blocked = new Map<string, string>();
		for (const change of delta) {
			const problem = change.toMode === GITLINK ? "it is a nested repository" : pathProblem(source, change.path);
			if (problem) blocked.set(change.path, problem);
		}
		// Only paths it can reach without following a link: the same ones once more just before writing.
		const hashed = paths.filter((path) => !blocked.has(path));
		const ours = await checkoutTree(workspace, base, hashed);
		const merge = await mergeTrees(source, baseline.gitDir, base, ours, after);
		const theirsMeanwhile = (await treeChanges(source, baseline.gitDir, base, ours)).map((change) => change.path);
		const writes = (await treeChanges(source, baseline.gitDir, ours, merge.tree)).filter(
			(change) => !keep.has(change.path),
		);

		const deny = denyRules(deps.agentDir(), ctx, ownerDir);
		for (const change of writes) {
			if (blocked.has(change.path)) continue;
			const rule = denied(deny, change.status === "A" ? "write" : "edit", join(source, change.path));
			if (rule) blocked.set(change.path, `${rule}, so you may not change it`);
		}
		const problems = [
			...[...merge.conflicts].map(([path, kinds]) => ({ path, why: kinds.join("; ") })),
			...[...blocked].map(([path, why]) => ({ path, why })),
		].filter(({ path }) => !keep.has(path));
		const ownChanges = `Changes of the run since its ${earlier ? "last Integration" : "baseline"}: ${listChanges(
			delta.map(({ status, path }) => `${status} ${path}`),
			"none",
		)}`;
		const meanwhile = `Your checkout changed since its ${earlier ? "last Integration" : "baseline"} in: ${listChanges(
			delta.filter(({ path }) => theirsMeanwhile.includes(path)).map(({ status, path }) => `${status} ${path}`),
			"none of these",
		)}`;
		const conflictText = [
			`${problems.length} of its changed paths cannot be applied as they are:`,
			...problems.map(({ path, why }) => `- ${path}: ${why}. The run's version: ${join(root, path)}`),
			`The baseline's version of each: \`git show ${base}:<path>\` in ${source}.`,
			"Resolve only a routine conflict, within what the user asked: edit your checkout's file to hold both changes, then call subagent_integrate again with that path in `keep`. A conflict whose resolution would change what the user or the run meant is the user's to decide: ask them, and do not choose.",
		];

		if (params.preview) {
			const patch = await previewPatch(source, baseline.gitDir, base, after, paths, deny);
			return result(
				[
					`Preview of integrating ${label} into ${source}; nothing was applied.`,
					ownChanges,
					meanwhile,
					...(problems.length ? conflictText : ["It would apply cleanly."]),
					"",
					patch,
				].join("\n"),
			);
		}
		if (problems.length > 0) {
			return result(
				[
					`Not integrated: nothing of ${label} was applied, and your checkout ${source} is as it was.`,
					ownChanges,
					meanwhile,
					...conflictText,
				].join("\n"),
				true,
			);
		}

		// Checked again just before writing: a change made to the checkout since must not be overwritten.
		if (checkoutTreeSync(workspace, base, hashed) !== ours) {
			return result(
				`Not integrated: your checkout ${source} changed while ${label} was being integrated; nothing was applied. Call again.`,
				true,
			);
		}
		const applied: string[] = [];
		try {
			for (const change of writes) {
				applyChange(source, baseline.gitDir, change);
				applied.push(`${change.status} ${change.path}`);
			}
		} catch (error) {
			const left = writes.slice(applied.length).map(({ status, path }) => `${status} ${path}`);
			throw new Error(
				`writing ${source} failed (${error instanceof Error ? error.message : String(error)}) after it applied ${listChanges(applied, "nothing")}; not applied: ${listChanges(left, "none")}`,
			);
		}
		writeAtomicPrivateFile(integrationPath(ownerDir), JSON.stringify({ tree: after, at: Date.now() }));
		const kept = [...keep].filter((path) => paths.includes(path));
		const validation = params.check
			? await runCheck(params.check, source, deps.agentDir(), ctx, mayShell, signal)
			: "Validation: none ran, so nothing validated the combined result. Run the project's checks, or call again with `check` next time.";
		return result(
			[
				`Integration: applied ${listChanges(applied, "nothing new (your checkout held its changes already)")} to ${source}, onto your checkout as it is now. Nothing was staged, committed or pushed.`,
				`Merged with your changes since its ${earlier ? "last Integration" : "baseline"}: ${listChanges(
					theirsMeanwhile.filter((path) => paths.includes(path) && !keep.has(path)),
					"none",
				)}`,
				...(kept.length ? [`Kept as in your checkout: ${listChanges(kept, "none")}`] : []),
				target.outcome,
				validation,
				`Its worktree ${root} is kept.`,
			].join("\n"),
		);
	} finally {
		release();
	}
}

/** The run or chain named `name` of this session, with its worktree; or why there is none to integrate. */
function resolveTarget(deps: IntegrationDeps, scope: ParentScope, name: string): Target | string {
	const agentDir = deps.agentDir();
	const runOf = (runId: string) => {
		const record = deps.directory.find(scope, runId)?.record;
		return record && { record, runDir: subagentRunDir(agentDir, scope.parentSessionId, record.runId) };
	};
	if (name.startsWith(CHAIN_ID_PREFIX)) {
		let chain: ChainResultDetails;
		try {
			chain = JSON.parse(readFileSync(chainResultPath(agentDir, scope.parentSessionId, name), "utf8"));
		} catch {
			return `No settled chain "${name}" in this session: a chain is integrated once it has completed.`;
		}
		const halted = chain.runs.filter((run) => run.status !== "completed");
		if (!chain.completed) {
			return `Not integrated: chain ${name} halted (${halted.map((run) => `chain[${run.step}] ${run.status}`).join(", ")}). Its worktree keeps the partial work for you to inspect; it is not ready to integrate.`;
		}
		const runs = chain.runs.flatMap((run) => (run.runId ? [runOf(run.runId)] : []));
		const owner = runs[0];
		if (!chain.workspace || !owner) return `Chain ${name} has no worktree: none of its steps edits.`;
		const known = runs.filter((run): run is NonNullable<typeof run> => run !== undefined);
		if (known.length < runs.length) return `Not integrated: a step of chain ${name} is unknown in this session.`;
		if (!deps.onBranch(known[0].record.originEntryId)) {
			return `Not integrated: chain ${name} was launched from another branch of this session.`;
		}
		return {
			label: `chain ${name}`,
			workspace: chain.workspace,
			ownerDir: owner.runDir,
			runs: known,
			outcome: `Run: chain ${name}, ${chain.runs.length} step${chain.runs.length === 1 ? "" : "s"}, every one completed as its runtime saw it; what they claim to have checked is their own claim.`,
		};
	}
	const run = runOf(name);
	if (!run) return `No subagent "${name}" in this session.`;
	const { record, runDir } = run;
	const label = formatRunLabel(record);
	if (record.chain) {
		return `${label} is a step of chain ${record.chain}: integrate the chain, "${record.chain}", once it has completed.`;
	}
	const workspace = record.backend === "rpc" ? readRunDefinition(runDefinitionPath(runDir, 0))?.workspace : undefined;
	if (!workspace) return `${label} has no worktree of its own: it worked in ${record.cwd}, where its changes are.`;
	if (!deps.onBranch(record.originEntryId)) {
		return `Not integrated: ${label} was launched from another branch of this session.`;
	}
	return {
		label,
		workspace,
		ownerDir: runDir,
		runs: [run],
		outcome: `Run: completed: its pi settled its work without an error. What it says it checked is its own claim; its Report's Checks line lists the commands its transcript shows.`,
	};
}

/** Why the run's work has not settled: it still runs, did not complete, or something of it may still run. */
async function unsettled(
	deps: IntegrationDeps,
	scope: ParentScope,
	{ record, runDir }: { record: Readonly<SubagentRunRecord>; runDir: string },
): Promise<string | undefined> {
	const label = formatRunLabel(record);
	const now = () => deps.directory.find(scope, record.runId)?.record ?? record;
	// A foreground call returns once its run reported, a moment before its record is final.
	const final = !isTerminalSubagentStatus(now().status) && deps.whenFinal(record.runId);
	if (final) await Promise.race([final, new Promise((resolve) => setTimeout(resolve, FINAL_WAIT_MS))]);
	const run = now();
	if (!isTerminalSubagentStatus(run.status)) {
		return `${label} is still ${run.status}: Integration waits until its work has settled and none of its processes runs.`;
	}
	const reason = run.errorMessage?.split("\n")[0];
	if (run.status !== "closed") {
		return `${label} ended ${run.status}${reason ? ` (${reason})` : ""}. Its worktree keeps its partial work for you to inspect; it is not ready to integrate.`;
	}
	const report = readRunReports(runDir, -1).at(-1);
	if (report?.outcome?.status !== "completed") {
		return `${label}'s last work did not complete (${report?.outcome?.error ?? reason ?? "no outcome was stored"}). Its worktree keeps its partial work for you to inspect; it is not ready to integrate.`;
	}
	const left = processesLeft(runDir);
	if (left) return left;
	const definition = readRunDefinition(runDefinitionPath(runDir, run.generation));
	if (!definition)
		return `nothing confirms what ${label} could run: the definition of its generation ${run.generation} cannot be read.`;
	if (definition.shell) {
		const ready = await prepareRunContainment();
		const members = ready.ok
			? await runProcesses({ helper: ready.helper, marker: runMarker(definition.shell.runId) }).catch(
					() => undefined,
				)
			: undefined;
		if (!members) return `nothing confirms that no process ${label}'s commands started still runs.`;
		if (members.length > 0) return `processes ${label}'s commands started still run (${members.join(", ")}).`;
	}
	return undefined;
}

/** Why the run's host may still run: its group not empty, or its end not recorded while it lives. */
function processesLeft(runDir: string): string | undefined {
	const host = readRpcHostState(runDir);
	if (!host) return undefined;
	if (processGroupAlive(host.hostPid) || (host.exit === undefined && processAlive(host.hostPid))) {
		return `processes of the run in ${runDir} still run (process group ${host.hostPid}).`;
	}
	return undefined;
}

/** The run of the scope working in the worktree now, if any: a later step of its chain, or a Resume. */
function occupant(deps: IntegrationDeps, scope: ParentScope, { root }: IsolatedWorkspace): string | undefined {
	const run = deps.directory.list(scope).find(({ record }) => within(root, record.cwd))?.record;
	return run && `${formatRunLabel(run)} works in ${root} now: let it finish first.`;
}

/**
 * Holds the repository's Integration lock, the one Integration into it at a time across every process: a lock file
 * in its Git directory, which a run's commands cannot write, taken over once its holder is gone.
 */
async function lockRepository(gitDir: string, signal: AbortSignal | undefined): Promise<() => void> {
	const path = join(gitDir, "bluclawd-integration.lock");
	const token = `${process.pid} ${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeFileSync(fd, token);
			closeSync(fd);
			return () => {
				try {
					if (readFileSync(path, "utf8") === token) unlinkSync(path);
				} catch {
					// Gone already.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder = Number.NaN;
		try {
			holder = Number(readFileSync(path, "utf8").split(" ")[0]);
		} catch {
			continue;
		}
		if (Number.isInteger(holder) && holder > 0 && !processAlive(holder)) {
			rmSync(path, { force: true });
			continue;
		}
		if (signal?.aborted || Date.now() > deadline) {
			throw new Error(`another Integration into the repository of ${gitDir} is under way (process ${holder})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The worktree's files as a tree, untracked ones included and ignored ones not; Git never follows its `.git`. */
function worktreeTree({ root, baseline }: IsolatedWorkspace): Promise<string> {
	return withScratchIndex(undefined, async (scratch) => {
		const env = gitEnv({ GIT_DIR: baseline.gitDir, GIT_WORK_TREE: root, GIT_INDEX_FILE: scratch });
		await git(root, ["read-tree", baseline.tree], env);
		await git(root, ["add", "-A"], env);
		return (await git(root, ["write-tree"], env)).trim();
	});
}

/** `base` with `paths` as the checkout holds them now, whether Git ignores them there or not; absent ones removed. */
function checkoutTree({ baseline }: IsolatedWorkspace, base: string, paths: string[]): Promise<string> {
	return withScratchIndex(undefined, async (scratch) => {
		const env = gitEnv({ GIT_DIR: baseline.gitDir, GIT_WORK_TREE: baseline.source, GIT_INDEX_FILE: scratch });
		await git(baseline.source, ["read-tree", base], env);
		for (let i = 0; i < paths.length; i += 500) {
			await git(baseline.source, ["update-index", "--add", "--remove", "--", ...paths.slice(i, i + 500)], env);
		}
		return (await git(baseline.source, ["write-tree"], env)).trim();
	});
}

function checkoutTreeSync({ baseline }: IsolatedWorkspace, base: string, paths: string[]): string {
	return withScratchIndex(undefined, (scratch) => {
		const env = gitEnv({ GIT_DIR: baseline.gitDir, GIT_WORK_TREE: baseline.source, GIT_INDEX_FILE: scratch });
		gitSync(baseline.source, ["read-tree", base], env);
		for (let i = 0; i < paths.length; i += 500) {
			gitSync(baseline.source, ["update-index", "--add", "--remove", "--", ...paths.slice(i, i + 500)], env);
		}
		return gitSync(baseline.source, ["write-tree"], env);
	});
}

/** Every path that differs from tree `from` to tree `to`, with its modes and its object in `to`. */
async function treeChanges(source: string, gitDir: string, from: string, to: string): Promise<TreeChange[]> {
	if (from === to) return [];
	const out = await git(
		source,
		["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to],
		gitEnv({ GIT_DIR: gitDir }),
	);
	const fields = out.split("\0");
	const changes: TreeChange[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const [fromMode, toMode, , to, status] = fields[i].replace(/^:/, "").split(" ");
		if (!status) break;
		changes.push({ path: fields[i + 1], status, fromMode, toMode, to });
	}
	return changes;
}

/** The three-way merge of the run's tree into the checkout's, in Git's object store only; and its conflicts by path. */
async function mergeTrees(
	source: string,
	gitDir: string,
	base: string,
	ours: string,
	theirs: string,
): Promise<{ tree: string; conflicts: Map<string, string[]> }> {
	const args = ["merge-tree", "--write-tree", "-z", "--name-only", `--merge-base=${base}`, ours, theirs];
	const env = gitEnv({ GIT_DIR: gitDir });
	const run = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd: source,
		env,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (run.status !== 0 && run.status !== 1) {
		throw new Error(`Git could not merge (${(run.stderr || run.error?.message || "").trim().split("\n")[0]})`);
	}
	const [head, messages = ""] = run.stdout.split("\0\0");
	const [tree, ...conflicted] = head.split("\0").filter(Boolean);
	const conflicts = new Map<string, string[]>(conflicted.map((path) => [path, []]));
	// Each message: how many paths it is about, those paths, its type, and its text.
	const fields = messages.split("\0");
	for (let i = 0; i < fields.length; ) {
		const count = Number(fields[i]);
		if (!Number.isInteger(count) || count < 1) break;
		const about = fields.slice(i + 1, i + 1 + count);
		const type = fields[i + 1 + count] ?? "";
		const text = fields[i + 2 + count] ?? "";
		i += count + 3;
		if (!type.startsWith("CONFLICT")) continue;
		for (const path of about) conflicts.get(path)?.push(text.trim());
	}
	for (const kinds of conflicts.values()) if (kinds.length === 0) kinds.push("changed both here and by the run");
	return { tree, conflicts };
}

/** Why `path` cannot be written in the checkout as it is: reached through a link or a file, or a directory there now. */
function pathProblem(source: string, path: string): string | undefined {
	const parts = path.split("/");
	let dir = source;
	for (const part of parts.slice(0, -1)) {
		dir = join(dir, part);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(dir);
		} catch {
			return undefined;
		}
		if (stat.isSymbolicLink()) return `${dir} is a link in your checkout, which Integration does not follow`;
		if (!stat.isDirectory()) return `${dir} is a file in your checkout`;
	}
	try {
		if (lstatSync(join(source, path)).isDirectory()) return "it is a directory in your checkout now";
	} catch {
		// Absent: made.
	}
	return undefined;
}

/** The orchestrator's deny rules now, and those the run was admitted with. */
function denyRules(agentDir: string, ctx: IntegrationContext, runDir: string): RpcDenyRules[] {
	const current = rpcDenyRules(agentDir, [{ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }]);
	if (!current.ok) throw new Error(current.error.replace(/^Cannot launch subagent: /, "").replace(/\.$/, ""));
	return [...current.deny, ...(readRunDefinition(runDefinitionPath(runDir, 0))?.deny ?? [])];
}

function denied(deny: RpcDenyRules[], tool: string, path: string): string | undefined {
	for (const { cwd, rules } of deny) {
		const blocked = evaluateToolCallDeny(rules, tool, { path }, cwd);
		if (blocked) return blocked.reason;
	}
	return undefined;
}

/** Writes the merged state of one path into the checkout, never through a link, each file replaced whole. */
function applyChange(source: string, gitDir: string, change: TreeChange): void {
	const target = join(source, change.path);
	if (NO_OBJECT.test(change.to)) {
		rmSync(target, { force: true });
		return;
	}
	const content = spawnSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "cat-file", "--filters", `--path=${change.path}`, change.to],
		{ cwd: source, env: gitEnv({ GIT_DIR: gitDir, GIT_WORK_TREE: source }), maxBuffer: 1024 * 1024 * 1024 },
	);
	if (content.status !== 0) throw new Error(`Git could not read ${change.path}`);
	mkdirSync(dirname(target), { recursive: true });
	const temporary = join(dirname(target), `.${change.path.split("/").at(-1)}.bluclawd-${process.pid}`);
	rmSync(temporary, { force: true });
	if (change.toMode === SYMLINK) {
		symlinkSync(content.stdout.toString("utf8"), temporary);
	} else {
		let mode = 0o644;
		try {
			const existing = lstatSync(target);
			if (existing.isFile()) mode = existing.mode & 0o777;
		} catch {
			// New.
		}
		mode = change.toMode === "100755" ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;
		writeFileSync(temporary, content.stdout, { mode });
		chmodSync(temporary, mode);
	}
	renameSync(temporary, target);
}

/** The run's patch, within its bound, without the content of files the orchestrator may not read. */
async function previewPatch(
	source: string,
	gitDir: string,
	base: string,
	after: string,
	paths: string[],
	deny: RpcDenyRules[],
): Promise<string> {
	const unreadable = paths.filter((path) => denied(deny, "read", join(source, path)));
	const readable = paths.filter((path) => !unreadable.includes(path));
	const patch = readable.length
		? await git(
				source,
				["diff-tree", "-p", "--no-renames", "--no-color", base, after, "--", ...readable],
				gitEnv({ GIT_DIR: gitDir }),
			)
		: "";
	const cut = truncateUtf8Safe(patch, MAX_PATCH_BYTES);
	return [
		cut.text,
		...(cut.text.length < patch.length ? [`[Cut short at ${MAX_PATCH_BYTES} bytes.]`] : []),
		...(unreadable.length ? [`Not shown, your deny rules keep you from reading them: ${unreadable.join(", ")}`] : []),
	].join("\n");
}

/**
 * Runs the orchestrator's check in the checkout, as its own shell commands run: only while its bash tool is active,
 * held to its deny rules and sandbox.
 */
async function runCheck(
	command: string,
	source: string,
	agentDir: string,
	ctx: IntegrationContext,
	mayShell: boolean,
	signal: AbortSignal | undefined,
): Promise<string> {
	// Where the orchestrator's own commands run, when that is in the checkout; else the checkout's root.
	const where = within(source, ctx.cwd) ? ctx.cwd : source;
	const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
	const deny = rpcDenyRules(agentDir, [{ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }]);
	const blocked = deny.ok
		? deny.deny.map(({ rules }) => evaluateToolCallDeny(rules, "bash", { command }, where)).find(Boolean)
		: { reason: deny.error };
	const notRun = (why: string) =>
		`Validation: \`${command}\` did not run: ${why}. Nothing validated the combined result.`;
	if (!mayShell) return notRun("your bash tool is not active, so you may not run commands");
	if (blocked) return notRun(blocked.reason ?? "a deny rule forbids it");
	const sandboxed = sandboxStatus().kind !== "off";
	// Whether bluclawd's bash wraps commands is the sandbox's to know: only a wrapping that exists is reused.
	if (sandboxed && !sandboxWraps())
		return notRun("the sandbox is on, but bluclawd's bash, which runs inside it, is not loaded");
	const shellPath = settings.getShellPath();
	const local = createLocalBashOperations({ shellPath }).exec;
	const exec = sandboxed ? wrapExec(local, () => shellPath) : local;
	const prefix = settings.getShellCommandPrefix();
	const chunks: Buffer[] = [];
	const started = Date.now();
	const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
	let exitCode: number | null;
	try {
		({ exitCode } = await exec(prefix ? `${prefix}\n${command}` : command, where, {
			onData: (data) => chunks.push(data),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		}));
	} catch (error) {
		return `Validation: \`${command}\` could not run (${error instanceof Error ? error.message : String(error)}). Nothing validated the combined result.`;
	}
	const output = sanitizeReportText(Buffer.concat(chunks).toString("utf8")).trimEnd();
	const tail =
		Buffer.byteLength(output) > MAX_CHECK_OUTPUT_BYTES ? `[…]${tailBytes(output, MAX_CHECK_OUTPUT_BYTES)}` : output;
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	const how = timeout.aborted
		? `was stopped after ${seconds}s, its time up`
		: signal?.aborted
			? `was cancelled after ${seconds}s`
			: `exited with code ${exitCode ?? "none"} after ${seconds}s`;
	const verdict =
		timeout.aborted || signal?.aborted
			? ": it did not finish, so nothing validated the combined result. The applied changes stay"
			: exitCode === 0
				? ""
				: ": the combined result fails it. The applied changes stay; nothing was undone";
	return [
		`Validation: \`${command}\` ${how} in ${where}${verdict}.`,
		tail ? `Its output${tail.startsWith("[…]") ? " ended" : ""}:\n${tail}` : "It printed nothing.",
	].join("\n");
}

function tailBytes(text: string, max: number): string {
	const buffer = Buffer.from(text, "utf8");
	return buffer
		.subarray(buffer.length - max)
		.toString("utf8")
		.replace(/^\uFFFD+/, "");
}
