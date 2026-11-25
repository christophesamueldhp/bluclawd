import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ErrorResponse,
	InstanceSummary,
	LiveSnapshot,
	PaneLaunch,
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
import { paneReportsOutcomes } from "./phone-control.ts";
import { remoteSessions } from "./sessions.ts";
import { launchUsable, type SessionSpec, startSession } from "./spawn.ts";
import { type PushResult, sendPush, type WebPushSubscription } from "./webpush.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");
const NOTIFY_INTERVAL_MS = 1000;
const PUSH_SUBJECT = "https://github.com/christophesamueldhp/bluclawd";
export const TMUX_TIMEOUT_MS = 2000;
const TERMINAL_REFRESH_MS = 1500;
const TERMINAL_STALE_MS = 5000;
const PROBE_REFRESH_MS = 1000;
const PROBE_STALE_MS = 5000;

function notifyPairingCodeExhausted(): void {
	if (process.platform !== "darwin") return;
	execFile(
		"/usr/bin/osascript",
		[
			"-e",
			'display notification "Too many incorrect attempts. Run /remote-control for a new pairing code." with title "bluclawd"',
		],
		() => {},
	);
}

function savedOrLeftForNextHeartbeat(save: () => void): boolean {
	try {
		save();
		return true;
	} catch {
		return false;
	}
}

function endUnlessEndedAlready(tmux: Tmux, pane: string): void {
	try {
		tmux.hangUpAsQuit(pane);
	} catch {}
}

function keepingTimerFromThrowing(tick: () => void): () => void {
	return () => {
		try {
			tick();
		} catch {}
	};
}

export interface RemoteControlDeps {
	listInstances(probe?: ListProbe): InstanceSummary[];
	probeForList?(): Promise<ListProbe>;
	send: RemoteDeps["send"];
	deleteInstance(sessionId: string): boolean;
	renameInstance: RemoteDeps["renameInstance"];
	claimStart: RemoteDeps["claimStart"];
	paneStarting: RemoteDeps["paneStarting"];
	startFailed: RemoteDeps["startFailed"];
	setPinned: RemoteDeps["setPinned"];
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
	private latestLaunch: PaneLaunch | undefined;
	private keptLaunch: PaneLaunch | undefined;
	private launchWritten: string | undefined;
	private readonly awaitingRegistration = new Map<string, ReturnType<typeof setTimeout>>();
	private server: RemoteServer | undefined;
	private terminalAnswer: { open: boolean; landedAt: number } | undefined;
	private askingTerminal = false;
	private serverPort: number | undefined;
	private listenError: string | undefined;
	private queue: Promise<void> = Promise.resolve();
	private notifyTimer: ReturnType<typeof setInterval> | undefined;
	private latestProbe: { landedAt: number; probe: ListProbe } | undefined;
	private probing = false;
	private notifier: Notifier | undefined;
	private readonly sendPush: (subscription: WebPushSubscription, payload: string) => Promise<PushResult>;
	private readonly reports = new Map<string, PaneReport>();
	private readonly delivery: PromptDelivery;

	constructor(deps: RemoteControlDeps) {
		this.deps = deps;
		this.delivery = deps.delivery;
		this.delivery.settledByPaneGoing = (rowId) => this.server?.status(rowId);
		this.store = deps.store ?? new RemoteStore();
		this.tmux = deps.tmux ?? new Tmux(undefined, undefined, { timeoutMs: TMUX_TIMEOUT_MS });
		this.sendPush =
			deps.sendPush ??
			((subscription, payload) => sendPush(subscription, payload, this.store.vapidKeys(), PUSH_SUBJECT));
		this.keptLaunch = this.store.load().launch;
		this.launchWritten = this.keptLaunch && JSON.stringify(this.keptLaunch);
	}

	noteLaunch(launch: PaneLaunch, chosen = false): void {
		this.latestLaunch = launch;
		if (this.keepsLaunch(launch, chosen)) this.keptLaunch = launch;
		if (this.server) this.saveLaunch();
	}

	private keepsLaunch(launch: PaneLaunch, chosen: boolean): boolean {
		if (chosen) return true;
		const alreadyKept = JSON.stringify(launch) === JSON.stringify(this.keptLaunch);
		return !alreadyKept && !launchUsable(this.keptLaunch);
	}

	private saveLaunch(): void {
		const launch = this.keptLaunch;
		const key = JSON.stringify(launch);
		if (!launch || key === this.launchWritten) return;
		if (savedOrLeftForNextHeartbeat(() => this.store.setLaunch(launch))) this.launchWritten = key;
	}

	private terminalOpen(): boolean {
		const age = this.terminalAnswer ? Date.now() - this.terminalAnswer.landedAt : Number.POSITIVE_INFINITY;
		if (!this.terminalAnswer || (!this.askingTerminal && age > TERMINAL_STALE_MS)) {
			this.terminalAnswer = { open: this.tmux.attached(), landedAt: Date.now() };
		} else if (this.shouldRefreshTerminal(age)) this.askTerminal();
		return this.terminalAnswer.open;
	}

	private shouldRefreshTerminal(age: number): boolean {
		return this.server !== undefined && !this.askingTerminal && age >= TERMINAL_REFRESH_MS;
	}

	private sameListener(listener: RemoteServer | undefined): boolean {
		return this.server === listener;
	}

	private askTerminal(): void {
		const listener = this.server;
		this.askingTerminal = true;
		this.tmux
			.attachedAsync()
			.then((open) => {
				if (this.sameListener(listener)) this.terminalAnswer = { open, landedAt: Date.now() };
			})
			.finally(() => {
				this.askingTerminal = false;
			});
	}

	registered(sessionId: string): void {
		clearTimeout(this.awaitingRegistration.get(sessionId));
		this.awaitingRegistration.delete(sessionId);
	}

	private startSession(spec: SessionSpec): string {
		const pane = startSession({ ...spec, tmux: this.tmux });
		this.endIfUnregisteredBy(pane, START_MS);
		return pane;
	}

	private endIfUnregisteredBy(pane: string, ms: number): void {
		const timer = setTimeout(() => {
			if (this.awaitingRegistration.delete(pane)) endUnlessEndedAlready(this.tmux, pane);
		}, ms);
		timer.unref();
		this.awaitingRegistration.set(pane, timer);
	}

	watched(sessionId: string): boolean {
		return this.server?.watching().has(sessionId) === true;
	}

	live(sessionId: string, live: LiveSnapshot | null, entryId?: string): void {
		this.server?.live(sessionId, live, entryId);
	}

	report(sessionId: string, report: PaneReport | undefined): void {
		if (!report) {
			this.reports.delete(sessionId);
			return;
		}
		if (report.outcomes) this.delivery.reported(sessionId, report.outcomes);
		this.forgetReportsOfUnlistedPanes(sessionId);
		this.reports.set(sessionId, report);
		this.server?.status(sessionId);
	}

	private forgetReportsOfUnlistedPanes(except: string): void {
		const listed = new Set(this.list().flatMap((i) => (i.external ? [i.id] : [])));
		for (const id of this.reports.keys()) if (id !== except && !listed.has(id)) this.reports.delete(id);
	}

	hasReport(sessionId: string): boolean {
		return this.reports.has(sessionId);
	}

	private list(): InstanceSummary[] {
		const age = this.latestProbe ? Date.now() - this.latestProbe.landedAt : Number.POSITIVE_INFINITY;
		const probe = this.probeToListWith(age);
		if (this.server && !this.probing && age >= PROBE_REFRESH_MS) this.refreshProbe();
		return this.deps.listInstances(probe);
	}

	private probeToListWith(age: number): ListProbe | undefined {
		return this.probing || age <= PROBE_STALE_MS ? this.latestProbe?.probe : undefined;
	}

	private refreshProbe(): void {
		const { probeForList } = this.deps;
		if (!probeForList) return;
		const listener = this.server;
		this.probing = true;
		probeForList()
			.then((probe) => {
				if (this.sameListener(listener)) this.latestProbe = { landedAt: Date.now(), probe };
			})
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
					notifyPairingCodeExhausted,
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
					answer: (id, waiting) => this.delivery.answer(id, waiting, paneReportsOutcomes(this.reports.get(id))),
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
			this.saveLaunch();
			this.notifyTimer = setInterval(
				keepingTimerFromThrowing(() => this.notify()),
				NOTIFY_INTERVAL_MS,
			);
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
		this.latestProbe = undefined;
		this.terminalAnswer = undefined;
		this.notifier = undefined;
		await server?.close();
	}

	private notify(): void {
		const devices = this.store.load().devices.filter((device) => device.push);
		if (devices.length === 0) {
			this.notifier = undefined;
			return;
		}
		this.notifier ??= new Notifier();
		const notifications = this.notifier.observe(remoteSessions(this.list()));
		const inForeground = notifications.length ? this.server?.devicesInForeground() : undefined;
		for (const notification of notifications) {
			const payload = JSON.stringify(notification);
			for (const { id, push } of devices) {
				if (inForeground?.has(id)) continue;
				this.sendPush(push!, payload)
					.then((result) => {
						if (result === "gone") this.forgetGoneSubscription(id, push!.endpoint);
					})
					.catch(() => undefined);
			}
		}
	}

	private forgetGoneSubscription(id: string, endpoint: string): void {
		const current = this.store.load().devices.find((device) => device.id === id)?.push;
		if (current?.endpoint === endpoint) this.store.setPush(id, undefined);
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
			case "revoke_all":
				this.store.revokeAll();
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
