import type { AgentActivity } from "./activity.ts";
import type { Collaborations } from "./collaborations.ts";
import type {
	CollaborationRequest,
	CollaborationResponse,
	ErrorResponse,
	InstanceSummary,
	PaneMessage,
	RequestMap,
	ResponseMap,
	ResponseTo,
	RunQueueRequest,
	ServerRequest,
} from "./ipc/protocol.ts";
import { HELD_REQUEST_TIMEOUT_MS, pickPaneHeartbeat } from "./ipc/protocol.ts";
import type { RemoteControl } from "./remote/control.ts";
import type { RunQueue } from "./run-queue.ts";
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

const WAIT_MS = HELD_REQUEST_TIMEOUT_MS - 5_000;
const SHUTDOWN_AFTER_REPLY_MS = 100;

export interface HandlerParts {
	shutdown?: () => void;
	remote?: RemoteControl;
	wakeups?: Pick<WakeupKeeper, "hold">;
	runQueue?: RunQueue;
	collaborations?: Collaborations;
}

type Daemon = HandlerParts & { supervisor: ServerSupervisor };

async function handleCollaboration(
	collaborations: Collaborations | undefined,
	request: CollaborationRequest,
): Promise<CollaborationResponse | ErrorResponse> {
	if (!collaborations) return { type: "error", ok: false, error: "collaborations are not kept in this process" };
	const result = (fields: Omit<CollaborationResponse, "type" | "ok">): CollaborationResponse => ({
		type: "collaboration_result",
		ok: true,
		...fields,
	});
	const { sessionId } = request;
	try {
		switch (request.action) {
			case "open":
				return result({
					collaboration: await collaborations.open({ sessionId, name: request.name }, request.with, request.scope),
				});
			case "scope":
				return result({ collaboration: await collaborations.rescope(sessionId, request.scope) });
			case "end":
				return result({ collaboration: await collaborations.end(sessionId) });
			case "leave":
				await collaborations.leave(sessionId);
				return result({});
			case "get":
				return result({ collaboration: collaborations.of(sessionId) });
			case "send":
				return result({
					to: await collaborations.send(sessionId, request.revision, request.to, request.kind, request.text),
				});
			case "current":
				return result({ current: collaborations.current(request.collaboration, request.revision, sessionId) });
		}
	} catch (error) {
		return { type: "error", ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

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

function isDaemonOnlyMessage(message: PaneMessage): boolean {
	return (
		message.type === "session_message" &&
		(message.kind === "collaboration" || message.kind === "collaborator_message")
	);
}

function unknownRunQueueAction(request: never): ErrorResponse {
	const { action } = request as RunQueueRequest;
	return { type: "error", ok: false, error: `unknown run_queue action ${JSON.stringify(action)}` };
}

type Answer<K extends keyof RequestMap> = ResponseMap[K] | ErrorResponse;

const handlers: {
	[K in keyof RequestMap]: (request: RequestMap[K], daemon: Daemon) => Answer<K> | Promise<Answer<K>>;
} = {
	list: async (_request, { supervisor }) => {
		const probe = await supervisor.probeForList();
		return { type: "list_result", ok: true, instances: listSummaries(supervisor, probe) };
	},

	status: (request, { supervisor }) => {
		const instance = supervisor.getInstance(request.instanceId);
		if (!instance) {
			return unknownInstanceError(request.instanceId);
		}
		return {
			type: "status_result",
			ok: true,
			instance: toInstanceSummary(instance),
		};
	},

	register: (request, { supervisor, remote }) => {
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
		if (launch) remote?.noteLaunch(launch);
		supervisor.registerExternal(record, activity ?? "idle");
		remote?.registered(record.id);
		const row = supervisor.rowIdOf(record.id);
		const messages = supervisor.drainExternal(record.id);
		return {
			type: "register_result",
			ok: true,
			...(messages.length ? { messages } : {}),
			...(remote?.watched(row) ? { watched: true } : {}),
			...(remote && !remote.hasReport(row) ? { wantReport: true } : {}),
		};
	},

	send: async (request, { supervisor }) => {
		const { message } = request;
		if (isDaemonOnlyMessage(message))
			return { type: "error", ok: false, error: "only the daemon sends collaboration messages" };
		return (await supervisor.sendExternal(request.instanceId, request.message))
			? { type: "ack", ok: true }
			: unknownInstanceError(request.instanceId);
	},

	wait: async (request, { supervisor }) => {
		const waiting = supervisor.waitExternal(request.instanceId, WAIT_MS);
		if (!waiting) return unknownInstanceError(request.instanceId);
		const outcome = await waiting;
		return {
			type: "wait_result",
			ok: true,
			...(outcome === "queued" ? { queued: true } : outcome === "superseded" ? { superseded: true } : {}),
		};
	},

	unregister: (request, { supervisor, remote }) => {
		const row = supervisor.rowIdOf(request.instanceId);
		supervisor.unregisterExternal(request.instanceId, request.reason);
		remote?.live(row, null);
		remote?.report(row, undefined);
		return { type: "unregister_result", ok: true };
	},

	wakeups: (request, { wakeups }) => {
		wakeups?.hold(request.held);
		return { type: "ack", ok: true };
	},

	run_queue: async (request, { runQueue }) => {
		if (!runQueue) return { type: "error", ok: false, error: "runs are not queued in this process" };
		switch (request.action) {
			case "claim": {
				const granted = await runQueue.claim(request.run, request.parent);
				return { type: "run_queue_result", ok: true, granted };
			}
			case "claim_now":
				return { type: "run_queue_result", ok: true, ...runQueue.claimNow(request.run, request.parent) };
			case "release":
				runQueue.release(request.run);
				return { type: "run_queue_result", ok: true };
			case "take_env": {
				const env = runQueue.takePaneEnv(request.pane);
				if (!env) return { type: "error", ok: false, error: `no run's environment waits for pane ${request.pane}` };
				return { type: "run_queue_result", ok: true, env };
			}
			case "launch":
				try {
					return { type: "run_queue_result", ok: true, hostPid: runQueue.launch(request.run, request.host) };
				} catch (error) {
					return { type: "error", ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			default:
				return unknownRunQueueAction(request);
		}
	},

	collaboration: (request, { collaborations }) => handleCollaboration(collaborations, request),

	delete: (request, { supervisor }) =>
		supervisor.deleteInstance(request.instanceId)
			? { type: "ack", ok: true }
			: unknownInstanceError(request.instanceId),

	rename: (request, { supervisor }) => {
		const instance = supervisor.renameInstance(request.instanceId, request.name);
		return instance
			? { type: "ack", ok: true, instance: toInstanceSummary(instance) }
			: unknownInstanceError(request.instanceId);
	},

	meta: (request, { supervisor }) => {
		const instance = supervisor.setInstanceMeta(request.instanceId, {
			pinned: request.pinned,
			sortOrder: request.sortOrder,
		});
		return instance
			? { type: "ack", ok: true, instance: toInstanceSummary(instance) }
			: unknownInstanceError(request.instanceId);
	},

	save: (request, { supervisor }) => {
		const instance = supervisor.saveInstance({
			cwd: request.cwd,
			label: request.label,
			sessionFile: request.sessionFile,
			sessionId: request.sessionId,
			parent: request.parent,
		});
		return { type: "ack", ok: true, ...(instance ? { instance: toInstanceSummary(instance) } : {}) };
	},

	start: (request, { supervisor }) => {
		if ("pane" in request) {
			supervisor.paneStarting(request);
			return { type: "start_result", ok: true, id: request.pane };
		}
		const claim = supervisor.claimStart(request);
		if (!claim.ok) return { type: "error", ok: false, error: START_REFUSED[claim.refused] };
		return { type: "start_result", ok: true, id: claim.id };
	},

	start_failed: (request, { supervisor }) => {
		supervisor.startFailed(request.instanceId);
		return { type: "ack", ok: true };
	},

	remote: (request, { remote }) => {
		if (!remote) return { type: "error", ok: false, error: "remote control is not available in this process" };
		return remote.handle(request);
	},

	remote_live: (request, { supervisor, remote }) => {
		remote?.live(supervisor.rowIdOf(request.instanceId), request.live, request.entryId);
		return { type: "ack", ok: true };
	},

	remote_report: (request, { supervisor, remote }) => {
		remote?.report(supervisor.rowIdOf(request.instanceId), request.report);
		return { type: "ack", ok: true };
	},

	shutdown: (_request, { shutdown }) => {
		if (!shutdown) return { type: "error", ok: false, error: "shutdown is not available in this process" };
		setTimeout(shutdown, SHUTDOWN_AFTER_REPLY_MS);
		return { type: "shutdown_result", ok: true };
	},
};

export async function handleIpcRequest<R extends ServerRequest>(
	supervisor: ServerSupervisor,
	request: R,
	parts: HandlerParts = {},
): Promise<ResponseTo<R> | ErrorResponse> {
	const handle = handlers[request.type] as (
		request: ServerRequest,
		daemon: Daemon,
	) => Answer<R["type"]> | Promise<Answer<R["type"]>>;
	return (await handle(request, { ...parts, supervisor })) as ResponseTo<R> | ErrorResponse;
}
