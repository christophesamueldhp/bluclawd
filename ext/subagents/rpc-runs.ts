import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { processGroupAlive } from "../../daemon/processes.ts";
import { runMachMarker } from "../../daemon/run-members.ts";
import { type RunHostLaunch, runPaneSession, runQueueKey, type SlotClaim } from "../../daemon/run-queue.ts";
import * as forkSettings from "../_shared/settings.ts";
import { ownAndDefaultServerDirs } from "../sandbox/config.ts";
import {
	endRunProcesses,
	prepareRunContainment,
	type RunContainment,
	type RunContainmentReady,
} from "../sandbox/run-containment.ts";
import type { AgentDefinition } from "./definitions.ts";
import { TASK_TYPED_IN_PANE } from "./generation-protocol.ts";
import { type GenerationState, generationState, movePane, runDefinitionPath, storeLaunch } from "./generation-state.ts";
import {
	haltedIntegration,
	NOTHING_TO_CLOSE,
	type RunReports,
	rpcRunMessageText,
	runTaskText,
	SUBAGENT_MESSAGE_TOOL,
} from "./messages.ts";
import { truncateUtf8Safe } from "./results.ts";
import { type RpcDenyRules, RUN_DEFINITION_FLAG, WRITE_TOOLS } from "./rpc-child.ts";
import { prepareRpcHost, type RpcHostSpec, STOP_GRACE_MS, stopRpcHost } from "./rpc-host.ts";
import {
	answerRunApproval,
	markRunApprovalSeen,
	openRunApprovalRequests,
	type RunApprovalAnswer,
	type RunApprovalRequest,
	runApprovalWithdrawn,
} from "./run-approvals.ts";
import { checksLines, generationEvidence, sessionFileEntries } from "./run-evidence.ts";
import {
	markRunOutboxRelayed,
	openRunInbox,
	type RunOutboxMessage,
	readRunOutbox,
	relayedRunOutbox,
	sealedRunInbox,
	sealRunInbox,
} from "./run-mailbox.ts";
import { runShellTmp } from "./run-shell.ts";
import {
	discardWorktree,
	type IsolatedWorkspace,
	materializeWorktree,
	releaseUnchangedWorktree,
	workspaceInstructions,
	worktreeOwner,
} from "./run-worktree.ts";
import {
	handedOff,
	isLegacyRun,
	type PiSettlement,
	type RunKind,
	type SubagentRunExecuteParams,
	type SubagentRunOutcome,
	type SubagentRunRecord,
	settledWithoutError,
} from "./runs.ts";
import { readChainResult, readRunReports, storedRunReportTextPath } from "./storage.ts";
import { sessionUsage } from "./usage.ts";

const RPC_PROVIDER_EXTENSIONS_ENV = "BLUCLAWD_RPC_PROVIDER_EXTENSIONS";
const CHILD_EXTENSION = fileURLToPath(new URL("./rpc-child.ts", import.meta.url));
const PANE_CHILD_EXTENSION = fileURLToPath(new URL("./pane-child.ts", import.meta.url));

const READ_TOOLS = ["read", "grep", "find", "ls"];
export const WORKTREE_TOOLS = [...WRITE_TOOLS, "bash"];
const RPC_TOOLS = [...READ_TOOLS, "codemode", ...WORKTREE_TOOLS];
const OPTIONAL_TOOL = "?";
const DEFAULT_RPC_TOOLS = [...READ_TOOLS, "codemode"].map((tool) => `${tool}${OPTIONAL_TOOL}`);

/** pi's names for MCP tools, which its `--tools` list does not filter. */
const MCP_TOOLS = ["mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

export interface RpcLaunch {
	name: string;
	definition: AgentDefinition;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	tools: string[];
	task: string;
	cwd: string;
	runDir: string;
	agentDir: string;
	projectTrusted: boolean;
	sessionFile?: string;
	parentPane?: string;
	typed?: true;
	taskFrom?: "user";
	workspace?: IsolatedWorkspace;
	worktreeMade?: boolean;
	keepWorktree?: boolean;
	recovered?: RpcHostSpec;
	recheck(): string | undefined;
}

export interface RunDefinition extends AgentDefinition {
	tools: string[];
	deny: RpcDenyRules[];
	cwd: string;
	projectTrusted: boolean;
	admitted: { provider: string; modelId: string; thinkingLevel: string };
	workspace?: IsolatedWorkspace;
	shell?: { runId: string; runDir: string };
	admittedAt?: number;
}

export function runKind(run: Pick<SubagentRunRecord, "backend" | "kind" | "generation">, runDir: string): RunKind {
	if (isLegacyRun(run)) return "legacy";
	if (run.kind) return run.kind;
	const latest = generationState(runDir, run.generation);
	return latest.at !== "unadmitted" && latest.launch?.pane ? "pane" : "rpc";
}

export function narrowRunDefinition(
	definition: RunDefinition,
	grantable: readonly string[],
	deny: readonly RpcDenyRules[],
): RunDefinition {
	const stored = new Set(definition.deny.map((rules) => JSON.stringify(rules)));
	return {
		...definition,
		tools: definition.tools.filter((tool) => grantable.includes(tool)),
		deny: [...definition.deny, ...deny.filter((rules) => !stored.has(JSON.stringify(rules)))],
	};
}

export function rpcGrantableTools(callable: readonly string[], registered: readonly string[]): string[] {
	return [...callable, ...(registered.includes("codemode") && !callable.includes("codemode") ? ["codemode"] : [])];
}

const toolName = (listed: string) => (listed.endsWith(OPTIONAL_TOOL) ? listed.slice(0, -1) : listed);

export function rpcRunProviderRefusal(provider: string, extensionProviders: readonly string[]): string | undefined {
	if (!extensionProviders.includes(provider) || process.env[RPC_PROVIDER_EXTENSIONS_ENV]) return undefined;
	return `Cannot launch subagent: provider "${provider}" is registered by an extension of this pi, which a run's pi does not load, so the run would not have it as you do. Choose a model of a provider pi has built in, or one configured in models.json.`;
}

export function rpcRunMayShell(definition: Pick<AgentDefinition, "tools">): boolean {
	return definition.tools?.some((tool) => toolName(tool) === "bash") === true;
}

export function rpcRunTools(
	definition: Pick<AgentDefinition, "name" | "tools">,
	available: readonly string[],
	shell: RunContainmentReady | undefined,
): { ok: true; tools: string[] } | { ok: false; error: string } {
	const listed = definition.tools ?? DEFAULT_RPC_TOOLS;
	const givable = (tool: string) => available.includes(tool) && (tool !== "bash" || shell?.ok === true);
	const refused = listed.map(toolName).filter((tool) => !RPC_TOOLS.includes(tool));
	if (refused.length > 0) {
		return {
			ok: false,
			error: `Subagent role "${definition.name}" names tools a run on pi's RPC cannot have: ${refused.join(", ")}. It may only read, script its reads with codemode, and edit files and run commands in a worktree of its own (${RPC_TOOLS.join(", ")}): no MCP, tool search or subagents.`,
		};
	}
	const unknown = listed.filter((tool) => !tool.endsWith(OPTIONAL_TOOL) && !available.includes(tool));
	if (unknown.length > 0) {
		return {
			ok: false,
			error: `Subagent role "${definition.name}" names tools the orchestrator cannot give a child: ${unknown.join(", ")}. Available: ${available.join(", ") || "none"}.`,
		};
	}
	const named = listed.filter((tool) => !tool.endsWith(OPTIONAL_TOOL) || givable(toolName(tool))).map(toolName);
	if (named.includes("bash") && !shell?.ok) {
		return {
			ok: false,
			error: `Subagent role "${definition.name}" names bash, and a run gets no shell here: ${shell?.ok === false ? shell.reason : "it was not checked"}. Give it a role that does not run commands.`,
		};
	}
	return { ok: true, tools: [...named] };
}

/** Where tools and logins commonly keep credentials: no run reads them, whatever the user's rules say. */
const HOME_CREDENTIALS = [
	"Read(~/.ssh/**)",
	"Read(~/.aws/**)",
	"Read(~/.gnupg/**)",
	"Read(~/.config/gh/**)",
	"Read(~/.config/gcloud/**)",
	"Read(~/.azure/**)",
	"Read(~/.kube/**)",
	"Read(~/.docker/config.json)",
	"Read(~/.netrc)",
	"Read(~/Library/Keychains/**)",
];

/** A Read rule on an absolute path, which a rule spells with a leading `//`. */
const absoluteRead = (path: string) => `Read(/${path})`;

export function rpcDenyRules(
	agentDir: string,
	dirs: { cwd: string; trusted: boolean }[],
): { ok: true; deny: RpcDenyRules[] } | { ok: false; error: string } {
	const deny: RpcDenyRules[] = [];
	for (const { cwd, trusted } of dirs) {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
		const unread = [
			...settings.drainErrors().map(({ path, scope }) => path ?? `${scope} settings`),
			...forkSettings.invalidDenyScopes(settings).map((scope) => `${scope} permissions.deny`),
		];
		if (unread.length > 0) {
			return {
				ok: false,
				error: `Cannot launch subagent: the deny rules it must be held to cannot be read (${unread.join(", ")}).`,
			};
		}
		deny.push({ cwd, rules: forkSettings.denyRules(settings) });
	}
	return {
		ok: true,
		deny: [
			...deny,
			{
				cwd: homedir(),
				rules: [
					...HOME_CREDENTIALS,
					...["auth.json", "models.json"].map((name) => absoluteRead(join(agentDir, name))),
					...ownAndDefaultServerDirs().map((dir) => absoluteRead(join(dir, "**"))),
				],
			},
		],
	};
}

function paneExtensions(agentDir: string, cwd: string): string[] {
	const own = ["branding", "transcript", "agent-view", "help", "vibes", "paste", "skills", "accounts"].map((name) =>
		fileURLToPath(new URL(`../${name}/index.ts`, import.meta.url)),
	);
	// By where it is installed, because `-e` would install a package source again, in a temporary place, for every run.
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const statusline = new DefaultPackageManager({ cwd, agentDir, settingsManager })
		.listConfiguredPackages()
		.flatMap(({ source, scope, installedPath }) =>
			scope === "user" && installedPath && /pistatusline/.test(source) ? [installedPath] : [],
		);
	return [...own, ...statusline];
}

function rpcArgs(launch: RpcLaunch, instructionsFile: string, definitionFile: string): string[] {
	const providers = (process.env[RPC_PROVIDER_EXTENSIONS_ENV] ?? "").split(":").filter(Boolean);
	const extensions = launch.parentPane
		? [CHILD_EXTENSION, PANE_CHILD_EXTENSION, ...providers, ...paneExtensions(launch.agentDir, launch.cwd)]
		: [CHILD_EXTENSION, ...providers];
	return [
		...(launch.parentPane ? [] : ["--mode", "rpc"]),
		"-ne",
		...extensions.flatMap((path) => ["-e", path]),
		"--provider",
		launch.provider,
		"--model",
		launch.modelId,
		"--thinking",
		launch.thinkingLevel,
		"--tools",
		[...launch.tools, SUBAGENT_MESSAGE_TOOL].join(","),
		"--exclude-tools",
		MCP_TOOLS.join(","),
		"--name",
		launch.name,
		"--append-system-prompt",
		instructionsFile,
		// By its absolute path, because pi would ask on its stdout before opening a session by an id from another project.
		...(launch.sessionFile ? ["--session", launch.sessionFile] : ["--session-dir", launch.runDir]),
		launch.projectTrusted ? "--approve" : "--no-approve",
		`--${RUN_DEFINITION_FLAG}`,
		definitionFile,
	];
}

export const MAX_RUN_REPORT_BYTES = 8 * 1024;
export const REPORT_INSTRUCTIONS = [
	"",
	"",
	"## Your Report",
	"Your last message, once your work is done, is your Report to your orchestrator. Keep it concise, well under 2,000 tokens and shorter for simple work: what you found or changed, the checks you actually ran and how they ended, and what blocks you. Cite where the evidence is rather than pasting it; your transcript is kept. Never claim a check you did not run.",
].join("\n");

export function runInstructions(
	definition: Pick<AgentDefinition, "instructions">,
	tools: readonly string[],
	workspace: IsolatedWorkspace | undefined,
): string {
	return (
		definition.instructions +
		(workspace
			? `\n${workspaceInstructions(
					workspace,
					tools.some((tool) => WORKTREE_TOOLS.includes(tool)),
					tools.includes("bash"),
				)}`
			: "") +
		REPORT_INSTRUCTIONS
	);
}

const MAX_REASON_BYTES = 1024;
const HOST_CHECK_MS = 100;
const KILL_WAIT_MS = 5000;

export interface RunSlots {
	ensure(): Promise<boolean>;
	claim(run: string, parent: string, signal: AbortSignal): Promise<"granted" | "waitExpired">;
	claimNow(run: string, parent: string): Promise<SlotClaim>;
	launch(run: string, host: RunHostLaunch): Promise<number>;
	release(run: string): Promise<void>;
}

export function daemonRunSlots(): RunSlots {
	let sharedEnsure: Promise<boolean> | undefined;
	return {
		ensure: () => {
			sharedEnsure ??= new OrchestratorClient().ensureDaemon().finally(() => {
				sharedEnsure = undefined;
			});
			return sharedEnsure;
		},
		claim: async (run, parent, signal) =>
			(await new OrchestratorClient().claimRun(run, parent, signal)) ? "granted" : "waitExpired",
		claimNow: (run, parent) => new OrchestratorClient().claimRunNow(run, parent),
		launch: (run, host) => new OrchestratorClient().launchRun(run, host),
		release: (run) => new OrchestratorClient().releaseRun(run),
	};
}

const QUEUE_TRIES = 3;

async function startInTurn(
	run: string,
	parent: string,
	host: RunHostLaunch,
	recheck: () => string | undefined,
	slots: RunSlots,
	signal: AbortSignal,
): Promise<{ hostPid: number } | { refused: string } | { error: string } | undefined> {
	let failures = 0;
	while (!signal.aborted) {
		try {
			if ((await slots.claim(run, parent, signal)) === "waitExpired") {
				failures = 0;
				continue;
			}
			if (signal.aborted) break;
			const refused = recheck();
			if (refused) {
				await slots.release(run).catch(() => {});
				return { refused };
			}
			return { hostPid: await slots.launch(run, host) };
		} catch (error) {
			if (signal.aborted) break;
			await slots.ensure();
			if (++failures >= QUEUE_TRIES) {
				await slots.release(run).catch(() => {});
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}
	}
	slots.release(run).catch(() => {});
	return undefined;
}

type HeldForGood = () => boolean;

export interface RpcRunDeps {
	reports: RunReports;
	slots: RunSlots;
	notStarted(reason: string): void;
	lost(reason: string): void;
	notify(report: Extract<SessionMessage, { kind: "report" }>): void;
	usage(sessionId: string, totals: SessionUsage): void;
	handOff: AbortSignal;
	relay(message: RunOutboxMessage): HeldForGood;
	typed(text: string): void;
	approve(request: RunApprovalRequest, signal: AbortSignal): Promise<RunApprovalAnswer>;
}

const untakenText = (count: number, runDir: string, generation: number) =>
	`${count} message${count === 1 ? "" : "s"} sent to it never reached its pi, kept in ${sealedRunInbox(runDir, generation)}`;

function prepareGeneration(record: Readonly<SubagentRunRecord>, launch: RpcLaunch): RpcHostSpec {
	const { recovered } = launch;
	if (recovered) {
		if (recovered.pane) movePane(launch.runDir, record.generation, recovered.pane.parent);
		return recovered;
	}
	const instructions = join(launch.runDir, "instructions.md");
	writeFileSync(instructions, runInstructions(launch.definition, launch.tools, launch.workspace));
	openRunInbox(launch.runDir, record.generation);
	const spec: RpcHostSpec = {
		args: rpcArgs(launch, instructions, runDefinitionPath(launch.runDir, record.generation)),
		cwd: launch.cwd,
		agentDir: launch.agentDir,
		prompt: launch.typed
			? TASK_TYPED_IN_PANE
			: launch.taskFrom === "user"
				? rpcRunMessageText({ kind: "user" }, record, launch.task)
				: runTaskText(launch.task, launch.sessionFile !== undefined),
		model: { provider: launch.provider, id: launch.modelId, thinkingLevel: launch.thinkingLevel },
		generation: record.generation,
		...(launch.sessionFile ? { sessionFile: launch.sessionFile } : {}),
		...(launch.parentPane
			? { pane: { session: runPaneSession(record.runId, record.generation), parent: launch.parentPane } }
			: {}),
	};
	storeLaunch(launch.runDir, spec);
	return spec;
}

export async function executeRpcRun(
	{ record, signal, controller }: SubagentRunExecuteParams,
	launch: RpcLaunch,
	deps: RpcRunDeps,
): Promise<SubagentRunOutcome> {
	const { workspace, recovered } = launch;
	const spec = prepareGeneration(record, launch);
	let relayed = relayedRunOutbox(launch.runDir, record.generation);
	const handed = new Map<number, HeldForGood>();
	const relay = () => {
		const pending = readRunOutbox(launch.runDir, record.generation, relayed);
		for (const message of pending) {
			if (handed.has(message.seq)) continue;
			if (message.kind === "typed") {
				deps.typed(message.text);
				handed.set(message.seq, () => true);
				continue;
			}
			if (message.kind === "progress") controller.updateProgress(message.content);
			handed.set(message.seq, message.kind === "progress" ? () => true : deps.relay(message));
		}
		let held = relayed;
		for (const { seq } of pending) {
			if (!handed.get(seq)?.()) break;
			handed.delete(seq);
			held = seq;
		}
		if (held === relayed) return;
		relayed = held;
		markRunOutboxRelayed(launch.runDir, record.generation, relayed);
	};
	const sealUnstartedGeneration = () => {
		if (workspace && !launch.sessionFile && !launch.worktreeMade) {
			discardWorktree(workspace, { agentDir: launch.agentDir, runId: record.runId, runDir: launch.runDir });
		}
		const untaken = sealRunInbox(launch.runDir, record.generation).length;
		return untaken ? `; ${untakenText(untaken, launch.runDir, record.generation)}.` : "";
	};
	const didNotStart = (reason: string): SubagentRunOutcome => {
		if (record.deliveryMode === "background" && !deps.reports.awaited(record.runId)) deps.notStarted(reason);
		return {
			status: launch.sessionFile ? "closed" : "failed",
			summaryText: "",
			errorMessage: `It did not start: ${reason}${sealUnstartedGeneration()}`,
		};
	};
	let contained: RunContainment | undefined;
	const host = prepareRpcHost(launch.runDir, spec);
	if (launch.tools.includes("bash")) {
		const ready = await prepareRunContainment();
		if (!ready.ok) {
			return didNotStart(`its shell cannot be contained (${ready.reason})`);
		}
		contained = { helper: ready.helper, marker: runMachMarker(record.runId) };
	}
	const found = recovered ? generationState(launch.runDir, record.generation) : undefined;
	const taken = found && "hostPid" in found ? found.hostPid : undefined;
	if (
		workspace &&
		!launch.sessionFile &&
		!launch.worktreeMade &&
		!taken &&
		!(recovered && existsSync(workspace.root))
	) {
		try {
			await materializeWorktree(workspace);
		} catch (error) {
			return didNotStart(
				`its worktree could not be made (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
	const generationStartedAt = recovered ? (record.startedAt ?? Date.now()) : Date.now();
	const turn = taken
		? { hostPid: taken }
		: await startInTurn(
				runQueueKey(record.runId, record.generation),
				record.parentSessionId,
				contained ? { ...host, contained: true } : host,
				launch.recheck,
				deps.slots,
				AbortSignal.any([signal, deps.handOff]),
			);
	if (!turn) {
		if (deps.handOff.aborted) return handedOff();
		return {
			status: "cancelled",
			summaryText: "",
			errorMessage: `It was stopped before it started${sealUnstartedGeneration()}`,
		};
	}
	if (!("hostPid" in turn)) {
		const reason = "refused" in turn ? turn.refused : `the daemon could not start it (${turn.error})`;
		return didNotStart(reason);
	}
	controller.markRunning();
	const now = () => generationState(launch.runDir, record.generation, turn.hostPid);
	const hostOf = (state: GenerationState) => ("hostPid" in state ? state.hostPid : turn.hostPid);
	const gone = (found?.at === "ended" || found?.at === "lost") && found.gone === true;
	const ended = (state: GenerationState) => gone || state.at === "ended" || state.at === "lost";
	const stored = (state: GenerationState) => ("hostPid" in state ? state : undefined);
	const asked = new Map<string, AbortController>();
	const approvals = () => {
		for (const request of openRunApprovalRequests(launch.runDir, record.generation)) {
			markRunApprovalSeen(launch.runDir, record.generation, request.id);
			if (asked.has(request.id)) continue;
			const pending = new AbortController();
			asked.set(request.id, pending);
			void deps
				.approve(request, pending.signal)
				.catch((): RunApprovalAnswer => "blocked")
				.then((answer) => {
					if (pending.signal.aborted) return;
					asked.delete(request.id);
					answerRunApproval(launch.runDir, record.generation, request.id, answer);
				});
		}
		for (const [id, pending] of asked) {
			if (!runApprovalWithdrawn(launch.runDir, record.generation, id)) continue;
			asked.delete(id);
			pending.abort();
		}
	};
	let awaiting = false;
	const paneActivity = (state: GenerationState) => {
		if (!launch.parentPane || state.at !== "hosted" || state.awaiting === awaiting) return;
		awaiting = state.awaiting;
		controller.updateActivity(awaiting ? "awaiting_input" : "working");
	};
	await until(
		() => {
			if (deps.handOff.aborted) return false;
			relay();
			approvals();
			const state = now();
			paneActivity(state);
			return ended(state);
		},
		AbortSignal.any([signal, deps.handOff]),
	);
	for (const [id, pending] of asked) {
		pending.abort();
		if (!signal.aborted && !deps.handOff.aborted) answerRunApproval(launch.runDir, record.generation, id, "blocked");
	}
	if (deps.handOff.aborted) return handedOff();
	const last = now();
	const hostPid = hostOf(last);
	if (!ended(last)) stopRpcHost(hostPid);
	const terminated = gone ? !contained || (await endRunProcesses(contained)) : await endHostGroup(hostPid, contained);
	if (deps.handOff.aborted) return handedOff();
	if (terminated && contained) rmSync(runShellTmp(launch.agentDir, record.runId), { recursive: true, force: true });
	const notStarted = terminated ? stored(now())?.notStarted : undefined;
	if (notStarted) return didNotStart(notStarted);
	if (workspace && terminated && !launch.keepWorktree) {
		await releaseUnchangedWorktree(workspace, worktreeOwner(workspace, launch.agentDir, record.parentSessionId));
	}
	relay();
	const final = now();
	const state = stored(final);
	const exited = final.at === "ended" ? final : undefined;
	const entries = state?.sessionFile ? sessionFileEntries(state.sessionFile) : undefined;
	const usage = entries && sessionUsage(entries);
	if (usage) {
		controller.updateUsage(usage);
		deps.usage(state?.sessionId ?? record.runId, usage);
	}
	const evidence = await generationEvidence(launch.agentDir, launch.runDir, record.generation, {
		transcript: state?.sessionFile,
		startForPreAdmittedAtGenerations: generationStartedAt,
	});
	const workspaceLines = evidence.workspace?.lines ?? [];
	const workspaceNote = workspaceLines.length ? `\n${workspaceLines.join("\n")}` : "";
	const confirmedReport = state?.reportSeq === undefined ? undefined : evidence.report;
	if (!terminated) {
		sealRunInbox(launch.runDir, record.generation);
		return {
			status: "failed",
			summaryText: confirmedReport?.text ?? "",
			errorMessage: `Its processes did not all end, even killed: ${contained ? `process group ${hostPid}, or a process its commands started,` : `process group ${hostPid}`} still runs. Nothing confirms its work stopped.${workspaceNote}`,
			transcriptPath: state?.sessionFile,
		};
	}
	if (exited?.idle) {
		sealRunInbox(launch.runDir, record.generation);
		const earlier = readRunReports(launch.runDir, 0).at(-1)?.text ?? "";
		return { status: "closed", summaryText: earlier, transcriptPath: exited.sessionFile };
	}
	if (!exited || !confirmedReport) {
		sealRunInbox(launch.runDir, record.generation);
		if (signal.aborted) {
			return {
				status: "cancelled",
				summaryText: "",
				errorMessage: `Its work was stopped, and nothing of it runs any more; no Report was stored.${workspaceNote}`,
				transcriptPath: state?.sessionFile,
			};
		}
		if (!recovered) {
			return {
				status: "failed",
				summaryText: confirmedReport?.text ?? "",
				errorMessage: `The run's host ended before its pi did; see rpc-host.error and rpc-child.stderr in ${launch.runDir}.${workspaceNote}`,
				transcriptPath: state?.sessionFile,
			};
		}
		const uncertain = `its host ended with no Report stored, so what its work did by then is uncertain, side effects included; it is not started again. Its transcript says how far it got: ${state?.sessionFile ?? "none was stored"}`;
		deps.lost(uncertain);
		return {
			status: "failed",
			summaryText: "",
			errorMessage: `${uncertain[0].toUpperCase()}${uncertain.slice(1)}; see also rpc-host.error and rpc-child.stderr in ${launch.runDir}.${workspaceNote}`,
			transcriptPath: state?.sessionFile,
		};
	}
	const outcome: PiSettlement = confirmedReport.outcome ?? { status: "failed", error: "no outcome was stored" };
	controller.markDelivered(confirmedReport.seq);
	controller.updateProgress(confirmedReport.text);
	const fullReport = storedRunReportTextPath(launch.runDir, confirmedReport.seq);
	const reviewed = (how: string) => `Integration: once you have reviewed its changes, ${how} to your checkout.`;
	const completed = record.chain && readChainResult(launch.agentDir, record.parentSessionId, record.chain)?.completed;
	const integration =
		!evidence.workspace ||
		!settledWithoutError(outcome) ||
		launch.keepWorktree ||
		!existsSync(evidence.workspace.root)
			? undefined
			: !record.chain
				? reviewed(`subagent_integrate "${launch.name}" applies them`)
				: completed
					? reviewed(`subagent_integrate "${record.chain}" applies its chain's changes`)
					: completed === false
						? `Integration: its chain ${record.chain} halted, so its changes are not ready to integrate. ${haltedIntegration(record.chain)}`
						: undefined;
	const runtime = [
		"---",
		`Outcome: ${outcome.status}${settledWithoutError(outcome) ? ": its pi settled its work without an error. What the run says above is its own claim; the runtime verified none of it." : `: ${cutReason(outcome.error)}.`}`,
		`Process: exited with ${exited.exit.signal ? `signal ${exited.exit.signal}` : `code ${exited.exit.code}`}, after its Report was stored: ${NOTHING_TO_CLOSE}`,
		...checksLines(launch.tools, "ran" in evidence.commands ? evidence.commands.ran : []),
		...(evidence.workspace ? workspaceLines : ["Changes: none: it had no tool that changes files."]),
		...(integration ? [integration] : []),
		`Transcript: ${exited.sessionFile ?? "none"}`,
		`Report: ${fullReport}`,
		...(confirmedReport.untaken
			? [`Untaken: ${untakenText(confirmedReport.untaken, launch.runDir, record.generation)}.`]
			: []),
	].join("\n");
	const text = `${boundedClaim(confirmedReport.text, MAX_RUN_REPORT_BYTES - bytes(runtime) - 1, fullReport)}\n${runtime}`;
	const message: Extract<SessionMessage, { kind: "report" }> = {
		type: "session_message",
		kind: "report",
		from: record.runId,
		text,
		seq: confirmedReport.seq,
		...(usage ? { usage } : {}),
		...(exited.sessionId ? { sessionId: exited.sessionId } : {}),
	};
	const delivered = (record.lastDeliveredSeq ?? 0) >= confirmedReport.seq;
	if (!signal.aborted && !delivered && !deps.reports.take(record.runId, message)) deps.notify(message);
	return {
		status: signal.aborted && !settledWithoutError(outcome) ? "cancelled" : "closed",
		summaryText: confirmedReport.text,
		transcriptPath: exited.sessionFile,
		...(settledWithoutError(outcome) ? {} : { errorMessage: `${cutReason(outcome.error)}${workspaceNote}` }),
	};
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function boundedClaim(text: string, room: number, fullReport: string): string {
	if (bytes(text) <= room) return text;
	const cut = `\n[Cut short; its full Report: ${fullReport}]`;
	return `${truncateUtf8Safe(text, Math.max(0, room - bytes(cut))).text}${cut}`;
}

function cutReason(error: string): string {
	const { text, truncated } = truncateUtf8Safe(error, MAX_REASON_BYTES);
	return truncated ? `${text} […]` : text;
}

function until(done: () => boolean, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		const check = () => {
			if (done()) return finish(true);
			if (signal.aborted) return finish(false);
		};
		const finish = (result: boolean) => {
			clearInterval(timer);
			signal.removeEventListener("abort", check);
			resolve(result);
		};
		const timer = setInterval(check, HOST_CHECK_MS);
		signal.addEventListener("abort", check);
		check();
	});
}

async function endHostGroup(hostPid: number, contained: RunContainment | undefined): Promise<boolean> {
	const gone = () => !processGroupAlive(hostPid);
	if (!(await until(gone, AbortSignal.timeout(STOP_GRACE_MS))) && processGroupAlive(hostPid, { fresh: true })) {
		try {
			process.kill(-hostPid, "SIGKILL");
		} catch {}
		if (!(await until(gone, AbortSignal.timeout(KILL_WAIT_MS)))) return false;
	}
	return contained ? endRunProcesses(contained) : true;
}
