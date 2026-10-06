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
} from "./ipc/protocol.ts";
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
	};
}

/** Installed by serve.ts: the process's own graceful shutdown. Unset outside `serve` (tests). */
let shutdownHook: (() => void) | undefined;

export function setShutdownHook(hook: (() => void) | undefined): void {
	shutdownHook = hook;
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
export async function handleIpcRequest(request: UnregisterRequest): Promise<UnregisterResponse | ErrorResponse>;
export async function handleIpcRequest(request: ShutdownRequest): Promise<ShutdownResponse | ErrorResponse>;
export async function handleIpcRequest(
	request: DeleteRequest | RenameRequest | MetaRequest | SaveRequest | SendRequest,
): Promise<AckResponse | ErrorResponse>;
export async function handleIpcRequest(request: ServerRequest): Promise<ServerResponse>;
export async function handleIpcRequest(request: ServerRequest): Promise<ServerResponse> {
	switch (request.type) {
		case "list": {
			const stored = supervisor.listInstances().map((instance) => toInstanceSummary(instance));
			const external = supervisor
				.listExternalInstances()
				.map(({ record, activity }) => toInstanceSummary(record, activity, true));
			return {
				type: "list_result",
				ok: true,
				instances: [...stored, ...external],
			};
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
			};
			supervisor.registerExternal(record, request.instance.activity ?? "idle");
			const messages = supervisor.drainExternal(record.id);
			return { type: "register_result", ok: true, ...(messages.length ? { messages } : {}) };
		}

		case "send": {
			return supervisor.sendExternal(request.instanceId, request.message)
				? { type: "ack", ok: true }
				: unknownInstanceError(request.instanceId);
		}

		case "unregister": {
			supervisor.unregisterExternal(request.instanceId);
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

		case "shutdown": {
			if (!shutdownHook) return { type: "error", ok: false, error: "shutdown is not available in this process" };
			// Deferred so the reply is written before the socket server closes.
			const hook = shutdownHook;
			setTimeout(hook, 100);
			return { type: "shutdown_result", ok: true };
		}
	}
}
