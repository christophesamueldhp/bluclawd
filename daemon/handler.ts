import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { AgentActivity } from "./activity.ts";
import type {
	AckResponse,
	AnswerRequest,
	DeleteRequest,
	ErrorResponse,
	InstanceSummary,
	ListRequest,
	ListResponse,
	MetaRequest,
	RegisterRequest,
	RegisterResponse,
	RenameRequest,
	RpcBridgeResponse,
	RpcReadyResponse,
	RpcRequest,
	RpcStreamRequest,
	ServerRequest,
	ServerResponse,
	ShutdownRequest,
	ShutdownResponse,
	SpawnRequest,
	SpawnResponse,
	StatusRequest,
	StatusResponse,
	StopRequest,
	StopResponse,
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
		question: instance.question,
		turns: instance.turns,
		finishedAt: instance.finishedAt,
		pinned: instance.pinned,
		sortOrder: instance.sortOrder,
		needs: external ? undefined : supervisor.getPendingNeeds(instance.id),
		id: instance.id,
		status: instance.status,
		cwd: instance.cwd,
		label: instance.label,
		sessionId: instance.sessionId,
		sessionFile: instance.sessionFile,
		radiusPiId: instance.radiusPiId,
		activity,
		external,
	};
}

/** Installed by serve.ts: the process's own graceful shutdown. Unset outside `serve` (tests). */
let shutdownHook: (() => void) | undefined;

export function setShutdownHook(hook: (() => void) | undefined): void {
	shutdownHook = hook;
}

/** Why a shutdown is refused, or undefined when it is safe: the daemon's exit takes every
 *  spawned child with it, so it only goes when it owns nothing that is running. */
export function shutdownRefusal(liveCount: number): string | undefined {
	if (liveCount === 0) return undefined;
	return `${liveCount} running session${liveCount === 1 ? "" : "s"}`;
}

function unknownInstanceError(instanceId: string): ErrorResponse {
	return {
		type: "error",
		ok: false,
		error: `Unknown instance: ${instanceId}`,
	};
}

// Overhead types
export async function handleIpcRequest(request: SpawnRequest): Promise<SpawnResponse | ErrorResponse>;
export async function handleIpcRequest(request: ListRequest): Promise<ListResponse | ErrorResponse>;
export async function handleIpcRequest(request: StopRequest): Promise<StopResponse | ErrorResponse>;
export async function handleIpcRequest(request: StatusRequest): Promise<StatusResponse | ErrorResponse>;
export async function handleIpcRequest(request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse>;
export async function handleIpcRequest(request: RpcStreamRequest): Promise<RpcReadyResponse | ErrorResponse>;
export async function handleIpcRequest(request: RegisterRequest): Promise<RegisterResponse | ErrorResponse>;
export async function handleIpcRequest(request: UnregisterRequest): Promise<UnregisterResponse | ErrorResponse>;
export async function handleIpcRequest(request: ShutdownRequest): Promise<ShutdownResponse | ErrorResponse>;
export async function handleIpcRequest(
	request: DeleteRequest | RenameRequest | MetaRequest | AnswerRequest,
): Promise<AckResponse | ErrorResponse>;
export async function handleIpcRequest(request: ServerRequest): Promise<ServerResponse>;
export async function handleIpcRequest(request: ServerRequest): Promise<ServerResponse> {
	switch (request.type) {
		case "spawn": {
			const instance = await supervisor.spawnInstance({
				cwd: request.cwd,
				label: request.label,
				sessionFile: request.sessionFile,
				provider: request.provider,
				model: request.model,
			});
			return {
				type: "spawn_result",
				ok: true,
				instance: toInstanceSummary(instance),
			};
		}

		case "list": {
			const spawned = supervisor
				.listInstances()
				.map((instance) => toInstanceSummary(instance, supervisor.getActivity(instance.id)));
			const external = supervisor
				.listExternalInstances()
				.map(({ record, activity }) => toInstanceSummary(record, activity, true));
			return {
				type: "list_result",
				ok: true,
				instances: [...spawned, ...external],
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
				instance: toInstanceSummary(instance, supervisor.getActivity(instance.id)),
			};
		}

		case "stop": {
			const instance = await supervisor.stopInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}

			return {
				type: "stop_result",
				ok: true,
				instanceId: request.instanceId,
			};
		}

		case "rpc": {
			const response = await supervisor.handleRpc(request.instanceId, request.command);
			if (!response) {
				return unknownInstanceError(request.instanceId);
			}

			return {
				type: "rpc_result",
				ok: true,
				response,
			};
		}

		case "rpc_stream": {
			const instance = supervisor.getInstance(request.instanceId);
			if (!instance) {
				return unknownInstanceError(request.instanceId);
			}
			return {
				type: "rpc_ready",
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
				createdAt: now,
				lastSeenAt: now,
				label: request.instance.label,
				sessionId: request.instance.sessionId,
				sessionFile: request.instance.sessionFile,
			};
			supervisor.registerExternal(record, request.instance.activity ?? "idle");
			return { type: "register_result", ok: true };
		}

		case "unregister": {
			supervisor.unregisterExternal(request.instanceId);
			return { type: "unregister_result", ok: true };
		}

		case "delete": {
			const deleted = await supervisor.deleteInstance(request.instanceId);
			return deleted ? { type: "ack", ok: true } : unknownInstanceError(request.instanceId);
		}

		case "rename": {
			const instance = await supervisor.renameInstance(request.instanceId, request.name);
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

		case "answer": {
			return supervisor.answer(request.instanceId, request.response)
				? { type: "ack", ok: true }
				: { type: "error", ok: false, error: "that question was already answered" };
		}

		case "shutdown": {
			const refusal = shutdownRefusal(supervisor.listLiveInstances().length);
			if (refusal) return { type: "error", ok: false, error: refusal };
			if (!shutdownHook) return { type: "error", ok: false, error: "shutdown is not available in this process" };
			// Deferred so the reply is written before the socket server closes.
			const hook = shutdownHook;
			setTimeout(hook, 100);
			return { type: "shutdown_result", ok: true };
		}
	}
}

export function openRpcStream(
	instanceId: string,
	onResponse: (response: RpcResponse) => void,
	onSessionEvent: (event: AgentSessionEvent) => void,
	onUiRequest: (request: RpcExtensionUIRequest) => void,
):
	| {
			handleRequest(request: RpcCommand | RpcExtensionUIResponse): Promise<void>;
			close(): void;
	  }
	| undefined {
	const handle = supervisor.openRpcStream(instanceId, onSessionEvent, onUiRequest);
	if (!handle) {
		return undefined;
	}

	return {
		async handleRequest(request): Promise<void> {
			if (request.type === "extension_ui_response") {
				handle.handleUiResponse(request);
				return;
			}
			const response = await handle.handleRpc(request);
			onResponse(response);
		},
		close(): void {
			handle.close();
		},
	};
}
