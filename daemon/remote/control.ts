/**
 * Remote control's switch, owned by the daemon. The on/off state and the port live in
 * remote.json, so the listener comes back when the daemon restarts (e.g. for a changed build).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tmux } from "../../ext/agent-view/tmux.ts";
import type {
	ErrorResponse,
	InstanceSummary,
	LiveSnapshot,
	PaneLaunch,
	PaneMessage,
	PaneReport,
	RemoteRequest,
	RemoteResponse,
} from "../ipc/protocol.ts";
import { type RemoteServer, startRemoteServer } from "./http.ts";
import { Notifier } from "./notifier.ts";
import { RemoteStore } from "./pairing.ts";
import { remoteSessions } from "./sessions.ts";
import { type SessionSpec, startSession } from "./spawn.ts";
import { type PushResult, sendPush, type WebPushSubscription } from "./webpush.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");
const NOTIFY_INTERVAL_MS = 1000;
const PUSH_SUBJECT = "https://github.com/christophesamueldhp/bluclawd";
/** Each tmux command is a quick round-trip to the server: a hung one must not hold up the daemon. */
const TMUX_TIMEOUT_MS = 2000;
/** A pane the phone started that has not registered by then never will: it is ended, not left
 *  running unseen. Past the phone's own wait (START_TIMEOUT_MS in web/app.js). */
const START_TIMEOUT_MS = 90_000;

export interface RemoteControlDeps {
	listInstances(): InstanceSummary[];
	send(sessionId: string, message: PaneMessage): boolean;
	deleteInstance(sessionId: string): boolean;
	store?: RemoteStore;
	tmux?: Tmux;
	webDir?: string;
	sendPush?: (subscription: WebPushSubscription, payload: string) => Promise<PushResult>;
}

export class RemoteControl {
	readonly store: RemoteStore;
	private readonly deps: RemoteControlDeps;
	private readonly tmux: Tmux;
	/** The latest heartbeat's launch, and what remote.json holds (so a heartbeat does not read it). */
	private latestLaunch: PaneLaunch | undefined;
	private launchNoted: string | undefined;
	/** Panes started from the phone that have not registered yet, by tmux session name. */
	private readonly starting = new Map<string, { replaces?: string; timer: ReturnType<typeof setTimeout> }>();
	private server: RemoteServer | undefined;
	/** The configured port the running server was started for. */
	private serverPort: number | undefined;
	private listenError: string | undefined;
	/** Serialises apply and stop, so overlapping switches cannot start two servers. */
	private queue: Promise<void> = Promise.resolve();
	private notifyTimer: ReturnType<typeof setInterval> | undefined;
	/** Only while some device is subscribed, so a change nobody was subscribed for is never sent late. */
	private notifier: Notifier | undefined;
	private readonly sendPush: (subscription: WebPushSubscription, payload: string) => Promise<PushResult>;
	/** Each pane's latest report, kept while the listener is off so the phone has it once it is on. */
	private readonly reports = new Map<string, { report: PaneReport; key: string }>();

	constructor(deps: RemoteControlDeps) {
		this.deps = deps;
		this.store = deps.store ?? new RemoteStore();
		this.tmux = deps.tmux ?? new Tmux(undefined, undefined, { timeoutMs: TMUX_TIMEOUT_MS });
		this.sendPush =
			deps.sendPush ??
			((subscription, payload) => sendPush(subscription, payload, this.store.vapidKeys(), PUSH_SUBJECT));
	}

	/** Every heartbeat says how its pi was started; the latest one is kept, and in remote.json while on. */
	noteLaunch(launch: PaneLaunch): void {
		this.latestLaunch = launch;
		if (this.server) this.saveLaunch();
	}

	private saveLaunch(): void {
		const launch = this.latestLaunch;
		const key = JSON.stringify(launch);
		if (!launch || key === this.launchNoted) return;
		try {
			this.store.setLaunch(launch);
			this.launchNoted = key;
		} catch {
			// a heartbeat must not fail over remote.json; the next one retries
		}
	}

	/** A pane registered: one the phone started is up, and the stored row it resumes gives way to it. */
	registered(sessionId: string): void {
		const started = this.starting.get(sessionId);
		if (!started) return;
		clearTimeout(started.timer);
		this.starting.delete(sessionId);
		if (started.replaces) this.deps.deleteInstance(started.replaces);
	}

	private startSession(spec: SessionSpec, replaces?: string): string {
		const pane = startSession({ ...spec, tmux: this.tmux });
		const timer = setTimeout(() => {
			if (!this.starting.delete(pane)) return;
			try {
				this.tmux.end(pane);
			} catch {
				// it ended already; a throw from a timer would shut the daemon down
			}
		}, START_TIMEOUT_MS);
		timer.unref();
		this.starting.set(pane, { replaces, timer });
		return pane;
	}

	/** A phone has this session open, so its pane should stream its reply. */
	watched(sessionId: string): boolean {
		return this.server?.watching().has(sessionId) === true;
	}

	live(sessionId: string, live: LiveSnapshot | null): void {
		this.server?.live(sessionId, live);
	}

	/** A pane's latest report; undefined once it is gone. */
	report(sessionId: string, report: PaneReport | undefined): void {
		if (!report) {
			this.reports.delete(sessionId);
			return;
		}
		// A pane that dies without unregistering is only reaped from the list; its first report may
		// arrive before it is listed, so the sender's own is kept.
		const live = new Set(this.deps.listInstances().flatMap((i) => (i.external ? [i.id] : [])));
		for (const id of this.reports.keys()) if (id !== sessionId && !live.has(id)) this.reports.delete(id);
		const key = JSON.stringify(report);
		if (this.reports.get(sessionId)?.key === key) return;
		this.reports.set(sessionId, { report, key });
		this.server?.status(sessionId);
	}

	launch(): PaneLaunch | undefined {
		return this.latestLaunch ?? this.store.load().launch;
	}

	private run(step: () => Promise<void>): Promise<void> {
		const result = this.queue.then(step);
		this.queue = result.catch(() => undefined);
		return result;
	}

	/** Start or stop the listener to match remote.json. */
	apply(): Promise<void> {
		return this.run(() => this.applyNow());
	}

	private async applyNow(): Promise<void> {
		const state = this.store.load();
		if (this.server && (!state.enabled || this.serverPort !== state.port)) await this.stopNow();
		if (!state.enabled) {
			this.listenError = undefined;
			return;
		}
		if (this.server) return;
		try {
			this.server = await startRemoteServer(
				{
					store: this.store,
					listInstances: this.deps.listInstances,
					send: this.deps.send,
					launch: () => this.launch(),
					startSession: (spec, replaces) => this.startSession(spec, replaces),
					resuming: (id) => [...this.starting.values()].some((started) => started.replaces === id),
					report: (id) => this.reports.get(id)?.report,
					tmux: this.tmux,
					webDir: this.deps.webDir ?? WEB_DIR,
				},
				state.port,
			);
			this.serverPort = state.port;
			this.listenError = undefined;
			// The phone needs one as soon as it is on.
			this.launchNoted = state.launch ? JSON.stringify(state.launch) : undefined;
			this.saveLaunch();
			this.notifyTimer = setInterval(() => this.notify(), NOTIFY_INTERVAL_MS);
			this.notifyTimer.unref();
		} catch (error) {
			this.listenError = error instanceof Error ? error.message : String(error);
		}
	}

	stop(): Promise<void> {
		return this.run(() => this.stopNow());
	}

	private async stopNow(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.serverPort = undefined;
		clearInterval(this.notifyTimer);
		this.notifyTimer = undefined;
		this.notifier = undefined;
		await server?.close();
	}

	/** Pushes each session that stopped working to every subscribed device. */
	private notify(): void {
		// A throw from a timer reaches the daemon's uncaughtException handler, which shuts it down.
		try {
			const devices = this.store.load().devices.filter((device) => device.push);
			if (devices.length === 0) {
				this.notifier = undefined;
				return;
			}
			this.notifier ??= new Notifier();
			for (const notification of this.notifier.observe(remoteSessions(this.deps.listInstances()))) {
				const payload = JSON.stringify(notification);
				for (const { id, push } of devices) {
					this.sendPush(push!, payload)
						.then((result) => {
							// Only that subscription: the device may have subscribed again meanwhile.
							const current = this.store.load().devices.find((device) => device.id === id)?.push;
							if (result === "gone" && current?.endpoint === push!.endpoint) this.store.setPush(id, undefined);
						})
						.catch(() => undefined);
				}
			}
		} catch {
			// the next tick retries
		}
	}

	async handle(request: RemoteRequest): Promise<RemoteResponse | ErrorResponse> {
		switch (request.action) {
			case "on":
				this.store.setEnabled(true, request.port);
				await this.apply();
				return this.result(this.server ? this.store.createCode() : undefined);
			case "off":
				this.store.setEnabled(false);
				await this.apply();
				return this.result();
			case "pair":
				if (!this.server) {
					const why = this.listenError ? `: ${this.listenError}` : "";
					return { type: "error", ok: false, error: `remote control is not listening${why}` };
				}
				return this.result(this.store.createCode());
			case "revoke":
				if (!request.deviceId || !this.store.revoke(request.deviceId)) {
					return { type: "error", ok: false, error: `Unknown device: ${request.deviceId}` };
				}
				return this.result();
			default:
				return this.result();
		}
	}

	private result(code?: { code: string; expiresAt: number }): RemoteResponse {
		const state = this.store.load();
		return {
			type: "remote_result",
			ok: true,
			enabled: state.enabled,
			port: this.server?.port ?? state.port,
			listening: this.server !== undefined,
			...(this.listenError ? { listenError: this.listenError } : {}),
			...(code ?? {}),
			devices: state.devices.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
		};
	}
}
