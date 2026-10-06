import type { AgentActivity } from "../activity.ts";
import type { InstanceStatus } from "../types.ts";

export interface ListRequest {
	type: "list";
}

export interface StatusRequest {
	type: "status";
	instanceId: string;
}

/** Register/heartbeat a pane's pi. */
export interface RegisterRequest {
	type: "register";
	instance: {
		id: string;
		cwd: string;
		sessionId?: string;
		sessionFile?: string;
		label?: string;
		activity?: AgentActivity;
		pane?: string;
		detail?: string;
		turns?: number;
		createdAt?: string;
	};
}

/** What another window asks a pane's pi to do; delivered with its next heartbeat. */
export type PaneMessage = { type: "prompt"; text: string } | { type: "abort" } | { type: "rename"; name: string };

/** Queue a message for a self-registered session. */
export interface SendRequest {
	type: "send";
	instanceId: string;
	message: PaneMessage;
}

export interface UnregisterRequest {
	type: "unregister";
	instanceId: string;
}

/** Ask the daemon to exit so a client can start a fresh one (a stale build). */
export interface ShutdownRequest {
	type: "shutdown";
}

/** Remove a row. The session file stays on disk. */
export interface DeleteRequest {
	type: "delete";
	instanceId: string;
}

export interface RenameRequest {
	type: "rename";
	instanceId: string;
	name: string;
}

/** Agent-view-only fields: pin and manual order. */
export interface MetaRequest {
	type: "meta";
	instanceId: string;
	pinned?: boolean;
	sortOrder?: number;
}

/** Keep a session that left its window as a row, with no process: resumable from its .jsonl. */
export interface SaveRequest {
	type: "save";
	cwd: string;
	label?: string;
	sessionFile: string;
}

interface RequestMap {
	list: ListRequest;
	status: StatusRequest;
	register: RegisterRequest;
	unregister: UnregisterRequest;
	send: SendRequest;
	shutdown: ShutdownRequest;
	delete: DeleteRequest;
	rename: RenameRequest;
	meta: MetaRequest;
	save: SaveRequest;
}

export type ServerRequest = RequestMap[keyof RequestMap];

export interface InstanceSummary {
	id: string;
	status: InstanceStatus;
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	activity?: AgentActivity;
	/** True for a pane's pi; a stored row has no process. */
	external?: boolean;
	createdAt?: string;
	lastSeenAt?: string;
	detail?: string;
	outcome?: "done" | "failed" | "stopped";
	turns?: number;
	finishedAt?: string;
	pinned?: boolean;
	sortOrder?: number;
	pane?: string;
}

interface ResponseBase {
	ok: boolean;
	error?: string;
	/**
	 * Echoed on every response so a client can detect it is talking to a stale —
	 * already-running, since-changed — daemon. `version` is the daemon's package.json
	 * semver; `buildId` combines the newest mtime across its own daemon/ tree and the Pi installation path,
	 * because a local rebuild during development does not bump `version` but does change what
	 * code is on disk. A client compares `buildId` against what a FRESH spawn would report
	 * right now, not against its own version, since the two processes are different npm
	 * packages that need not share a release cadence.
	 */
	version?: string;
	buildId?: string;
}

export interface ListResponse extends ResponseBase {
	type: "list_result";
	instances?: InstanceSummary[];
}

export interface StatusResponse extends ResponseBase {
	type: "status_result";
	instance?: InstanceSummary;
}

export interface RegisterResponse extends ResponseBase {
	type: "register_result";
	/** Messages queued for it with `send`. */
	messages?: PaneMessage[];
}

export interface UnregisterResponse extends ResponseBase {
	type: "unregister_result";
}

export interface ShutdownResponse extends ResponseBase {
	type: "shutdown_result";
}

/** Reply to send / delete / rename / meta / save. */
export interface AckResponse extends ResponseBase {
	type: "ack";
	instance?: InstanceSummary;
}

export interface ErrorResponse extends ResponseBase {
	type: "error";
	ok: false;
	error: string;
}

interface ResponseMap {
	list: ListResponse;
	status: StatusResponse;
	register: RegisterResponse;
	send: AckResponse;
	unregister: UnregisterResponse;
	shutdown: ShutdownResponse;
	delete: AckResponse;
	rename: AckResponse;
	meta: AckResponse;
	save: AckResponse;
}

export type ServerResponse = ResponseMap[keyof ResponseMap] | ErrorResponse;
export type ProtocolMessage = ServerRequest | ServerResponse;

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
