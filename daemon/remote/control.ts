/**
 * Remote control's switch, owned by the daemon. The on/off state and the port live in
 * remote.json, so the listener comes back when the daemon restarts (e.g. for a changed build).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { type ListProbe, START_MS } from "../supervisor.ts";
import { Tmux } from "../tmux.ts";
import type { PromptDelivery } from "./delivery.ts";
import { type RemoteDeps, type RemoteServer, startRemoteServer } from "./http.ts";
import { Notifier } from "./notifier.ts";
import { RemoteStore } from "./pairing.ts";
import { remoteSessions } from "./sessions.ts";
import { launchUsable, type SessionSpec, startSession } from "./spawn.ts";
import { type PushResult, sendPush, type WebPushSubscription } from "./webpush.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");
const NOTIFY_INTERVAL_MS = 1000;
const PUSH_SUBJECT = "https://github.com/christophesamueldhp/bluclawd";
/** Each tmux command is a quick round-trip to the server: a hung one must not hold up the daemon. */
export const TMUX_TIMEOUT_MS = 2000;
/** How long whether a terminal shows pi is taken as known. */
const TERMINAL_CHECK_MS = 1500;
/** A list finding its probe landed longer ago than this asks tmux again; the phone's timers list every second. */
const PROBE_REFRESH_MS = 1000;
/** A probe landed longer ago than this, with none asked since, is too old to reap with: nothing listed
 *  meanwhile (the phone was away), so a list asks as an unprobed one does. */
const PROBE_KEPT_MS = 5000;

export interface RemoteControlDeps {
	/** Every row, with tmux's answers from `probe` where it has them. */
	listInstances(probe?: ListProbe): InstanceSummary[];
	/** tmux's answers for a list, asked without blocking: remote control lists with the latest. */
	probeForList?(): Promise<ListProbe>;
	send(sessionId: string, message: PaneMessage): boolean;
	deleteInstance(sessionId: string): boolean;
	renameInstance: RemoteDeps["renameInstance"];
	claimStart: RemoteDeps["claimStart"];
	paneStarting: RemoteDeps["paneStarting"];
	startFailed: RemoteDeps["startFailed"];
	setPinned: RemoteDeps["setPinned"];
	/** The supervisor's: where the phone's prompts are tracked, and what their panes report settles. */
	delivery: PromptDelivery;
	statusLine?: RemoteDeps["statusLine"];
	renderStatusline?: RemoteDeps["renderStatusline"];
	store?: RemoteStore;
	tmux?: Tmux;
	webDir?: string;
	sendPush?: (subscription: WebPushSubscription, payload: string) => Promise<PushResult>;
}

export class RemoteControl {
	readonly store: RemoteStore;
	private readonly deps: RemoteControlDeps;
	private readonly tmux: Tmux;
	/** The latest heartbeat's launch. */
	private latestLaunch: PaneLaunch | undefined;
	/** The launch kept: /remote-control's, else a heartbeat's while none usable was kept. Panes started
	 *  differently would otherwise rewrite remote.json on every heartbeat. */
	private keptLaunch: PaneLaunch | undefined;
	/** What remote.json holds, so a heartbeat does not read it. */
	private launchWritten: string | undefined;
	/** Panes started from the phone that have not registered yet, by tmux session name. */
	private readonly starting = new Map<string, ReturnType<typeof setTimeout>>();
	private server: RemoteServer | undefined;
	/** Whether a terminal shows pi, as last asked of tmux: the phone's stream asks every second. */
	private terminal: { open: boolean; at: number } | undefined;
	/** The configured port the running server was started for. */
	private serverPort: number | undefined;
	private listenError: string | undefined;
	/** Serialises apply and stop, so overlapping switches cannot start two servers. */
	private queue: Promise<void> = Promise.resolve();
	private notifyTimer: ReturnType<typeof setInterval> | undefined;
	/** The latest list probe, and when it landed: kept only while the listener is on. */
	private latest: { landedAt: number; probe: ListProbe } | undefined;
	private probing = false;
	/** Only while some device is subscribed, so a change nobody was subscribed for is never sent late. */
	private notifier: Notifier | undefined;
	private readonly sendPush: (subscription: WebPushSubscription, payload: string) => Promise<PushResult>;
	/** Each pane's latest report, kept while the listener is off so the phone has it once it is on. */
	private readonly reports = new Map<string, PaneReport>();
	/** What became of each prompt the phone sent with an id. */
	private readonly delivery: PromptDelivery;

	constructor(deps: RemoteControlDeps) {
		this.deps = deps;
		this.delivery = deps.delivery;
		// A pane that ended or fell silent settled some: a phone watching its session is told.
		this.delivery.changed = (rowId) => this.server?.status(rowId);
		this.store = deps.store ?? new RemoteStore();
		this.tmux = deps.tmux ?? new Tmux(undefined, undefined, { timeoutMs: TMUX_TIMEOUT_MS });
		this.sendPush =
			deps.sendPush ??
			((subscription, payload) => sendPush(subscription, payload, this.store.vapidKeys(), PUSH_SUBJECT));
		this.keptLaunch = this.store.load().launch;
		this.launchWritten = this.keptLaunch && JSON.stringify(this.keptLaunch);
	}

	/** Every heartbeat says how its pi was started, and so does /remote-control (`chosen`), whose
	 *  launch is always kept; the one kept is in remote.json while on. */
	noteLaunch(launch: PaneLaunch, chosen = false): void {
		this.latestLaunch = launch;
		const kept = JSON.stringify(launch) === JSON.stringify(this.keptLaunch);
		if (chosen || (!kept && !launchUsable(this.keptLaunch))) this.keptLaunch = launch;
		if (this.server) this.saveLaunch();
	}

	private saveLaunch(): void {
		const launch = this.keptLaunch;
		const key = JSON.stringify(launch);
		if (!launch || key === this.launchWritten) return;
		try {
			this.store.setLaunch(launch);
			this.launchWritten = key;
		} catch {
			// a heartbeat must not fail over remote.json; the next one retries
		}
	}

	private terminalOpen(): boolean {
		const now = Date.now();
		if (!this.terminal || now - this.terminal.at >= TERMINAL_CHECK_MS) {
			this.terminal = { open: this.tmux.attached(), at: now };
		}
		return this.terminal.open;
	}

	/** A pane registered: one the phone started is up. */
	registered(sessionId: string): void {
		clearTimeout(this.starting.get(sessionId));
		this.starting.delete(sessionId);
	}

	private startSession(spec: SessionSpec): string {
		const pane = startSession({ ...spec, tmux: this.tmux });
		// A pane the phone started that has not registered by START_MS never will (its row is no longer
		// listed as starting, past the phone's own wait): it is ended, not left running unseen.
		const timer = setTimeout(() => {
			if (!this.starting.delete(pane)) return;
			try {
				this.tmux.end(pane);
			} catch {
				// it ended already; a throw from a timer would shut the daemon down
			}
		}, START_MS);
		timer.unref();
		this.starting.set(pane, timer);
		return pane;
	}

	/** A phone has this session open, so its pane should stream its reply. */
	watched(sessionId: string): boolean {
		return this.server?.watching().has(sessionId) === true;
	}

	live(sessionId: string, live: LiveSnapshot | null, entryId?: string): void {
		this.server?.live(sessionId, live, entryId);
	}

	/** A pane's latest report; undefined once it is gone. Each one is signalled, unchanged too: the
	 *  phone's pickers go back to what the pane reports when a switch did nothing. */
	report(sessionId: string, report: PaneReport | undefined): void {
		if (!report) {
			this.reports.delete(sessionId);
			return;
		}
		if (report.outcomes) this.delivery.reported(sessionId, report.outcomes);
		// A pane that dies without unregistering is only reaped from the list; its first report may
		// arrive before it is listed, so the sender's own is kept.
		const live = new Set(this.list().flatMap((i) => (i.external ? [i.id] : [])));
		for (const id of this.reports.keys()) if (id !== sessionId && !live.has(id)) this.reports.delete(id);
		this.reports.set(sessionId, report);
		this.server?.status(sessionId);
	}

	hasReport(sessionId: string): boolean {
		return this.reports.has(sessionId);
	}

	/** Every row, reaped with tmux's answers kept fresh in the background while the listener is on, so
	 *  the phone's lists do not block the daemon on tmux. Rows themselves are never kept. */
	private list(): InstanceSummary[] {
		// While the next probe is out, a blocking call would ask the same tmux it waits on: the latest
		// is listed with, however long a blocking call held the daemon since it landed.
		const age = this.latest ? Date.now() - this.latest.landedAt : Number.POSITIVE_INFINITY;
		const kept = this.probing || age <= PROBE_KEPT_MS ? this.latest?.probe : undefined;
		if (this.server && !this.probing && age >= PROBE_REFRESH_MS) this.refreshProbe();
		return this.deps.listInstances(kept);
	}

	private refreshProbe(): void {
		const { probeForList } = this.deps;
		if (!probeForList) return;
		const server = this.server;
		this.probing = true;
		probeForList()
			.then((probe) => {
				// One asked before the listener went off or restarted is not kept.
				if (this.server === server) this.latest = { landedAt: Date.now(), probe };
			})
			// Unhandled, it would shut the daemon down; the next list asks again.
			.catch(() => undefined)
			.finally(() => {
				this.probing = false;
			});
	}

	launch(): PaneLaunch | undefined {
		return [this.keptLaunch, this.latestLaunch].find(launchUsable);
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
					listInstances: () => this.list(),
					send: this.deps.send,
					launch: () => this.launch(),
					startSession: (spec) => this.startSession(spec),
					claimStart: this.deps.claimStart,
					paneStarting: this.deps.paneStarting,
					startFailed: this.deps.startFailed,
					report: (id) => this.reports.get(id),
					outcomes: (id) => this.delivery.outcomes(id),
					lifetime: () => this.delivery.lifetime,
					// Whether its pane reports outcomes, as one from an older build does not, is in its latest report.
					answer: (id, waiting) =>
						this.delivery.answer(id, waiting, Array.isArray(this.reports.get(id)?.outcomes)),
					terminalOpen: () => this.terminalOpen(),
					renameInstance: this.deps.renameInstance,
					setPinned: this.deps.setPinned,
					deleteInstance: this.deps.deleteInstance,
					statusLine: this.deps.statusLine,
					renderStatusline: this.deps.renderStatusline,
					webDir: this.deps.webDir ?? WEB_DIR,
				},
				state.port,
			);
			this.serverPort = state.port;
			this.listenError = undefined;
			// The phone needs one as soon as it is on.
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
		this.latest = undefined;
		this.notifier = undefined;
		await server?.close();
	}

	/** Pushes each session that stopped working or needs input to every subscribed device that does
	 *  not have the app open, on any screen: that one shows it already. */
	private notify(): void {
		// A throw from a timer reaches the daemon's uncaughtException handler, which shuts it down.
		try {
			const devices = this.store.load().devices.filter((device) => device.push);
			if (devices.length === 0) {
				this.notifier = undefined;
				return;
			}
			this.notifier ??= new Notifier();
			const notifications = this.notifier.observe(remoteSessions(this.list()));
			const present = notifications.length ? this.server?.present() : undefined;
			for (const notification of notifications) {
				const payload = JSON.stringify(notification);
				for (const { id, push } of devices) {
					if (present?.has(id)) continue;
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
		const command = request.launch?.command;
		if (Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string")) {
			this.noteLaunch({ command }, true);
		}
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

	private result(code?: { code: string; secret: string; expiresAt: number }): RemoteResponse {
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
