import { randomUUID } from "node:crypto";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import {
	type ActivityState,
	type AgentActivity,
	INITIAL_ACTIVITY,
	isBlockingUiMethod,
	reduceActivity,
} from "./activity.ts";
import { radiusPresence } from "./radius.ts";
import { createRpcProcessInstance, type RpcProcessInstance } from "./rpc-process.ts";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.ts";
import type { InstanceRecord, InstanceStatus } from "./types.ts";

interface LiveInstanceResources {
	rpcProcess?: RpcProcessInstance;
	radiusPiId?: string;
	sessionId?: string;
}

interface LiveInstance {
	record: InstanceRecord;
	resources: LiveInstanceResources;
	subscribers: Set<AgentSessionEventListener>;
	activityState: ActivityState;
	pendingUiRequest?: RpcExtensionUIRequest;
	onUiRequest?: (request: RpcExtensionUIRequest) => void;
	unsubscribeEvents?: () => void;
	unsubscribeExit?: () => void;
}

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

// Only refresh persisted session metadata after commands that can plausibly change
// the instance identity/details we store in instances.json. Most RPCs mutate transient
// runtime state only, so forcing a follow-up get_state after every command is wasted IO.
//
// - new_session / switch_session / fork / clone can change sessionId/sessionFile
// - set_session_name changes a persisted session detail we may want reflected externally
// - prompt can materialize or advance persisted session state after the child processes it
const SESSION_METADATA_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set([
	"new_session",
	"switch_session",
	"fork",
	"clone",
	"set_session_name",
	"prompt",
]);

function shouldRefreshSessionMetadata(command: RpcCommand): boolean {
	return SESSION_METADATA_COMMANDS.has(command.type);
}

function isGetStateSuccess(
	response: RpcResponse,
): response is Extract<
	RpcResponse,
	{ success: true; command: "get_state"; data: { sessionId: string; sessionFile?: string } }
> {
	return response.success === true && response.command === "get_state" && "data" in response;
}

interface ExternalInstance {
	record: InstanceRecord;
	activity: AgentActivity;
	lastSeenAt: number;
}

/** External (self-registered) instances expire this long after their last heartbeat. */
const EXTERNAL_TTL_MS = 15_000;

export class ServerSupervisor {
	private readonly liveInstances = new Map<string, LiveInstance>();
	private readonly externalInstances = new Map<string, ExternalInstance>();

	private setStatus(live: LiveInstance, status: InstanceStatus): void {
		live.record = {
			...live.record,
			status,
			lastSeenAt: new Date().toISOString(),
		};
		upsertInstance(live.record);
	}

	private updateRecord(live: LiveInstance, updates: Partial<InstanceRecord>): void {
		live.record = {
			...live.record,
			...updates,
			lastSeenAt: new Date().toISOString(),
		};
		if (updates.radiusPiId !== undefined) {
			live.resources.radiusPiId = updates.radiusPiId;
		}
		if (updates.sessionId !== undefined) {
			live.resources.sessionId = updates.sessionId;
		}
		upsertInstance(live.record);
	}

	private clearBindings(live: LiveInstance): void {
		live.unsubscribeEvents?.();
		live.unsubscribeExit?.();
		live.unsubscribeEvents = undefined;
		live.unsubscribeExit = undefined;
		live.onUiRequest = undefined;
		// The child that owned any outstanding prompt is gone/being rebound — drop it so a viewer
		// attaching later isn't replayed a dead prompt (openRpcStream replays pendingUiRequest).
		live.pendingUiRequest = undefined;
		live.resources.rpcProcess?.setUiRequestHandler(undefined);
	}

	private bindRpcProcess(live: LiveInstance, rpcProcess: RpcProcessInstance): void {
		this.clearBindings(live);
		live.resources.rpcProcess = rpcProcess;
		live.unsubscribeEvents = rpcProcess.onEvent((event) => {
			live.activityState = reduceActivity(live.activityState, { kind: "agent_event", type: event.type });
			// The agent resumed/settled, so any prompt it was blocked on has been resolved (a blocked
			// agent emits neither). Clear it so it isn't replayed to a late-attaching viewer.
			if (live.pendingUiRequest && (event.type === "agent_settled" || event.type === "turn_start")) {
				live.pendingUiRequest = undefined;
			}
			// A throwing subscriber (e.g. socket.write to a just-closed viewer) runs on the child's
			// stdout stack — an unguarded throw here would crash the whole daemon. Isolate each one.
			for (const subscriber of live.subscribers) {
				try {
					subscriber(event);
				} catch (error) {
					console.error(`FleetView subscriber threw on ${event.type}: ${String(error)}`);
				}
			}
		});
		live.unsubscribeExit = rpcProcess.onExit((error) => {
			void this.handleUnexpectedRpcExit(live, error);
		});
		rpcProcess.setUiRequestHandler((request) => {
			if (isBlockingUiMethod(request.method)) {
				live.activityState = reduceActivity(live.activityState, {
					kind: "ui_request",
					method: request.method,
					id: request.id,
				});
				live.pendingUiRequest = request;
			}
			try {
				live.onUiRequest?.(request);
			} catch (error) {
				console.error(`FleetView ui-request handler threw: ${String(error)}`);
			}
		});
	}

	private async handleUnexpectedRpcExit(live: LiveInstance, _error?: Error): Promise<void> {
		if (this.liveInstances.get(live.record.id) !== live) {
			return;
		}
		if (live.record.status === "stopping" || live.record.status === "stopped") {
			return;
		}
		this.setStatus(live, "error");
		this.clearBindings(live);
		live.resources.rpcProcess = undefined;
		if (live.resources.radiusPiId) {
			try {
				await radiusPresence.disconnectPi(live.record);
				this.updateRecord(live, { radiusPiId: undefined });
			} catch (error) {
				console.error(`Failed to disconnect Radius Pi ${live.record.id}: ${String(error)}`);
			}
		}
		this.liveInstances.delete(live.record.id);
		// Don't leave an unstoppable "error" ghost in instances.json: it's no longer in
		// liveInstances (so stopInstance can't remove it) and would accumulate forever. The
		// session's .jsonl survives on disk, so it still appears in the resumable saved list.
		removeInstance(live.record.id);
	}

	private getRpcProcess(live: LiveInstance): RpcProcessInstance | undefined {
		return live.resources.rpcProcess;
	}

	private async syncInstanceRecord(live: LiveInstance): Promise<void> {
		const rpcProcess = this.getRpcProcess(live);
		if (!rpcProcess) {
			this.updateRecord(live, {});
			return;
		}
		const response = await rpcProcess.send({ type: "get_state" });
		if (!isGetStateSuccess(response)) {
			this.updateRecord(live, {});
			return;
		}
		this.updateRecord(live, {
			sessionId: response.data.sessionId,
			sessionFile: response.data.sessionFile,
		});
	}

	private async cleanupAcquiredResources(live: LiveInstance): Promise<void> {
		const rpcProcess = live.resources.rpcProcess;
		this.clearBindings(live);
		if (live.resources.radiusPiId) {
			await radiusPresence.disconnectPi(live.record);
			live.resources.radiusPiId = undefined;
			live.record = {
				...live.record,
				radiusPiId: undefined,
				lastSeenAt: new Date().toISOString(),
			};
		}
		live.resources.sessionId = undefined;
		if (rpcProcess) {
			live.resources.rpcProcess = undefined;
			await rpcProcess.dispose();
		}
	}

	private async failSpawn(live: LiveInstance, error: unknown): Promise<never> {
		this.setStatus(live, "error");
		try {
			await this.cleanupAcquiredResources(live);
		} finally {
			this.setStatus(live, "stopped");
			this.liveInstances.delete(live.record.id);
		}
		throw error;
	}

	updateInstance(instance: InstanceRecord): void {
		const live = this.liveInstances.get(instance.id);
		if (live) {
			live.record = instance;
			live.resources.radiusPiId = instance.radiusPiId;
			live.resources.sessionId = instance.sessionId;
		}
		upsertInstance(instance);
	}

	openRpcStream(
		instanceId: string,
		onEvent: (event: AgentSessionEvent) => void,
		onUiRequest: (request: RpcExtensionUIRequest) => void,
	):
		| {
				handleRpc(command: RpcCommand): Promise<RpcResponse>;
				handleUiResponse(response: RpcExtensionUIResponse): void;
				close(): void;
		  }
		| undefined {
		const live = this.liveInstances.get(instanceId);
		const rpcProcess = live ? this.getRpcProcess(live) : undefined;
		if (!live || !rpcProcess) {
			return undefined;
		}
		live.subscribers.add(onEvent);
		live.onUiRequest = onUiRequest;
		// Replay an already-outstanding prompt so a viewer attaching mid-block still sees it.
		if (live.pendingUiRequest) onUiRequest(live.pendingUiRequest);
		return {
			handleRpc: async (command) => {
				const response = await rpcProcess.send(command);
				if (shouldRefreshSessionMetadata(command)) {
					await this.syncInstanceRecord(live);
				}
				return response;
			},
			handleUiResponse: (response) => {
				live.activityState = reduceActivity(live.activityState, { kind: "ui_response", id: response.id });
				if (live.pendingUiRequest?.id === response.id) {
					live.pendingUiRequest = undefined;
				}
				rpcProcess.handleUiResponse(response);
			},
			close: () => {
				if (live.onUiRequest === onUiRequest) {
					live.onUiRequest = undefined;
				}
				live.subscribers.delete(onEvent);
			},
		};
	}

	getLiveInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		return live ? cloneInstance(live.record) : undefined;
	}

	getActivity(instanceId: string): AgentActivity | undefined {
		return (
			this.liveInstances.get(instanceId)?.activityState.activity ?? this.externalInstances.get(instanceId)?.activity
		);
	}

	/** Register/heartbeat an external (self-registered) instance the daemon does not own a process for. */
	registerExternal(record: InstanceRecord, activity: AgentActivity, now: number = Date.now()): void {
		this.externalInstances.set(record.id, { record: cloneInstance(record), activity, lastSeenAt: now });
	}

	unregisterExternal(id: string): void {
		this.externalInstances.delete(id);
	}

	/** External instances, reaping any whose last heartbeat is older than the TTL. */
	listExternalInstances(now: number = Date.now()): Array<{ record: InstanceRecord; activity: AgentActivity }> {
		const out: Array<{ record: InstanceRecord; activity: AgentActivity }> = [];
		for (const [id, entry] of this.externalInstances) {
			if (now - entry.lastSeenAt > EXTERNAL_TTL_MS) {
				this.externalInstances.delete(id);
				continue;
			}
			out.push({ record: cloneInstance(entry.record), activity: entry.activity });
		}
		return out;
	}

	listLiveInstances(): InstanceRecord[] {
		return [...this.liveInstances.values()].map((live) => cloneInstance(live.record));
	}

	async recoverAfterRestart(): Promise<void> {
		const recoveredAt = new Date().toISOString();
		const instances = loadInstances().map((instance) => ({
			...instance,
			status: instance.status === "online" || instance.status === "starting" ? "stopped" : instance.status,
			lastSeenAt: recoveredAt,
		}));
		for (const instance of instances) {
			await radiusPresence.disconnectPi(instance);
		}
		saveInstances(instances);
	}

	listInstances(): InstanceRecord[] {
		return loadInstances().map(cloneInstance);
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		if (live) {
			return cloneInstance(live.record);
		}
		const stored = getInstance(instanceId);
		return stored ? cloneInstance(stored) : undefined;
	}

	async spawnInstance(options: {
		cwd: string;
		label?: string;
		sessionFile?: string;
		provider?: string;
		model?: string;
	}): Promise<InstanceRecord> {
		const now = new Date().toISOString();
		const live: LiveInstance = {
			record: {
				id: randomUUID(),
				status: "starting",
				cwd: options.cwd,
				createdAt: now,
				lastSeenAt: now,
				label: options.label,
			},
			resources: {},
			subscribers: new Set(),
			activityState: INITIAL_ACTIVITY,
		};
		this.liveInstances.set(live.record.id, live);
		upsertInstance(live.record);

		try {
			// Spawned background sessions ask before running tools, so they can surface a
			// blocking prompt (FleetView "Needs input") that a live-attach viewer answers.
			const rpcProcess = createRpcProcessInstance({
				cwd: options.cwd,
				env: { ...process.env, PI_PERMISSION_MODE: "ask" },
				sessionFile: options.sessionFile,
				provider: options.provider,
				model: options.model,
			});
			this.bindRpcProcess(live, rpcProcess);
			await this.syncInstanceRecord(live);
			const registeredRecord = await radiusPresence.registerPi(live.record);
			this.updateRecord(live, { radiusPiId: registeredRecord.radiusPiId });
			this.setStatus(live, "online");
			return cloneInstance(live.record);
		} catch (error) {
			return await this.failSpawn(live, error);
		}
	}

	async stopInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}

		this.setStatus(live, "stopping");
		try {
			await this.cleanupAcquiredResources(live);
		} finally {
			live.record = {
				...live.record,
				status: "stopped",
				lastSeenAt: new Date().toISOString(),
			};
			this.liveInstances.delete(instanceId);
			removeInstance(instanceId);
		}
		return cloneInstance(live.record);
	}

	async handleRpc(instanceId: string, command: RpcCommand): Promise<RpcResponse | undefined> {
		const live = this.liveInstances.get(instanceId);
		const rpcProcess = live ? this.getRpcProcess(live) : undefined;
		if (!live || !rpcProcess) {
			return undefined;
		}

		const response = await rpcProcess.send(command);
		if (shouldRefreshSessionMetadata(command)) {
			await this.syncInstanceRecord(live);
		}
		return response;
	}

	async shutdown(): Promise<void> {
		for (const instanceId of [...this.liveInstances.keys()]) {
			await this.stopInstance(instanceId);
		}
	}
}

export const supervisor = new ServerSupervisor();

radiusPresence.setCoordinator({
	getLiveInstance(instanceId) {
		return supervisor.getLiveInstance(instanceId);
	},
	listLiveInstances() {
		return supervisor.listLiveInstances();
	},
	updateInstance(instance) {
		supervisor.updateInstance(instance);
	},
});
