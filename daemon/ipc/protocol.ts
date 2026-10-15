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
		/** The entry pi appends to next, when it is not the file's last entry (after a /tree). */
		leafId?: string;
		/** How to start another pi like this one, so the daemon can start panes. */
		launch?: PaneLaunch;
	};
}

export interface PaneLaunch {
	command: string[];
}

/** An image a phone sends with a prompt, as pi takes it: base64 bytes and their type. */
export interface PaneImage {
	mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	data: string;
}

/** What another window asks a pane's pi to do; delivered with its next heartbeat. */
export type PaneMessage =
	| { type: "prompt"; text: string; images?: PaneImage[] }
	| { type: "abort" }
	| { type: "rename"; name: string }
	| { type: "compact" }
	| { type: "set_model"; provider: string; id: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_trust"; trust: "always" | "ask" | "never" }
	| { type: "tree"; entryId: string }
	| { type: "fork"; entryId: string }
	| { type: "clone" };

/** Queue a message for a self-registered session. */
export interface SendRequest {
	type: "send";
	instanceId: string;
	message: PaneMessage;
}

/** Held open until a message is queued for the pane, or 25 s pass with none. */
export interface WaitRequest {
	type: "wait";
	instanceId: string;
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

/** The reply a pane is streaming, while a phone has its session open. */
export interface LiveSnapshot {
	text: string;
	thinking?: string;
	tools: Array<{ id: string; name: string; summary: string; running: boolean }>;
}

/** A pane's latest LiveSnapshot, or null once the reply is finished (or no phone watches it). */
export interface RemoteLiveRequest {
	type: "remote_live";
	instanceId: string;
	live: LiveSnapshot | null;
}

/** What the phone's status sheet shows of a pane. */
export interface PaneReport {
	model?: { provider: string; id: string; name?: string };
	/** The models it can switch to. */
	models: Array<{ provider: string; id: string; name?: string }>;
	thinkingLevel?: string;
	/** The levels pi offers for the current model, when it reasons. */
	thinkingLevels?: string[];
	/** pi's `defaultProjectTrust`, which Alt+M cycles. */
	trust?: "always" | "ask" | "never";
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

/** A pane's latest PaneReport, sent when it changes (session start, model, thinking level, turn end). */
export interface RemoteReportRequest {
	type: "remote_report";
	instanceId: string;
	report: PaneReport;
}

/** Remote control from a phone (daemon/remote/): its switch, pairing codes and paired devices. */
export interface RemoteRequest {
	type: "remote";
	action: "status" | "on" | "off" | "pair" | "devices" | "revoke";
	/** With `on`: the port to listen on (pi's `remote.port` setting). */
	port?: number;
	/** With `revoke`. */
	deviceId?: string;
	/** How the asking pi was started: a fresh pi has no heartbeat to say it yet. */
	launch?: PaneLaunch;
}

interface RequestMap {
	list: ListRequest;
	status: StatusRequest;
	register: RegisterRequest;
	unregister: UnregisterRequest;
	send: SendRequest;
	wait: WaitRequest;
	shutdown: ShutdownRequest;
	delete: DeleteRequest;
	rename: RenameRequest;
	meta: MetaRequest;
	save: SaveRequest;
	remote: RemoteRequest;
	remote_live: RemoteLiveRequest;
	remote_report: RemoteReportRequest;
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
	leafId?: string;
	/** A stored row a phone is resuming: its pane has not registered yet. */
	resuming?: boolean;
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
	/** A phone has this session open on its event stream. */
	watched?: boolean;
	/** The daemon has no report from this pane (it restarted since the last one): send one now. */
	wantReport?: boolean;
}

/** `queued`: a message waits for the pane, which registers to drain it (the wait carries none).
 *  `superseded`: a newer wait for the same id replaced this one; the pane waits again only after
 *  its next heartbeat. */
export interface WaitResponse extends ResponseBase {
	type: "wait_result";
	queued?: boolean;
	superseded?: boolean;
}

export interface UnregisterResponse extends ResponseBase {
	type: "unregister_result";
}

export interface ShutdownResponse extends ResponseBase {
	type: "shutdown_result";
}

/** Reply to send / delete / rename / meta / save / remote_live / remote_report. */
export interface AckResponse extends ResponseBase {
	type: "ack";
	instance?: InstanceSummary;
}

export interface RemoteDeviceInfo {
	id: string;
	name: string;
	createdAt: string;
	lastUsedAt?: string;
}

export interface RemoteResponse extends ResponseBase {
	type: "remote_result";
	enabled: boolean;
	/** The port bound while listening, else the configured one. */
	port: number;
	listening: boolean;
	/** Why the listener could not start (e.g. the port is in use). */
	listenError?: string;
	/** With `on` and `pair`: the QR code's pairing secret, the 6-digit code that also pairs, and
	 *  when both expire (epoch ms). */
	code?: string;
	secret?: string;
	expiresAt?: number;
	devices: RemoteDeviceInfo[];
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
	wait: WaitResponse;
	unregister: UnregisterResponse;
	shutdown: ShutdownResponse;
	delete: AckResponse;
	rename: AckResponse;
	meta: AckResponse;
	save: AckResponse;
	remote: RemoteResponse;
	remote_live: AckResponse;
	remote_report: AckResponse;
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
