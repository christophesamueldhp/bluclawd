import type { AgentActivity } from "./activity.ts";
import type {
	AckResponse,
	DeleteRequest,
	ErrorResponse,
	InstanceSummary,
	ListRequest,
	ListResponse,
	MetaRequest,
	RegisterRequest,
	RegisterResponse,
	RemoteLiveRequest,
	RemoteReportRequest,
	RemoteRequest,
	RemoteResponse,
	RenameRequest,
	SaveRequest,
	SendRequest,
	ServerRequest,
	ServerResponse,
	ShutdownRequest,
	ShutdownResponse,
	StartFailedRequest,
	StartRequest,
	StartResponse,
	StatusRequest,
	StatusResponse,
	UnregisterRequest,
	UnregisterResponse,
	WaitRequest,
	WaitResponse,
	WakeupsRequest,
} from "./ipc/protocol.ts";
import { pickPaneHeartbeat } from "./ipc/protocol.ts";
import type { RemoteControl } from "./remote/control.ts";
import type { ListProbe, ServerSupervisor } from "./supervisor.ts";
import type { InstanceRecord } from "./types.ts";
import type { WakeupKeeper } from "./wakeups.ts";

function toInstanceSummary(
	instance: InstanceRecord,
	activity?: AgentActivity,
	external?: boolean,
	settled?: number,
): InstanceSummary {
	const { id, status, createdAt, lastSeenAt, outcome, pinned, sortOrder } = instance;
	return {
		...pickPaneHeartbeat(instance),
		id,
		status,
		createdAt,
		lastSeenAt,
		outcome,
		pinned,
		sortOrder,
		activity,
		external,
		settled,
	};
}

/** Below the pane's 30 s request timeout, so a wait is answered rather than given up on. */
const WAIT_MS = 25_000;

/** Installed by serve.ts: the process's own graceful shutdown. Unset outside `serve` (tests). */
let shutdownHook: (() => void) | undefined;

export function setShutdownHook(hook: (() => void) | undefined): void {
	shutdownHook = hook;
}

/** Installed by serve.ts: remote control's switch. Unset outside `serve` (tests). */
let remoteControl: RemoteControl | undefined;

export function setRemoteControl(control: RemoteControl | undefined): void {
	remoteControl = control;
}

let wakeupKeeper: Pick<WakeupKeeper, "hold"> | undefined;

export function setWakeupKeeper(keeper: Pick<WakeupKeeper, "hold"> | undefined): void {
	wakeupKeeper = keeper;
}

/** Every row agent view lists: stored rows, then each pane's pi with its activity. With `probe`,
 *  tmux's answers come from it rather than from blocking calls. */
export function listSummaries(supervisor: ServerSupervisor, probe?: ListProbe): InstanceSummary[] {
	const stored = supervisor.listInstances(probe?.now, probe?.said).map((instance) => toInstanceSummary(instance));
	const external = supervisor
		.listExternalInstances(probe?.now, probe?.said)
		.map(({ record, activity, settled, silent }) => ({
			...toInstanceSummary(record, activity, true, settled),
			...(silent ? { silent } : {}),
		}));
	return [...stored, ...external];
}

/** Why a start was refused, as the window that asked shows it. */
const START_REFUSED = {
	starting: "it is already starting — try again in a moment",
	running: "it is already open in a pane",
} as const;

function unknownInstanceError(instanceId: string): ErrorResponse {
	return {
		type: "error",
		ok: false,
		error: `Unknown instance: ${instanceId}`,
	};
}

// Overhead types
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request: ListRequest,
): Promise<ListResponse | ErrorResponse>;
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request: StatusRequest,
): Promise<StatusResponse | ErrorResponse>;
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request: RegisterRequest,
): Promise<RegisterResponse | ErrorResponse>;
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request: WaitRequest,
): Promise<WaitResponse | ErrorResponse>;
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request: UnregisterRequest,
): Promise<UnregisterResponse | ErrorResponse>;
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request: ShutdownRequest,
): Promise<ShutdownResponse | ErrorResponse>;
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request: RemoteRequest,
): Promise<RemoteResponse | ErrorResponse>;
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request: StartRequest,
): Promise<StartResponse | ErrorResponse>;
export async function handleIpcRequest(
	supervisor: ServerSupervisor,
	request:
		| DeleteRequest
		| RenameRequest
		| MetaRequest
		| SaveRequest
		| SendRequest
		| StartFailedRequest
		| RemoteLiveRequest
		| RemoteReportRequest
		| WakeupsRequest,
): Promise<AckResponse | ErrorResponse>;
export async function handleIpcRequest(supervisor: ServerSupervisor, request: ServerRequest): Promise<ServerResponse>;
export async function handleIpcRequest(supervisor: ServerSupervisor, request: ServerRequest): Promise<ServerResponse> {
	switch (request.type) {
		case "list": {
			// tmux is asked first, without blocking: a heartbeat is not held up behind the list's probes.
			const probe = await supervisor.probeForList();
			return { type: "list_result", ok: true, instances: listSummaries(supervisor, probe) };
		}

		case "status": {
			const instance = supervisor.getInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}
			return {
				type: "status_result",
				ok: true,
				instance: toInstanceSummary(instance),
			};
		}

		case "register": {
			const now = new Date().toISOString();
			const { id, activity, launch } = request.instance;
			const heartbeat = pickPaneHeartbeat(request.instance);
			const record: InstanceRecord = {
				...heartbeat,
				id,
				status: "online",
				createdAt: heartbeat.createdAt ?? now,
				lastSeenAt: now,
			};
			if (launch) remoteControl?.noteLaunch(launch);
			supervisor.registerExternal(record, activity ?? "idle");
			// The phone started it by its pane's name, and knows it by its row's id.
			remoteControl?.registered(record.id);
			const row = supervisor.rowIdOf(record.id);
			const messages = supervisor.drainExternal(record.id);
			return {
				type: "register_result",
				ok: true,
				...(messages.length ? { messages } : {}),
				...(remoteControl?.watched(row) ? { watched: true } : {}),
				...(remoteControl && !remoteControl.hasReport(row) ? { wantReport: true } : {}),
			};
		}

		case "send": {
			return (await supervisor.sendExternal(request.instanceId, request.message))
				? { type: "ack", ok: true }
				: unknownInstanceError(request.instanceId);
		}

		case "wait": {
			const waiting = supervisor.waitExternal(request.instanceId, WAIT_MS);
			if (!waiting) return unknownInstanceError(request.instanceId);
			const outcome = await waiting;
			return {
				type: "wait_result",
				ok: true,
				...(outcome === "queued" ? { queued: true } : outcome === "superseded" ? { superseded: true } : {}),
			};
		}

		case "unregister": {
			const row = supervisor.rowIdOf(request.instanceId);
			supervisor.unregisterExternal(request.instanceId, request.reason);
			remoteControl?.live(row, null);
			remoteControl?.report(row, undefined);
			return { type: "unregister_result", ok: true };
		}

		case "wakeups": {
			wakeupKeeper?.hold(request.held);
			return { type: "ack", ok: true };
		}

		case "delete": {
			return supervisor.deleteInstance(request.instanceId)
				? { type: "ack", ok: true }
				: unknownInstanceError(request.instanceId);
		}

		case "rename": {
			const instance = supervisor.renameInstance(request.instanceId, request.name);
			return instance
				? { type: "ack", ok: true, instance: toInstanceSummary(instance) }
				: unknownInstanceError(request.instanceId);
		}

		case "meta": {
			const instance = supervisor.setInstanceMeta(request.instanceId, {
				pinned: request.pinned,
				sortOrder: request.sortOrder,
			});
			return instance
				? { type: "ack", ok: true, instance: toInstanceSummary(instance) }
				: unknownInstanceError(request.instanceId);
		}

		case "save": {
			const instance = supervisor.saveInstance({
				cwd: request.cwd,
				label: request.label,
				sessionFile: request.sessionFile,
				sessionId: request.sessionId,
				parent: request.parent,
			});
			return { type: "ack", ok: true, ...(instance ? { instance: toInstanceSummary(instance) } : {}) };
		}

		case "start": {
			if ("pane" in request) {
				supervisor.paneStarting(request);
				return { type: "start_result", ok: true, id: request.pane };
			}
			const claim = supervisor.claimStart(request);
			if (!claim.ok) return { type: "error", ok: false, error: START_REFUSED[claim.refused] };
			return { type: "start_result", ok: true, id: claim.id };
		}

		case "start_failed": {
			supervisor.startFailed(request.instanceId);
			return { type: "ack", ok: true };
		}

		case "remote": {
			if (!remoteControl)
				return { type: "error", ok: false, error: "remote control is not available in this process" };
			return remoteControl.handle(request);
		}

		case "remote_live": {
			remoteControl?.live(supervisor.rowIdOf(request.instanceId), request.live, request.entryId);
			return { type: "ack", ok: true };
		}

		case "remote_report": {
			remoteControl?.report(supervisor.rowIdOf(request.instanceId), request.report);
			return { type: "ack", ok: true };
		}

		case "shutdown": {
			if (!shutdownHook) return { type: "error", ok: false, error: "shutdown is not available in this process" };
			// Deferred so the reply is written before the socket server closes.
			const hook = shutdownHook;
			setTimeout(hook, 100);
			return { type: "shutdown_result", ok: true };
		}
	}
}
