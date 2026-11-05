import type { AgentActivity } from "../activity.ts";
import type { InstanceStatus } from "../types.ts";

export interface ListRequest {
	type: "list";
}

export interface StatusRequest {
	type: "status";
	instanceId: string;
}

/**
 * What a pane's pi says of its session with every heartbeat, carried whole into its row's record
 * and listed summary. Every field but `cwd` is optional: a pane from an older build sends fewer.
 * (The phone's status sheet is another report: PaneReport.)
 */
export interface PaneHeartbeat {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	label?: string;
	/** The tmux session its pi runs in. */
	pane?: string;
	detail?: string;
	turns?: number;
	createdAt?: string;
	/** When its session's last entry was written: once idle, when its last turn ended. */
	finishedAt?: string;
	/** The entry pi appends to next, when it is not the file's last entry (after a /tree). */
	leafId?: string;
	/** The dialog it waits on, while it does. */
	dialog?: PaneDialog;
	/** Its prompt holds unsent text. */
	draft?: boolean;
	/** A run's: the tmux session of the orchestrator that launched it. Agent view and the phone leave it out. */
	parent?: string;
}

/** Every PaneHeartbeat key: a field added to the type without one here fails the typecheck. */
const PANE_HEARTBEAT_KEYS = Object.keys({
	cwd: true,
	sessionId: true,
	sessionFile: true,
	label: true,
	pane: true,
	detail: true,
	turns: true,
	createdAt: true,
	finishedAt: true,
	leafId: true,
	dialog: true,
	draft: true,
	parent: true,
} satisfies Record<keyof PaneHeartbeat, true>) as (keyof PaneHeartbeat)[];

/** Only the heartbeat of a wider value (a register request's instance, a stored record): any other key is left. */
export function pickPaneHeartbeat(from: PaneHeartbeat): PaneHeartbeat {
	const picked: Partial<Record<keyof PaneHeartbeat, unknown>> = {};
	for (const key of PANE_HEARTBEAT_KEYS) if (from[key] !== undefined) picked[key] = from[key];
	return picked as PaneHeartbeat;
}

/** Register/heartbeat a pane's pi. `launch`: how to start another pi like this one, so the daemon
 *  can start panes. */
export interface RegisterRequest {
	type: "register";
	instance: PaneHeartbeat & { id: string; activity?: AgentActivity; launch?: PaneLaunch };
}

export interface PaneLaunch {
	command: string[];
}

/** A blocking dialog in a pane's pi: pi's prompt kind (select, confirm, input, editor) and its title. */
export interface PaneDialog {
	kind: string;
	title?: string;
}

/** An image a phone sends with a prompt, as pi takes it: base64 bytes and their type. */
export interface PaneImage {
	mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	data: string;
}

/** What another window asks a pane's pi to do; delivered with its next heartbeat. A phone's
 *  prompt or command carries the phone's `id`, which its PromptOutcome comes back by, and the
 *  `sessionFile` of the session it was sent to: a pane on another session refuses it. */
export type PaneMessage =
	| { type: "prompt"; text: string; images?: PaneImage[]; id?: string; sessionFile?: string }
	| { type: "abort" }
	| { type: "rename"; name: string }
	| { type: "set_model"; provider: string; id: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_trust"; trust: "always" | "ask" | "never" }
	/** A text-only prompt starting with "/": typed into the pane's prompt and submitted, as on the Mac. */
	| { type: "command"; text: string; id?: string; sessionFile?: string }
	/** Stop a background task, as /tasks' `x` does: the model is told. */
	| { type: "stop_task"; id: string }
	| SessionMessage;

/** A message from another session (a run, its orchestrator): the receiving session never takes it
 *  as its own user's input or approval. `from`: the sender's tmux session; `name`: its session's name.
 *  `report`: a run's last message of a turn, to its orchestrator. `message`: what one session
 *  sends another with subagent_message. `typed`: what the user typed in a run, as a note for its
 *  orchestrator. */
export interface SessionMessage {
	type: "session_message";
	kind: "report" | "message" | "typed";
	from: string;
	name?: string;
	text: string;
}

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

/** Why a pane's session ended, as pi's session_shutdown says. */
export type EndReason = "quit" | "reload" | "new" | "resume" | "fork";

/** The session ended for another one: a new session, a `/resume` of another file (a pane
 *  unregisters on that one only) or a fork. */
export function endedForAnother(reason: EndReason | undefined): boolean {
	return reason === "new" || reason === "resume" || reason === "fork";
}

export interface UnregisterRequest {
	type: "unregister";
	instanceId: string;
	/** Absent from a pane of an older build. */
	reason?: EndReason;
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
	/** pi's session id, so the phone can follow the session to this row. */
	sessionId?: string;
}

/** A window starting a pane: see ServerSupervisor.claimStart and paneStarting. */
export type StartRequest = { type: "start" } & StartSpec;

export type StartSpec = ResumeSpec | NewPaneSpec;

/** A pane about to be started on a session file. */
export interface ResumeSpec {
	cwd: string;
	label?: string;
	sessionFile: string;
}

/** A new session's pane, just started. */
export interface NewPaneSpec {
	cwd: string;
	label?: string;
	pane: string;
}

/** The pane a start was claimed for could not be started. */
export interface StartFailedRequest {
	type: "start_failed";
	instanceId: string;
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
	/** With null: the transcript entry the finished reply became. Absent: where is unknown (older panes). */
	entryId?: string;
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
	/** Separate usage ledger for background subagent runs not included in foreground toolResult entries. */
	backgroundSubagentUsage?: {
		runCount: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number | null;
	};
	/** What the pane could not do for the phone, only in the report sent right after; `at`: epoch ms. */
	notice?: { text: string; at: number };
	/** The slash commands its prompt runs: pi's built-in ones, then extension commands, prompt
	 *  templates and skills (`skill:name`). */
	commands?: PaneCommand[];
	/** Its running background tasks, as /tasks lists them: shells, monitors, then subagent runs, newest
	 *  first in each; at most 20. */
	tasks?: PaneTask[];
	/** Where the pane's pistatusline is (its render worker and settings), when it draws pi's footer:
	 *  the daemon renders its lines for the phone with it. */
	pistatusline?: { worker: string; config: string };
	/** What became of the phone's latest prompts, by their ids. On every report from a pane that
	 *  reports them, empty too, so its absence marks an older pane. */
	outcomes?: PromptOutcome[];
}

/** Why a pane did not hand a phone's prompt or command to pi: a turn runs, the Mac's prompt holds a
 *  draft or a dialog has the keyboard (commands only), pi is compacting, the pane is on another
 *  session than the one it was sent to (or left it for another before pi took it, as the daemon
 *  says), or tmux could not press Enter in the pane. */
export type RefusedReason = "busy" | "draft" | "dialog" | "compacting" | "session_changed" | "unreachable";

/** Why a prompt never reached pi's turn: its pane went (reaped or unregistered) with it still queued,
 *  in its inbox or in pi, or pi dropped it from its queue (`dequeued`: a stopped turn, the dequeue key,
 *  or its session reloading or switching).
 *  `daemon_restarted`: a daemon before a restart accepted it, as the daemon answers a phone that
 *  asks about it (delivery.ts) and an older phone judges from the daemon's replay. */
export type LostReason = "pane_gone" | "daemon_restarted" | "dequeued";

/** What became of a prompt a phone sent, by the phone's id: pi started a turn with it (`taken`),
 *  queued it behind the turn in progress (`queued`), or the pane refused it or it was lost, with
 *  why. `sent`: the daemon has it and no outcome yet, only from the daemon to the phone. */
export type PromptOutcome =
	| { id: string; outcome: "sent" | "taken" | "queued" }
	| { id: string; outcome: "refused"; reason: RefusedReason }
	| { id: string; outcome: "lost"; reason: LostReason };

/** A background task: a shell, a monitor or a subagent run, or the model's bash past 2s in the
 *  foreground (`foreground`). `outputFile`: where a shell or monitor writes its output. */
export interface PaneTask {
	id: string;
	kind: "shell" | "monitor" | "agent";
	label: string;
	/** Epoch ms. */
	startedAt: number;
	foreground?: boolean;
	outputFile?: string;
	status?: string;
	model?: string;
}

/** A slash command, without its "/". */
export interface PaneCommand {
	name: string;
	description?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
}

/**
 * pi's own commands a phone may run. As bluclawd's Remote Control runs only the commands whose
 * result is the conversation itself, these open no selector or screen on the Mac that the phone
 * cannot see, and rewrite nothing already sent (a sent message is only ever stopped from the phone).
 */
export const PHONE_BUILTIN_COMMANDS: ReadonlySet<string> = new Set(["compact", "new", "reload"]);

/** Whether a phone may run a command: one of those, or a prompt template or a skill, which only
 *  become a prompt. Never an extension's: it may open its own screen on the Mac. */
export function phoneMayRun(command: PaneCommand): boolean {
	if (command.source === "builtin") return PHONE_BUILTIN_COMMANDS.has(command.name);
	return command.source === "prompt" || command.source === "skill";
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
	start: StartRequest;
	start_failed: StartFailedRequest;
	remote: RemoteRequest;
	remote_live: RemoteLiveRequest;
	remote_report: RemoteReportRequest;
}

export type ServerRequest = RequestMap[keyof RequestMap];

/** A listed row: a pane's as of its last heartbeat, or a stored one's. */
export interface InstanceSummary extends PaneHeartbeat {
	id: string;
	status: InstanceStatus;
	activity?: AgentActivity;
	/** True for a pane's pi; a stored row has no process. */
	external?: boolean;
	lastSeenAt?: string;
	outcome?: "done" | "failed" | "stopped";
	pinned?: boolean;
	sortOrder?: number;
	/** A pane's pi: how many times it stopped working, which a turn too quick for a poll still adds to. */
	settled?: number;
	/** A pane's pi that stopped beating while tmux still has its pane: listed as it last beat. */
	silent?: true;
}

interface ResponseMeta {
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

interface ResponseBase extends ResponseMeta {
	ok: true;
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

/** The id of the row listed as starting. */
export interface StartResponse extends ResponseBase {
	type: "start_result";
	id: string;
}

export interface ShutdownResponse extends ResponseBase {
	type: "shutdown_result";
}

/** Reply to send / delete / rename / meta / save / start_failed / remote_live / remote_report. */
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

export interface ErrorResponse extends ResponseMeta {
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
	start: StartResponse;
	start_failed: AckResponse;
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
