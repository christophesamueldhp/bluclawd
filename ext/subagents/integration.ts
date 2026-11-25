import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
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
import {
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { processAlive } from "../../daemon/processes.ts";
import { runMachMarker } from "../../daemon/run-members.ts";
import { withCommandPrefix } from "../_shared/command-prefix.ts";
import { evaluateToolCallDeny } from "../permissions/policy.ts";
import { PROTECTED_PROJECT_PATHS } from "../sandbox/config.ts";
import { prepareRunContainment, runProcesses } from "../sandbox/run-containment.ts";
import { sandboxStatus, sandboxWraps, wrapExec } from "../sandbox/runtime.ts";
import { CHAIN_ID_PREFIX } from "./admission.ts";
import type { ChainResultDetails } from "./chains.ts";
import type { RunDirectory } from "./directory.ts";
import { generationDefinition, runProcessesLeft, runWorkspace } from "./generation-state.ts";
import { haltedIntegration } from "./messages.ts";
import type { ParentScope } from "./parent-scope.ts";
import { sanitizeReportText, truncateUtf8Safe } from "./results.ts";
import type { RpcDenyRules } from "./rpc-child.ts";
import { rpcDenyRules } from "./rpc-runs.ts";
import { within } from "./run-workspace.ts";
import {
	describeWorkspace,
	git,
	gitEnv,
	gitSync,
	type IsolatedWorkspace,
	listChanges,
	withoutUserHooks,
	withScratchIndex,
	worktreeInPlace,
} from "./run-worktree.ts";
import {
	formatRunLabel,
	isLegacyRun,
	isTerminalSubagentStatus,
	type SubagentRunRecord,
	settledWithoutError,
} from "./runs.ts";
import { memberOutcome } from "./settling.ts";
import { readChainResult, readRunReports, subagentRunDir, writeAtomicPrivateFile } from "./storage.ts";

const CHECK_TIMEOUT_MS = 10 * 60_000;
const LOCK_WAIT_MS = CHECK_TIMEOUT_MS + 2 * 60_000;
const FINAL_WAIT_MS = 500;
const MAX_CHECK_OUTPUT_BYTES = 2 * 1024;
const MAX_PATCH_BYTES = 16 * 1024;
const GITLINK = "160000";
const SYMLINK = "120000";
const NO_OBJECT = /^0+$/;
const EVERY_STORED_REPORT = -1;
const INTEGRATE_NOTHING = "Integrate nothing";
const INTEGRATE_REST = "Integrate everything else";
const INTEGRATE_ALL = "Integrate everything";

export interface IntegrationDeps {
	agentDir(): string;
	scope(): ParentScope | undefined;
	onBranch(entryId: string | undefined): boolean;
	directory: Pick<RunDirectory, "find" | "list">;
	whenFinal(runId: string): Promise<unknown> | undefined;
}

type IntegrationContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

interface Target {
	label: string;
	workspace: IsolatedWorkspace;
	ownerDir: string;
	runs: { record: Readonly<SubagentRunRecord>; runDir: string }[];
	outcome: string;
	asIs: boolean;
}

interface IntegrationRecord {
	tree: string;
	at: number;
}

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
			"Integrate what a finished subagent that edits changed in its worktree, by name or run ID, or what a completed chain changed, by its ID (chain_…), into your checkout: only its own changes since its baseline are applied, onto your checkout as it is now, and every change made there meanwhile is kept. Nothing is staged, committed or pushed, and its worktree stays. Work that is still running, did not complete, or whose processes may still run is refused. On a conflict nothing is applied: resolve a routine one within what the user asked by editing your own file, then call again with that path in `keep`; a conflict whose resolution would change what the user or the run meant is for the user: ask them, and do not choose. `check` runs once applied, as your own bash runs it and only while you have bash; its exit code and output are reported, and nothing is undone when it fails.",
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
				halted: Type.Optional(
					Type.Boolean({
						description:
							"Apply a halted chain's worktree as it is, only when the user asked for it despite the halt.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const scope = deps.scope();
			if (!scope || !ctx) return result("Subagent runtime is not initialized for this session.", true);
			try {
				const checkMayRun = pi.getActiveTools().includes("bash");
				return await integrate(deps, scope, ctx, { ...params, agent: params.agent.trim() }, checkMayRun, signal);
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
	ctx: ExtensionContext,
	params: { agent: string; preview?: boolean; keep?: string[]; check?: string; halted?: boolean },
	checkMayRun: boolean,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const target = resolveTarget(deps, scope, params.agent, params.halted === true);
	if (typeof target === "string") return result(target, true);
	for (const run of target.runs) {
		const why = await unsettled(deps, scope, run, target.asIs);
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
		const runTree = await worktreeTree(workspace);
		const whyNotStillSettled = (): string | undefined => {
			for (const run of target.runs) {
				const why = processesLeft(run.runDir) ?? occupant(deps, scope, workspace);
				if (why) return why;
			}
			return undefined;
		};
		const unsettledSince = whyNotStillSettled();
		if (unsettledSince) return result(`Not integrated: ${unsettledSince}`, true);
		const earlier = readIntegration(ownerDir);
		if (earlier?.tree === runTree) {
			return result(
				`Nothing to integrate: every change of ${label} since its baseline was already integrated, at ${new Date(earlier.at).toISOString()}.`,
			);
		}
		const base = earlier?.tree ?? baseline.tree;
		const source = baseline.source;
		const changes = await treeChanges(source, baseline.gitDir, base, runTree);
		if (changes.length === 0) return result(`Nothing to integrate: ${label} changed nothing since its baseline.`);
		const protectedPaths = new Map<string, string>();
		for (const { path } of changes) {
			const root = protectedRoot(path);
			if (root) protectedPaths.set(path, root);
		}
		const protectedList = [...protectedPaths.keys()].map(escapedPath);
		const skipped = `Skipped protected paths: ${protectedList.join(", ")}`;
		let after = runTree;
		let skippedProtected = false;
		if (!params.preview && protectedPaths.size > 0) {
			const choice = ctx.hasUI
				? await ctx.ui.select(
						[`Integrate protected paths from ${label}?`, ...protectedList.map((path) => `- ${path}`)].join("\n"),
						[INTEGRATE_NOTHING, INTEGRATE_REST, INTEGRATE_ALL],
						{ signal },
					)
				: INTEGRATE_REST;
			if (signal?.aborted || (choice !== INTEGRATE_REST && choice !== INTEGRATE_ALL)) {
				return result(`Integration cancelled. No changes from ${label} were applied.\n${skipped}`);
			}
			if (choice === INTEGRATE_REST) {
				skippedProtected = true;
				if (protectedPaths.size === changes.length)
					return result(`Nothing to integrate from ${label}.\n${skipped}`);
				after = await omitProtectedPaths(workspace, base, runTree, [...new Set(protectedPaths.values())]);
			}
		}
		const delta = skippedProtected ? changes.filter(({ path }) => !protectedPaths.has(path)) : changes;
		const paths = delta.map((change) => change.path);
		const keep = new Set((params.keep ?? []).map((path) => path.replace(/^\.\//, "")));

		const blocked = new Map<string, string>();
		for (const change of delta) {
			const problem = change.toMode === GITLINK ? "it is a nested repository" : pathProblem(source, change.path);
			if (problem) blocked.set(change.path, problem);
		}
		const linkFreePaths = paths.filter((path) => !blocked.has(path));
		const ours = await checkoutTree(workspace, base, linkFreePaths);
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
					...(protectedPaths.size ? [`Protected paths requiring approval: ${protectedList.join(", ")}`] : []),
					...(problems.length ? conflictText : ["It would apply cleanly."]),
					"",
					patch,
				].join("\n"),
			);
		}
		const unapproved = writes
			.map(({ path }) => path)
			.filter((path) => protectedRoot(path) !== undefined && (skippedProtected || !protectedPaths.has(path)));
		if (unapproved.length > 0) {
			return result(
				`Not integrated: the merge would also write protected paths: ${unapproved.map(escapedPath).join(", ")}.`,
				true,
			);
		}
		if (problems.length > 0) {
			return result(
				[
					`Not integrated: nothing of ${label} was applied, and your checkout ${source} is as it was.`,
					ownChanges,
					meanwhile,
					...(skippedProtected ? [skipped] : []),
					...conflictText,
				].join("\n"),
				true,
			);
		}

		const unsettledBeforeApply = whyNotStillSettled();
		if (unsettledBeforeApply) return result(`Not integrated: ${unsettledBeforeApply}`, true);
		const checkoutChangedSince = (tree: string) => checkoutTreeSync(workspace, base, linkFreePaths) !== tree;
		if (checkoutChangedSince(ours)) {
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
			? await runCheck(params.check, source, deps.agentDir(), ctx, checkMayRun, signal)
			: "Validation: none ran, so nothing validated the combined result. Run the project's checks, or call again with `check` next time.";
		return result(
			[
				`Integration: applied ${listChanges(applied, "nothing new (your checkout held its changes already)")} to ${source}, onto your checkout as it is now. Nothing was staged, committed or pushed.`,
				`Merged with your changes since its ${earlier ? "last Integration" : "baseline"}: ${listChanges(
					theirsMeanwhile.filter((path) => paths.includes(path) && !keep.has(path)),
					"none",
				)}`,
				...(kept.length ? [`Kept as in your checkout: ${listChanges(kept, "none")}`] : []),
				...(skippedProtected ? [skipped] : []),
				target.outcome,
				validation,
				`Its worktree ${root} is kept.`,
			].join("\n"),
		);
	} finally {
		release();
	}
}

function protectedRoot(path: string): string | undefined {
	const lower = path.toLowerCase();
	const root = PROTECTED_PROJECT_PATHS.find((entry) => lower === entry || lower.startsWith(`${entry}/`));
	return root && path.slice(0, root.length);
}

const escapedPath = (path: string) => sanitizeReportText(JSON.stringify(path).slice(1, -1));

function omitProtectedPaths(
	{ baseline }: IsolatedWorkspace,
	base: string,
	tree: string,
	roots: string[],
): Promise<string> {
	return withScratchIndex(undefined, async (scratch) => {
		const { source, gitDir } = baseline;
		const env = gitEnv({ GIT_DIR: gitDir, GIT_WORK_TREE: source, GIT_INDEX_FILE: scratch });
		await git(source, ["read-tree", tree], env);
		await git(source, ["--literal-pathspecs", "restore", `--source=${base}`, "--staged", "--", ...roots], env);
		return (await git(source, ["write-tree"], env)).trim();
	});
}

const leftWork = (chain: ChainResultDetails | undefined) =>
	chain !== undefined && !chain.completed && chain.workspace !== undefined && existsSync(chain.workspace.root);

function resolveTarget(deps: IntegrationDeps, scope: ParentScope, name: string, asIs: boolean): Target | string {
	const agentDir = deps.agentDir();
	const runOf = (runId: string) => {
		const record = deps.directory.find(scope, runId)?.record;
		return record && { record, runDir: subagentRunDir(agentDir, scope.parentSessionId, record.runId) };
	};
	if (name.startsWith(CHAIN_ID_PREFIX)) {
		const chain = readChainResult(agentDir, scope.parentSessionId, name);
		if (!chain) return `No settled chain "${name}" in this session: a chain is integrated once it has completed.`;
		const halted = chain.runs.filter((run) => run.status !== "completed");
		if (!chain.completed && !asIs) {
			return `Not integrated: chain ${name} halted (${halted.map((run) => `chain[${run.step}] ${run.status}`).join(", ")}). Its worktree keeps the partial work for you to inspect; it is not ready to integrate.${leftWork(chain) ? ` ${haltedIntegration(name)}` : ""}`;
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
			outcome: chain.completed
				? `Run: chain ${name}, ${chain.runs.length} step${chain.runs.length === 1 ? "" : "s"}, every one completed as its runtime saw it; what they claim to have checked is their own claim.`
				: `Run: chain ${name}, halted, integrated as it is at your request: ${haltedStepsText(deps, scope, chain)}. What its steps claim to have checked is their own claim.`,
			asIs: !chain.completed,
		};
	}
	const run = runOf(name);
	if (!run) return `No subagent "${name}" in this session.`;
	const { record, runDir } = run;
	const label = formatRunLabel(record);
	if (record.chain) {
		if (leftWork(readChainResult(agentDir, scope.parentSessionId, record.chain))) {
			return `${label} is a step of chain ${record.chain}, which halted: its work is integrated with its chain's. ${haltedIntegration(record.chain)}`;
		}
		return `${label} is a step of chain ${record.chain}: integrate the chain, "${record.chain}", once it has completed.`;
	}
	const workspace = isLegacyRun(record) ? undefined : runWorkspace(runDir);
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
		asIs: false,
	};
}

function haltedStepsText(deps: IntegrationDeps, scope: ParentScope, chain: ChainResultDetails): string {
	const last = new Map(chain.runs.map(({ runId }, i) => [runId, i]));
	return chain.runs
		.map(({ step, runId, name, status }, i) => {
			const record = runId && last.get(runId) === i ? deps.directory.find(scope, runId)?.record : undefined;
			const report =
				record && readRunReports(subagentRunDir(deps.agentDir(), scope.parentSessionId, record.runId), -1).at(-1);
			const now = record && memberOutcome({ record, report }).status;
			return `chain[${step}]${name ? ` "${name}"` : ""} ${status}${now && now !== status ? `, then resumed and ${now}` : ""}`;
		})
		.join("; ");
}

async function unsettled(
	deps: IntegrationDeps,
	scope: ParentScope,
	{ record, runDir }: { record: Readonly<SubagentRunRecord>; runDir: string },
	asIs: boolean,
): Promise<string | undefined> {
	const label = formatRunLabel(record);
	const now = () => deps.directory.find(scope, record.runId)?.record ?? record;
	const reportedButNotYetFinal = !isTerminalSubagentStatus(now().status) && deps.whenFinal(record.runId);
	if (reportedButNotYetFinal)
		await Promise.race([reportedButNotYetFinal, new Promise((resolve) => setTimeout(resolve, FINAL_WAIT_MS))]);
	const run = now();
	if (!isTerminalSubagentStatus(run.status)) {
		return `${label} is still ${run.status}: Integration waits until its work has settled and none of its processes runs.`;
	}
	const reason = run.errorMessage?.split("\n")[0];
	if (run.status !== "closed" && !asIs) {
		return `${label} ended ${run.status}${reason ? ` (${reason})` : ""}. Its worktree keeps its partial work for you to inspect; it is not ready to integrate.`;
	}
	const lastSettlement = readRunReports(runDir, EVERY_STORED_REPORT).at(-1)?.outcome;
	if (!(lastSettlement && settledWithoutError(lastSettlement)) && !asIs) {
		return `${label}'s last work did not complete (${lastSettlement?.error ?? reason ?? "no outcome was stored"}). Its worktree keeps its partial work for you to inspect; it is not ready to integrate.`;
	}
	const left = processesLeft(runDir);
	if (left) return left;
	const definition = generationDefinition(runDir, run.generation);
	if (!definition)
		return `nothing confirms what ${label} could run: the definition of its generation ${run.generation} cannot be read.`;
	if (definition.shell) {
		const ready = await prepareRunContainment();
		const members = ready.ok
			? await runProcesses({ helper: ready.helper, marker: runMachMarker(definition.shell.runId) }).catch(
					() => undefined,
				)
			: undefined;
		if (!members) return `nothing confirms that no process ${label}'s commands started still runs.`;
		if (members.length > 0) return `processes ${label}'s commands started still run (${members.join(", ")}).`;
	}
	return undefined;
}

function processesLeft(runDir: string): string | undefined {
	const left = runProcessesLeft(runDir);
	return left && `processes of the run in ${runDir} still run (process group ${left.group}).`;
}

function occupant(deps: IntegrationDeps, scope: ParentScope, { root }: IsolatedWorkspace): string | undefined {
	const run = deps.directory.list(scope).find(({ record }) => within(root, record.cwd))?.record;
	return run && `${formatRunLabel(run)} works in ${root} now: let it finish first.`;
}

async function lockRepository(gitDir: string, signal: AbortSignal | undefined): Promise<() => void> {
	const lockInGitDir = join(gitDir, "bluclawd-integration.lock");
	const token = `${process.pid} ${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(lockInGitDir, "wx", 0o600);
			writeFileSync(fd, token);
			closeSync(fd);
			return () => {
				try {
					if (readFileSync(lockInGitDir, "utf8") === token) unlinkSync(lockInGitDir);
				} catch {}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder = Number.NaN;
		try {
			holder = Number(readFileSync(lockInGitDir, "utf8").split(" ")[0]);
		} catch {
			continue;
		}
		if (Number.isInteger(holder) && holder > 0 && !processAlive(holder)) {
			rmSync(lockInGitDir, { force: true });
			continue;
		}
		if (signal?.aborted || Date.now() > deadline) {
			throw new Error(`another Integration into the repository of ${gitDir} is under way (process ${holder})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function worktreeTree({ root, baseline }: IsolatedWorkspace): Promise<string> {
	return withScratchIndex(undefined, async (scratch) => {
		const env = gitEnv({ GIT_DIR: baseline.gitDir, GIT_WORK_TREE: root, GIT_INDEX_FILE: scratch });
		await git(root, ["read-tree", baseline.tree], env);
		await git(root, ["add", "-A"], env);
		return (await git(root, ["write-tree"], env)).trim();
	});
}

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

async function mergeTrees(
	source: string,
	gitDir: string,
	base: string,
	ours: string,
	theirs: string,
): Promise<{ tree: string; conflicts: Map<string, string[]> }> {
	const env = gitEnv({ GIT_DIR: gitDir });
	// Git before 2.45 merges only commits, so each tree goes in one, in the object store only.
	const commit = (tree: string) => gitSync(source, ["commit-tree", "--no-gpg-sign", "-m", "Integration", tree], env);
	const args = [
		"merge-tree",
		"--write-tree",
		"-z",
		"--name-only",
		`--merge-base=${commit(base)}`,
		commit(ours),
		commit(theirs),
	];
	const run = spawnSync("git", withoutUserHooks(args), {
		cwd: source,
		env,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const failed = () =>
		new Error(`Git could not merge (${(run.stderr || run.error?.message || "").trim().split("\n")[0]})`);
	if (run.status !== 0 && run.status !== 1) throw failed();
	const [head, messages = ""] = run.stdout.split("\0\0");
	const [tree, ...conflicted] = head.split("\0").filter(Boolean);
	if (!isObjectId(tree)) throw failed();
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

const isObjectId = (value: string | undefined) => /^[0-9a-f]{40,64}$/.test(value ?? "");

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
	} catch {}
	return undefined;
}

function denyRules(agentDir: string, ctx: IntegrationContext, runDir: string): RpcDenyRules[] {
	const current = rpcDenyRules(agentDir, [{ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }]);
	if (!current.ok) throw new Error(current.error.replace(/^Cannot launch subagent: /, "").replace(/\.$/, ""));
	return [...current.deny, ...(generationDefinition(runDir, 0)?.deny ?? [])];
}

function denied(deny: RpcDenyRules[], tool: string, path: string): string | undefined {
	for (const { cwd, rules } of deny) {
		const blocked = evaluateToolCallDeny(rules, tool, { path }, cwd);
		if (blocked) return blocked.reason;
	}
	return undefined;
}

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
		} catch {}
		mode = change.toMode === "100755" ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;
		writeFileSync(temporary, content.stdout, { mode });
		chmodSync(temporary, mode);
	}
	renameSync(temporary, target);
}

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

async function runCheck(
	command: string,
	source: string,
	agentDir: string,
	ctx: IntegrationContext,
	checkMayRun: boolean,
	signal: AbortSignal | undefined,
): Promise<string> {
	const where = within(source, ctx.cwd) ? ctx.cwd : source;
	const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
	const deny = rpcDenyRules(agentDir, [{ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }]);
	const blocked = deny.ok
		? deny.deny.map(({ rules }) => evaluateToolCallDeny(rules, "bash", { command }, where)).find(Boolean)
		: { reason: deny.error };
	const notRun = (why: string) =>
		`Validation: \`${command}\` did not run: ${why}. Nothing validated the combined result.`;
	if (!checkMayRun) return notRun("your bash tool is not active, so you may not run commands");
	if (blocked) return notRun(blocked.reason ?? "a deny rule forbids it");
	const sandboxed = sandboxStatus().kind !== "off";
	const noExistingWrapToReuse = sandboxed && !sandboxWraps();
	if (noExistingWrapToReuse)
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
		({ exitCode } = await exec(withCommandPrefix(prefix, command), where, {
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
