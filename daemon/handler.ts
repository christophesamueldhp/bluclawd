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
	StatusRequest,
	StatusResponse,
	UnregisterRequest,
	UnregisterResponse,
	WaitRequest,
	WaitResponse,
} from "./ipc/protocol.ts";
import type { RemoteControl } from "./remote/control.ts";
import { supervisor } from "./supervisor.ts";
import type { InstanceRecord } from "./types.ts";

function toInstanceSummary(instance: InstanceRecord, activity?: AgentActivity, external?: boolean): InstanceSummary {
	return {
		createdAt: instance.createdAt,
		lastSeenAt: instance.lastSeenAt,
		detail: instance.detail,
		outcome: instance.outcome,
		turns: instance.turns,
		finishedAt: instance.finishedAt,
		pinned: instance.pinned,
		sortOrder: instance.sortOrder,
		id: instance.id,
		status: instance.status,
		cwd: instance.cwd,
		label: instance.label,
		sessionId: instance.sessionId,
		sessionFile: instance.sessionFile,
		activity,
		external,
		pane: instance.pane,
		leafId: instance.leafId,
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

/** Every row agent view lists: stored rows, then each pane's pi with its activity. */
export function listSummaries(): InstanceSummary[] {
	const stored = supervisor.listInstances().map((instance) => toInstanceSummary(instance));
	const external = supervisor
		.listExternalInstances()
		.map(({ record, activity }) => toInstanceSummary(record, activity, true));
	return [...stored, ...external];
}

function unknownInstanceError(instanceId: string): ErrorResponse {
	return {
		type: "error",
		ok: false,
		error: `Unknown instance: ${instanceId}`,
	};
}

// Overhead types
export async function handleIpcRequest(request: ListRequest): Promise<ListResponse | ErrorResponse>;
export async function handleIpcRequest(request: StatusRequest): Promise<StatusResponse | ErrorResponse>;
export async function handleIpcRequest(request: RegisterRequest): Promise<RegisterResponse | ErrorResponse>;
export async function handleIpcRequest(request: WaitRequest): Promise<WaitResponse | ErrorResponse>;
export async function handleIpcRequest(request: UnregisterRequest): Promise<UnregisterResponse | ErrorResponse>;
export async function handleIpcRequest(request: ShutdownRequest): Promise<ShutdownResponse | ErrorResponse>;
export async function handleIpcRequest(request: RemoteRequest): Promise<RemoteResponse | ErrorResponse>;
export async function handleIpcRequest(
	request:
		| DeleteRequest
		| RenameRequest
		| MetaRequest
		| SaveRequest
		| SendRequest
		| RemoteLiveRequest
		| RemoteReportRequest,
): Promise<AckResponse | ErrorResponse>;
export async function handleIpcRequest(request: ServerRequest): Promise<ServerResponse>;
export async function handleIpcRequest(request: ServerRequest): Promise<ServerResponse> {
	switch (request.type) {
		case "list": {
			return { type: "list_result", ok: true, instances: listSummaries() };
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
			const record: InstanceRecord = {
				id: request.instance.id,
				status: "online",
				cwd: request.instance.cwd,
				createdAt: request.instance.createdAt ?? now,
				lastSeenAt: now,
				label: request.instance.label,
				sessionId: request.instance.sessionId,
				sessionFile: request.instance.sessionFile,
				pane: request.instance.pane,
				detail: request.instance.detail,
				turns: request.instance.turns,
				leafId: request.instance.leafId,
			};
			if (request.instance.launch) remoteControl?.noteLaunch(request.instance.launch);
			supervisor.registerExternal(record, request.instance.activity ?? "idle");
			const messages = supervisor.drainExternal(record.id);
			return {
				type: "register_result",
				ok: true,
				...(messages.length ? { messages } : {}),
				...(remoteControl?.watched(record.id) ? { watched: true } : {}),
			};
		}

		case "send": {
			return supervisor.sendExternal(request.instanceId, request.message)
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
			supervisor.unregisterExternal(request.instanceId);
			remoteControl?.live(request.instanceId, null);
			remoteControl?.report(request.instanceId, undefined);
			return { type: "unregister_result", ok: true };
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
			});
			return { type: "ack", ok: true, instance: toInstanceSummary(instance) };
		}

		case "remote": {
			if (!remoteControl)
				return { type: "error", ok: false, error: "remote control is not available in this process" };
			return remoteControl.handle(request);
		}

		case "remote_live": {
			remoteControl?.live(request.instanceId, request.live);
			return { type: "ack", ok: true };
		}

		case "remote_report": {
			remoteControl?.report(request.instanceId, request.report);
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
