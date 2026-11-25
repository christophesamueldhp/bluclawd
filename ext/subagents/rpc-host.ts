import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestratorClient, piPackageRoot } from "../../daemon/orchestrator-client.ts";
import type { RunHostLaunch } from "../../daemon/run-queue.ts";
import { PANE_ENV, PARENT_ENV, RUN_HOST_ENV, RUN_PANE_ENV, Tmux } from "../../daemon/tmux.ts";
import { type StartedPi, startGeneration } from "./generation-protocol.ts";
import { claimGeneration, type HostSeat } from "./generation-state.ts";
import {
	dialogAnswer,
	type RunApprovalAnswer,
	runApprovalAnswer,
	runApprovalAsked,
	runApprovalSeenAt,
	storeRunApprovalRequest,
	withdrawRunApproval,
} from "./run-approvals.ts";
import { sealRunInbox } from "./run-mailbox.ts";
import { type PiSettlement, tryTmux } from "./runs.ts";
import { storeRunReport } from "./storage.ts";

export interface RpcHostSpec {
	args: string[];
	cwd: string;
	agentDir: string;
	prompt: string;
	model: { provider: string; id: string; thinkingLevel: string };
	generation: number;
	sessionFile?: string;
	pane?: { session: string; parent: string };
}

export interface RpcHostState {
	hostPid: number;
	generation?: number;
	hostStarted?: string;
	childPid?: number;
	/** The run's session; pi writes the file only once it holds a message. */
	sessionFile?: string;
	sessionId?: string;
	outcome?: PiSettlement;
	reportSeq?: number;
	exit?: { code: number | null; signal: string | null };
	idle?: true;
	notStarted?: string;
}

export type PaneChildState = Pick<RpcHostState, "sessionFile" | "sessionId" | "outcome" | "reportSeq" | "idle"> & {
	awaiting?: boolean;
};

export const PANE_ENDED = "its pane was ended";

const stderrPath = (runDir: string) => join(runDir, "rpc-child.stderr");
export const noteRunError = (runDir: string, text: string): void =>
	appendFileSync(stderrPath(runDir), `${text}\n`, { mode: 0o600 });
export const STOP_GRACE_MS = 10_000;
const APPROVAL_CHECK_MS = 50;
export const ORCHESTRATOR_ABSENT_AFTER_MS = 5000;
const DIALOGS = ["select", "confirm", "input", "editor"];
const HOST_FILE = fileURLToPath(import.meta.url);

export function prepareRpcHost(runDir: string, spec: RpcHostSpec): RunHostLaunch {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("BLUCLAWD_"),
		),
	);
	return { runDir, env, ...(spec.pane ? { pane: spec.pane.session } : {}) };
}

function piEntry(): string {
	const root =
		process.env.PI_PACKAGE_ROOT ??
		piPackageRoot(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	if (!root) throw new Error("pi's install was not found");
	const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: { pi?: unknown } };
	if (typeof bin?.pi !== "string") throw new Error(`${root} names no pi to start`);
	return join(root, bin.pi);
}

export function stopRpcHost(hostPid: number): void {
	try {
		process.kill(hostPid, "SIGTERM");
	} catch {}
}

const ENDPOINT_ENV = ["PI_SERVER_DIR", "TMUX", "TMUX_PANE"];

function childEnv(env: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
	const kept = Object.fromEntries(
		Object.entries(env).filter(([key]) => !key.startsWith("BLUCLAWD_") && !ENDPOINT_ENV.includes(key)),
	);
	return { ...kept, PI_CODING_AGENT_DIR: agentDir };
}

function paneChildEnv(
	launched: Record<string, string>,
	own: NodeJS.ProcessEnv,
	runDir: string,
	pane: NonNullable<RpcHostSpec["pane"]>,
	agentDir: string,
): NodeJS.ProcessEnv {
	const kept = Object.entries(own).filter(
		(entry): entry is [string, string] =>
			entry[1] !== undefined && (ENDPOINT_ENV.includes(entry[0]) || /^PI_\w*(DIR|ROOT)$/.test(entry[0])),
	);
	return {
		...childEnv(launched, agentDir),
		...Object.fromEntries(kept),
		PI_CODING_AGENT_DIR: agentDir,
		[RUN_PANE_ENV]: runDir,
		[RUN_HOST_ENV]: String(process.pid),
		[PANE_ENV]: pane.session,
		[PARENT_ENV]: pane.parent,
	};
}

type RpcRecord = { type: string; id?: string; [key: string]: unknown };

/** pi's RPC over the child's stdio: strict JSONL, split on LF only, as pi frames it. */
function connect(child: ChildProcess, onEvent: (event: RpcRecord) => void) {
	const pending = new Map<string, { resolve: (record: RpcRecord) => void; reject: (error: Error) => void }>();
	let nextId = 0;
	let buffer = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at).replace(/\r$/, "");
			buffer = buffer.slice(at + 1);
			if (!line) continue;
			let record: RpcRecord;
			try {
				record = JSON.parse(line) as RpcRecord;
			} catch {
				continue;
			}
			const waiter = record.type === "response" && record.id ? pending.get(record.id) : undefined;
			if (waiter && record.id) {
				pending.delete(record.id);
				waiter.resolve(record);
			} else onEvent(record);
		}
	});
	child.on("exit", () => {
		for (const waiter of pending.values()) waiter.reject(new Error("the run's pi exited"));
		pending.clear();
	});
	return (command: Record<string, unknown>): Promise<RpcRecord> =>
		new Promise((resolve, reject) => {
			const id = `host-${++nextId}`;
			pending.set(id, { resolve, reject });
			child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`);
		});
}

async function host(runDir: string): Promise<void> {
	const seat = claimGeneration(runDir);
	if (!seat) return;
	const { spec } = seat;
	if (spec.pane) return paneHost(runDir, seat, spec.pane);

	const child = spawn(process.execPath, [piEntry(), ...spec.args], {
		cwd: spec.cwd,
		env: childEnv(process.env, spec.agentDir),
		stdio: ["pipe", "pipe", openSync(stderrPath(runDir), "a", 0o600)],
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
		// A pi that could not be spawned never exits, so the reason goes where its stderr would have gone.
		child.on("error", (error) => {
			appendFileSync(stderrPath(runDir), `${error.message}\n`);
			resolve({ code: null, signal: null });
		});
	});
	seat.save({ childPid: child.pid });

	const approvals = new Map<string, number>();
	const answerDialog = (id: string, answer: RunApprovalAnswer | undefined) => {
		approvals.delete(id);
		child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id, ...dialogAnswer(answer) })}\n`);
	};
	const checkApprovals = () => {
		for (const [id, asked] of approvals) {
			const answer = runApprovalAnswer(runDir, spec.generation, id);
			if (answer) answerDialog(id, answer);
			else if (
				Date.now() - Math.max(asked, runApprovalSeenAt(runDir, spec.generation, id)) >
				ORCHESTRATOR_ABSENT_AFTER_MS
			) {
				withdrawRunApproval(runDir, spec.generation, id);
				answerDialog(id, "blocked");
			}
		}
	};
	const withdrawApprovals = () => {
		for (const id of approvals.keys()) withdrawRunApproval(runDir, spec.generation, id);
		approvals.clear();
	};
	const watching = setInterval(checkApprovals, APPROVAL_CHECK_MS);

	let reported: () => void = () => {};
	const stored = new Promise<void>((resolve) => {
		reported = resolve;
	});
	const work = startGeneration({
		runDir,
		spec,
		link: {
			/**
			 * A prompt steers pi at its next safe point when it works and starts it when it is idle, because a bare steer would
			 * wait on an idle pi for a prompt that never comes.
			 */
			give: async (text) => {
				const reply = await request({ type: "prompt", message: text, streamingBehavior: "steer" });
				return reply.success ? true : { refused: reply.error === undefined ? undefined : String(reply.error) };
			},
			quiet: async () => {
				const now = (await request({ type: "get_state" })).data as {
					isStreaming?: boolean;
					pendingMessageCount?: number;
				};
				return !now.isStreaming && !now.pendingMessageCount;
			},
			availableModels: async () =>
				((await request({ type: "get_available_models" })).data as { models?: { provider: string; id: string }[] })
					.models ?? [],
		},
		save: seat.save,
		ended: () => reported(),
	});

	let stopped = false;
	process.on("SIGTERM", () => {
		stopped = true;
		work.stop();
		withdrawApprovals();
		// pi ends its work in order on a SIGTERM, its shell commands included.
		child.kill("SIGTERM");
	});
	void exited.then((exit) =>
		work.end(
			stopped
				? { status: "stopped", error: "its work was stopped" }
				: {
						status: "failed",
						error: `its pi exited first (${exit.signal ?? `code ${exit.code}`}): ${stderrTail(runDir)}`,
					},
		),
	);

	const request = connect(child, (event) => {
		if (event.type === "message_end") work.messageEnded(event.message as Parameters<typeof work.messageEnded>[0]);
		if (event.type === "tool_execution_end")
			work.toolEnded({ toolName: event.toolName, isError: event.isError, result: event.result });
		if (event.type === "agent_settled") {
			if (event.aborted === true || stopped) work.end({ status: "stopped", error: "its work was stopped" });
			else void work.settled();
		}
		if (
			event.type === "extension_ui_request" &&
			typeof event.id === "string" &&
			DIALOGS.includes(String(event.method))
		) {
			const ask = event.method === "select" && !stopped ? runApprovalAsked(event.title) : undefined;
			if (ask && storeRunApprovalRequest(runDir, spec.generation, { id: event.id, ...ask })) {
				approvals.set(event.id, Date.now());
			} else answerDialog(event.id, undefined);
		}
	});
	request({ type: "get_state" }).then(
		(reply) => work.started(reply.data as StartedPi),
		() => {},
	);

	await stored;
	clearInterval(watching);
	withdrawApprovals();
	child.stdin?.end();
	seat.save({ exit: await exited });
}

async function paneHost(runDir: string, seat: HostSeat, pane: NonNullable<RpcHostSpec["pane"]>): Promise<void> {
	const { spec } = seat;
	// Ctrl+C reaches the pane's process group while its pi does not hold the terminal, so it is not the host's to act on.
	process.on("SIGINT", () => {});
	// Its pane ended from outside, as by tmux kill-session, hangs its process group up. The hang-up may reach the host
	// alone, its pane's session leader, so its pi is passed it.
	let paneEnded = false;
	let running: ChildProcess | undefined;
	process.on("SIGHUP", () => {
		paneEnded = true;
		running?.kill("SIGHUP");
		setTimeout(() => running?.kill("SIGKILL"), STOP_GRACE_MS).unref();
	});
	let launched: Record<string, string>;
	try {
		launched = await new OrchestratorClient().takeRunEnv(pane.session);
	} catch (error) {
		seat.save({
			notStarted: `the daemon restarted, or could not be reached, between launching the run's host and that host taking the run's environment (${error instanceof Error ? error.message : String(error)})`,
		});
		return;
	}
	if (paneEnded) {
		seat.save({ notStarted: `${PANE_ENDED} before its pi started` });
		return;
	}
	const saidBefore = stderrSize(runDir);
	const child = spawn(process.execPath, [piEntry(), ...spec.args], {
		cwd: spec.cwd,
		env: paneChildEnv(launched, process.env, runDir, pane, spec.agentDir),
		stdio: "inherit",
	});
	running = child;
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
		child.on("error", (error) => {
			appendFileSync(stderrPath(runDir), `${error.message}\n`);
			resolve({ code: null, signal: null });
		});
	});
	seat.save({ childPid: child.pid });
	let stopped = false;
	process.on("SIGTERM", () => {
		stopped = true;
		sealRunInbox(runDir, spec.generation);
		child.kill("SIGTERM");
	});
	const exit = await exited;
	const stored = seat.takeChild();
	let failed: Pick<RpcHostState, "outcome" | "reportSeq"> = {};
	if (stored.reportSeq === undefined && !stored.idle) {
		sealRunInbox(runDir, spec.generation);
		const outcome: PiSettlement = stopped
			? { status: "stopped", error: "its work was stopped" }
			: paneEnded
				? { status: "stopped", error: PANE_ENDED }
				: {
						status: "failed",
						error: `its pi exited before its work settled (${exit.signal ?? `code ${exit.code}`})${saidSince(runDir, saidBefore)}`,
					};
		failed = {
			outcome,
			reportSeq: storeRunReport(runDir, {
				text: "",
				outcome,
				sessionId: stored.sessionId,
				generation: spec.generation,
			}),
		};
	}
	seat.save({ ...failed, exit });
	const socket = process.env.TMUX?.split(",")[0];
	if (!socket) return;
	tryTmux(() =>
		new Tmux(dirname(socket), undefined, { timeoutMs: 2000 }).moveClients(
			pane.session,
			seat.paneParent() ?? pane.parent,
		),
	);
}

export const stderrSize = (runDir: string): number => {
	try {
		return statSync(stderrPath(runDir)).size;
	} catch {
		return 0;
	}
};

export function saidSince(runDir: string, from: number): string {
	try {
		const text = readFileSync(stderrPath(runDir)).subarray(from).toString("utf8").trim();
		return text ? `: ${text.split("\n").slice(-5).join("\n")}` : "";
	} catch {
		return "";
	}
}

function stderrTail(runDir: string): string {
	try {
		return readFileSync(stderrPath(runDir), "utf8").trim().split("\n").slice(-5).join("\n") || "no output";
	} catch {
		return "no output";
	}
}

/** Whether this module runs as the host. Node gives the entry by its real path, which an install may link to. */
function isEntry(): boolean {
	try {
		return realpathSync(process.argv[1] ?? "") === realpathSync(HOST_FILE);
	} catch {
		return false;
	}
}

if (isEntry()) {
	const runDir = process.argv[2];
	host(runDir).then(
		() => process.exit(0),
		(error: unknown) => {
			try {
				writeFileSync(join(runDir, "rpc-host.error"), String(error instanceof Error ? error.stack : error));
			} finally {
				process.exit(1);
			}
		},
	);
}
