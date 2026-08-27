import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { AgentActivity } from "../activity.ts";
import type { InstanceStatus } from "../types.ts";

export interface SpawnRequest {
	type: "spawn";
	cwd: string;
	label?: string;
	provider?: string;
	model?: string;
	/** Resume an existing session `.jsonl` instead of starting fresh (child gets `--session`). */
	sessionFile?: string;
}

export interface ListRequest {
	type: "list";
}

export interface StopRequest {
	type: "stop";
	instanceId: string;
}

export interface StatusRequest {
	type: "status";
	instanceId: string;
}

export interface RpcRequest {
	type: "rpc";
	instanceId: string;
	command: RpcCommand;
}

export interface RpcStreamRequest {
	type: "rpc_stream";
	instanceId: string;
}

/** Register/heartbeat an external (self-registered) session — one the daemon did not spawn. */
export interface RegisterRequest {
	type: "register";
	instance: {
		id: string;
		cwd: string;
		sessionId?: string;
		sessionFile?: string;
		label?: string;
		activity?: AgentActivity;
	};
}

export interface UnregisterRequest {
	type: "unregister";
	instanceId: string;
}

export interface RequestMap {
	spawn: SpawnRequest;
	list: ListRequest;
	stop: StopRequest;
	status: StatusRequest;
	rpc: RpcRequest;
	rpc_stream: RpcStreamRequest;
	register: RegisterRequest;
	unregister: UnregisterRequest;
}

export type ServerRequest = RequestMap[keyof RequestMap];

export interface InstanceSummary {
	id: string;
	status: InstanceStatus;
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	radiusPiId?: string;
	activity?: AgentActivity;
	/** True for a self-registered foreground session (not a daemon-spawned child). */
	external?: boolean;
}

export interface ResponseBase {
	ok: boolean;
	error?: string;
	/**
	 * Echoed on every response (IMPROVEMENT-PLAN.md §4.5/§5.3) so a client can detect it is
	 * talking to a stale — already-running, since-rebuilt — daemon. `version` is the daemon's
	 * package.json semver; `buildId` is the newest mtime across its own installed dist/ tree,
	 * because a local rebuild during development does not bump `version` but does change what
	 * code is on disk. A client compares `buildId` against what a FRESH spawn would report
	 * right now, not against its own version, since the two processes are different npm
	 * packages that need not share a release cadence.
	 */
	version?: string;
	buildId?: string;
}

export interface SpawnResponse extends ResponseBase {
	type: "spawn_result";
	instance?: InstanceSummary;
}

export interface ListResponse extends ResponseBase {
	type: "list_result";
	instances?: InstanceSummary[];
}

export interface StopResponse extends ResponseBase {
	type: "stop_result";
	instanceId?: string;
}

export interface StatusResponse extends ResponseBase {
	type: "status_result";
	instance?: InstanceSummary;
}

export interface RpcBridgeResponse extends ResponseBase {
	type: "rpc_result";
	response: RpcResponse;
}

export interface RpcReadyResponse extends ResponseBase {
	type: "rpc_ready";
	instance?: InstanceSummary;
}

export interface RegisterResponse extends ResponseBase {
	type: "register_result";
}

export interface UnregisterResponse extends ResponseBase {
	type: "unregister_result";
}

export interface ErrorResponse extends ResponseBase {
	type: "error";
	ok: false;
	error: string;
}

export interface ResponseMap {
	spawn: SpawnResponse;
	list: ListResponse;
	stop: StopResponse;
	status: StatusResponse;
	rpc: RpcBridgeResponse;
	rpc_stream: RpcReadyResponse;
	register: RegisterResponse;
	unregister: UnregisterResponse;
}

export type ServerResponse = ResponseMap[keyof ResponseMap] | ErrorResponse;
export type RpcClientMessage = RpcCommand | RpcExtensionUIResponse;
export type RpcServerMessage =
	| RpcReadyResponse
	| RpcResponse
	| AgentSessionEvent
	| RpcExtensionUIRequest
	| ErrorResponse;
export type ProtocolMessage = ServerRequest | ServerResponse | RpcClientMessage | RpcServerMessage;

export type ResponseFor<T extends ServerRequest> = T extends { type: infer K }
	? K extends keyof ResponseMap
		? ResponseMap[K] | ErrorResponse
		: ErrorResponse
	: ErrorResponse;

export function encodeMessage(message: ProtocolMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export function parseRequestLine(line: string): ServerRequest {
	const value = JSON.parse(line) as ServerRequest;
	return value;
}

export function parseResponseLine(line: string): ServerResponse {
	const value = JSON.parse(line) as ServerResponse;
	return value;
}
