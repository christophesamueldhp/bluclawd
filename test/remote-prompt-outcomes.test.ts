import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest, listSummaries, setRemoteControl } from "../daemon/handler.ts";
import type { EndReason, PaneMessage, PromptOutcome, RefusedReason } from "../daemon/ipc/protocol.ts";
import { startIpcServer } from "../daemon/ipc/server.ts";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { RemoteControl } from "../daemon/remote/control.ts";
import { DELIVERY_KEEP_MS, PromptDelivery } from "../daemon/remote/delivery.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import { upsertInstance } from "../daemon/storage.ts";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import type { Tmux } from "../daemon/tmux.ts";
import { shutdownPlan } from "../ext/agent-view/index.ts";
import { SelfRegistration } from "../ext/agent-view/self-registration.ts";
import { refusal } from "../ext/remote/outcomes.ts";
import { waitFor } from "./helpers/wait-for.ts";

/**
 * A phone's prompt with its id, from the HTTP route through a real daemon socket to a pane's
 * registration and back as the outcome the phone reads in the session's status.
 */
describe("a prompt's outcome, back to the phone by its id", () => {
	let dir: string;
	let server: Server;
	let supervisor: ServerSupervisor;
	let control: RemoteControl;
	let base: string;
	let token: string;
	/** The registry's clock: moved on to reap a pane. */
	let clock: number;
	/** The tmux sessions tmux no longer has: a pane's pi there is gone. */
	let tmuxGone: Set<string>;
	const registrations: SelfRegistration[] = [];
	const streams: AbortController[] = [];

	/** The daemon's remote control on the test's registry, with its pairing in the test's dir. */
	function remoteControl(): RemoteControl {
		return new RemoteControl({
			store: new RemoteStore(join(dir, "remote.json")),
			listInstances: () => listSummaries(supervisor),
			send: (id, message) => supervisor.sendExternal(id, message),
			deleteInstance: () => false,
			renameInstance: () => false,
			setPinned: () => false,
			claimStart: () => ({ ok: false, refused: "running" }),
			paneStarting: () => {},
			startFailed: () => {},
			// A terminal shows pi, so the phone may prompt.
			tmux: { attached: () => true } as unknown as Tmux,
			webDir: dir,
		});
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-outcomes-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		clock = Date.now();
		tmuxGone = new Set();
		supervisor = new ServerSupervisor({ now: () => clock, tmux: { hasSession: (name) => !tmuxGone.has(name) }, dir });
		server = await startIpcServer((request) => handleIpcRequest(supervisor, request));
		control = remoteControl();
		setRemoteControl(control);
		supervisor.onDropped = (rowId, inbox, reason, pane) => control.dropped(rowId, inbox, reason, pane);
		supervisor.onSilent = (rowId, inbox) => control.silent(rowId, inbox);
		const on = await control.handle({ type: "remote", action: "on", port: 0 });
		if (on.type !== "remote_result" || !on.code) throw new Error("not listening");
		base = `http://127.0.0.1:${on.port}`;
		const paired = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: on.code, deviceName: "iPhone" }),
		});
		token = ((await paired.json()) as { token: string }).token;
	});

	afterEach(async () => {
		for (const stream of streams.splice(0)) stream.abort();
		await Promise.all(registrations.splice(0).map((r) => r.stop()));
		await control.stop();
		setRemoteControl(undefined);
		supervisor.settleWaits();
		await new Promise((resolve) => server.close(resolve));
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * A pane that reports outcomes, as a current one does: it refuses as a pane does (refusal()), else
	 * its first prompt starts a turn, and pi queues the ones after it behind that turn.
	 * `reports: false`: a pane from an older build. `refuse`: what its pi state makes it refuse.
	 * `sessionFile`: its session's, its own file by default.
	 */
	async function fakePane(
		id: string,
		options: {
			reports?: boolean;
			refuse?: RefusedReason;
			sessionFile?: string;
			client?: OrchestratorClient;
		} = {},
	) {
		const client = options.client ?? new OrchestratorClient();
		const reports = options.reports !== false;
		const sessionFile = options.sessionFile ?? join(dir, `${id}.jsonl`);
		const outcomes: PromptOutcome[] = [];
		const received: PaneMessage[] = [];
		let turn = false;
		const report = () => client.remoteReport(id, reports ? { models: [], outcomes: [...outcomes] } : { models: [] });
		const registration = new SelfRegistration(
			client,
			() => ({ cwd: dir, sessionFile }),
			(message) => {
				received.push(message);
				if (!reports || (message.type !== "prompt" && message.type !== "command") || !message.id) return;
				const reason = refusal(message, { compacting: false, sessionFile }) ?? options.refuse;
				if (reason) outcomes.push({ id: message.id, outcome: "refused", reason });
				else outcomes.push({ id: message.id, outcome: turn ? "queued" : "taken" });
				turn = true;
				void report();
			},
			id,
		);
		registrations.push(registration);
		registration.start();
		await waitFor(() => expect(supervisor.listExternalInstances().some((e) => e.record.id === id)).toBe(true));
		await report();
		/** pi dropped the prompts it had queued, as its pane reports once pi's run is over or its session ends. */
		const dequeue = () => {
			for (const [i, o] of outcomes.entries())
				if (o.outcome === "queued") outcomes[i] = { id: o.id, outcome: "lost", reason: "dequeued" };
			return report();
		};
		return { received, registration, dequeue };
	}

	/** A client whose register, once held, keeps a reply that delivers messages until released: the
	 *  pane is still delivering them. */
	class HoldingClient extends OrchestratorClient {
		private gate: Promise<void> | undefined;
		private open = () => {};
		holding = false;
		hold(): void {
			this.gate = new Promise((resolve) => {
				this.open = resolve;
			});
		}
		release(): void {
			this.open();
		}
		override async register(instance: Parameters<OrchestratorClient["register"]>[0]) {
			const res = await super.register(instance);
			if (this.gate && res.messages.length) {
				this.holding = true;
				await this.gate;
			}
			return res;
		}
	}

	/** A pane that registered once and beats no more, so what is sent to it stays in its inbox. */
	async function stillPane(id: string) {
		const client = new OrchestratorClient();
		await client.register({ id, cwd: dir, sessionFile: join(dir, `${id}.jsonl`) });
		await client.remoteReport(id, { models: [], outcomes: [] });
		return { unregister: () => client.unregister(id) };
	}

	/** The phone's event stream with `session` open: `until` resolves once an outcome came on it. */
	async function watch(session: string) {
		const controller = new AbortController();
		streams.push(controller);
		const res = await fetch(`${base}/api/events?token=${token}&session=${session}`, { signal: controller.signal });
		const reader = res.body!.getReader();
		let received = "";
		const until = async (needle: string) => {
			while (!received.includes(needle)) {
				const { done, value } = await reader.read();
				if (done) throw new Error(`stream ended without ${needle}`);
				received += new TextDecoder().decode(value);
			}
		};
		await until(": connected");
		return {
			until: (outcome: PromptOutcome) => until(JSON.stringify(outcome)),
			/** Every outcome it was sent so far, in order. */
			seen: () =>
				received
					.split("\n")
					.filter((l) => l.startsWith("data:") && l.includes('"outcomes"'))
					.flatMap((l) => (JSON.parse(l.slice(5)) as { outcomes: PromptOutcome[] }).outcomes),
			/** What the stream replayed as it opened: every outcome its daemon knows for the session. */
			replayed: async () => {
				await until("event: outcomes");
				const line = received.split("\n").find((l) => l.startsWith("data:") && l.includes('"outcomes"'));
				return (JSON.parse(line!.slice(5)) as { outcomes: PromptOutcome[] }).outcomes;
			},
		};
	}

	async function prompt(session: string, body: object): Promise<number> {
		const res = await fetch(`${base}/api/sessions/${session}/prompt`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return res.status;
	}

	async function status(session: string): Promise<{ outcomes?: PromptOutcome[] }> {
		const res = await fetch(`${base}/api/sessions/${session}/status`, {
			headers: { authorization: `Bearer ${token}` },
		});
		return ((await res.json()) as { report: { outcomes?: PromptOutcome[] } }).report;
	}

	it("is taken when pi starts a turn with it, and queued when sent during that turn", async () => {
		await fakePane("pane-turn");
		expect(await status("pane-turn")).toMatchObject({ outcomes: [] });
		expect(await prompt("pane-turn", { text: "first", id: "p-1" })).toBe(202);
		await waitFor(async () => expect((await status("pane-turn")).outcomes).toHaveLength(1));
		expect(await prompt("pane-turn", { text: "second", id: "p-2" })).toBe(202);
		await waitFor(async () =>
			expect((await status("pane-turn")).outcomes).toEqual([
				{ id: "p-1", outcome: "taken" },
				{ id: "p-2", outcome: "queued" },
			]),
		);
	});

	it("tracks two identical prompts separately", async () => {
		await fakePane("pane-twice");
		expect(await prompt("pane-twice", { text: "again", id: "p-a" })).toBe(202);
		expect(await prompt("pane-twice", { text: "again", id: "p-b" })).toBe(202);
		await waitFor(async () =>
			expect((await status("pane-twice")).outcomes).toEqual([
				{ id: "p-a", outcome: "taken" },
				{ id: "p-b", outcome: "queued" },
			]),
		);
	});

	it("shows no outcomes for a pane from an older build, which the phone keeps guessing for", async () => {
		const { received } = await fakePane("pane-old", { reports: false });
		expect(await prompt("pane-old", { text: "hi", id: "p-old" })).toBe(202);
		await waitFor(() =>
			expect(received).toEqual([
				{ type: "prompt", text: "hi", id: "p-old", sessionFile: join(dir, "pane-old.jsonl") },
			]),
		);
		expect(await status("pane-old")).not.toHaveProperty("outcomes");
	});

	it.each<RefusedReason>(["busy", "draft", "dialog", "compacting", "unreachable"])(
		"is refused, saying why, when its pane refuses it: %s",
		async (reason) => {
			await fakePane("pane-refuses", { refuse: reason });
			const phone = await watch("pane-refuses");
			// A slash command the pane does not list goes no further than the daemon, so a prompt.
			expect(await prompt("pane-refuses", { text: "hi", id: `p-${reason}` })).toBe(202);
			await phone.until({ id: `p-${reason}`, outcome: "refused", reason });
			expect((await status("pane-refuses")).outcomes).toEqual([{ id: `p-${reason}`, outcome: "refused", reason }]);
		},
	);

	const taken: PromptOutcome = { id: "p-move", outcome: "taken" };
	const changed: PromptOutcome = { id: "p-move", outcome: "refused", reason: "session_changed" };
	const gone: PromptOutcome = { id: "p-move", outcome: "lost", reason: "pane_gone" };
	it.each([
		["a reload", { reason: "reload" }, "same", taken],
		["a /resume of the same file", { reason: "resume", target: "same" }, "same", taken],
		["a new session", { reason: "new" }, "other", changed],
		["a /resume of another file", { reason: "resume", target: "other" }, "other", changed],
		// A fork has a row of its own: what was sent to the session it was forked from is not its.
		["a fork", { reason: "fork" }, "other", changed],
		["a quit", { reason: "quit" }, undefined, gone],
	] as const)(
		"ends, once its session ended while its pane delivered it, as the pane's session_shutdown makes it: %s",
		async (_, end, next, outcome) => {
			const file = join(dir, "pane-move.jsonl");
			const other = join(dir, "other.jsonl");
			const client = new HoldingClient();
			const { registration } = await fakePane("pane-move", { client, sessionFile: file });
			const phone = await watch("pane-move");
			client.hold();
			expect(await prompt("pane-move", { text: "hi", id: "p-move" })).toBe(202);
			await waitFor(() => expect(client.holding).toBe(true));
			// The session ends with the prompt on its way to it.
			const targetSessionFile = "target" in end ? (end.target === "same" ? file : other) : undefined;
			const plan = shutdownPlan({ reason: end.reason, targetSessionFile }, file);
			const stopping = registration.stop({ unregister: plan.unregister, reason: end.reason });
			client.release();
			await stopping;
			// The pane's next session registers as the same pane.
			if (next) await fakePane("pane-move", { sessionFile: next === "same" ? file : other });
			await phone.until(outcome);
		},
	);

	it("is known to a stream that reconnects, and to none a restarted daemon serves: the phone judges it lost", async () => {
		await stillPane("pane-restart");
		expect(await prompt("pane-restart", { text: "hi", id: "p-restart" })).toBe(202);
		expect(await (await watch("pane-restart")).replayed()).toEqual([{ id: "p-restart", outcome: "sent" }]);
		// A new daemon: remote control starts afresh, with the same pairing.
		await control.stop();
		control = remoteControl();
		setRemoteControl(control);
		const on = await control.handle({ type: "remote", action: "on", port: 0 });
		if (on.type !== "remote_result") throw new Error("not listening");
		base = `http://127.0.0.1:${on.port}`;
		expect(await (await watch("pane-restart")).replayed()).toEqual([]);
	});

	it("is lost when its pane unregisters with it still queued", async () => {
		const pane = await stillPane("pane-quit");
		const phone = await watch("pane-quit");
		expect(await prompt("pane-quit", { text: "hi", id: "p-quit" })).toBe(202);
		await pane.unregister();
		await phone.until({ id: "p-quit", outcome: "lost", reason: "pane_gone" });
	});

	it("is lost when its pane is reaped with it still queued", async () => {
		await stillPane("pane-reaped");
		const phone = await watch("pane-reaped");
		expect(await prompt("pane-reaped", { text: "hi", id: "p-reaped" })).toBe(202);
		// No heartbeat for longer than the registry waits: the stream's next look at the list reaps it.
		clock += 60_000;
		await phone.until({ id: "p-reaped", outcome: "lost", reason: "pane_gone" });
	});

	it.each([
		["unregisters", (registration: SelfRegistration) => registration.stop({ reason: "quit" })],
		[
			"is reaped",
			async (registration: SelfRegistration) => {
				// It beats no more, as a pi that crashed: the stream's next look at the list reaps it.
				await registration.stop({ unregister: false });
				clock += 60_000;
			},
		],
	] as const)("is lost when its pane %s with it queued in pi", async (_, ends) => {
		const { registration } = await fakePane("pane-queued");
		const phone = await watch("pane-queued");
		expect(await prompt("pane-queued", { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt("pane-queued", { text: "second", id: "p-second" })).toBe(202);
		await phone.until({ id: "p-second", outcome: "queued" });
		await ends(registration);
		await phone.until({ id: "p-second", outcome: "lost", reason: "pane_gone" });
		expect(await (await watch("pane-queued")).replayed()).toEqual([
			{ id: "p-first", outcome: "taken" },
			{ id: "p-second", outcome: "lost", reason: "pane_gone" },
		]);
	});

	/**
	 * A pane in its tmux session `id` that beats only when told, listed as its session's stored row
	 * `row-<id>`, as a pane the phone started is. `deliver`: a beat that delivers the prompts sent,
	 * which it reports, the first taken and the ones after it queued.
	 */
	async function tmuxPane(id: string, options: { started?: boolean } = {}) {
		const client = new OrchestratorClient();
		const sessionFile = join(dir, `${id}.jsonl`);
		let row = `row-${id}`;
		if (options.started) {
			// A start claimed its row, and pi has not written its session's file yet.
			const claim = supervisor.claimStart({ cwd: dir, sessionFile });
			if (!claim.ok) throw new Error("not claimed");
			row = claim.id;
		} else {
			upsertInstance(dir, {
				id: row,
				status: "stopped",
				cwd: dir,
				createdAt: new Date(clock).toISOString(),
				sessionFile,
			});
		}
		const beat = () => client.register({ id, cwd: dir, sessionFile, pane: id });
		const report = (outcomes: PromptOutcome[]) => client.remoteReport(id, { models: [], outcomes });
		await beat();
		await report([]);
		const deliver = async () => {
			const { messages = [] } = await beat();
			const ids = messages.flatMap((m) => (m.type === "prompt" && m.id ? [m.id] : []));
			await report(ids.map((id, i) => ({ id, outcome: i ? "queued" : "taken" })));
		};
		return { row, beat, report, deliver, unregister: (reason: EndReason) => client.unregister(id, reason) };
	}

	/** No heartbeat from pane `id` for longer than the registry waits: the next look at the list reaps it,
	 *  and one tmux still has is listed silent. */
	async function reap(id: string) {
		clock += 20_000;
		await waitFor(() =>
			expect(supervisor.listExternalInstances().some((e) => e.record.pane === id && !e.silent)).toBe(false),
		);
	}

	it.each([
		["beats again, then reports it", true],
		["reports it, then beats again", false],
	])("is never lost when its pane, reaped while still alive (the Mac slept), %s taken", async (_, beatsFirst) => {
		const pane = await tmuxPane("pane-asleep");
		const phone = await watch(pane.row);
		expect(await prompt(pane.row, { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt(pane.row, { text: "second", id: "p-second" })).toBe(202);
		await pane.deliver();
		await phone.until({ id: "p-second", outcome: "queued" });
		await reap("pane-asleep");
		// It wakes, and pi takes the prompt it had queued.
		const taken: PromptOutcome[] = [
			{ id: "p-first", outcome: "taken" },
			{ id: "p-second", outcome: "taken" },
		];
		if (beatsFirst) await pane.beat();
		await pane.report(taken);
		if (!beatsFirst) await pane.beat();
		await phone.until({ id: "p-second", outcome: "taken" });
		expect(phone.seen().filter((o) => o.outcome === "lost")).toEqual([]);
		expect((await status(pane.row)).outcomes).toEqual(taken);
	});

	it("is never lost when a pane a start claimed a row for, its session's file not written yet, is reaped while still alive and comes back", async () => {
		const pane = await tmuxPane("pane-started", { started: true });
		const phone = await watch(pane.row);
		expect(await prompt(pane.row, { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt(pane.row, { text: "second", id: "p-second" })).toBe(202);
		await pane.deliver();
		await phone.until({ id: "p-second", outcome: "queued" });
		await reap("pane-started");
		await pane.beat();
		expect(supervisor.rowIdOf("pane-started")).toBe(pane.row);
		await pane.report([
			{ id: "p-first", outcome: "taken" },
			{ id: "p-second", outcome: "taken" },
		]);
		await phone.until({ id: "p-second", outcome: "taken" });
		expect(phone.seen().filter((o) => o.outcome === "lost")).toEqual([]);
	});

	it.each([
		["its tmux session is gone when it is reaped", { goneAtReap: true, quits: false }],
		["its tmux session goes later", { goneAtReap: false, quits: false }],
		["it quits after it was reaped", { goneAtReap: false, quits: true }],
	])("is lost when its pane is reaped and never beats again: %s", async (_, end) => {
		const pane = await tmuxPane("pane-dead");
		const phone = await watch(pane.row);
		expect(await prompt(pane.row, { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt(pane.row, { text: "second", id: "p-second" })).toBe(202);
		await pane.deliver();
		await phone.until({ id: "p-second", outcome: "queued" });
		if (end.goneAtReap) tmuxGone.add("pane-dead");
		await reap("pane-dead");
		if (!end.goneAtReap) {
			expect(await (await watch(pane.row)).replayed()).toContainEqual({ id: "p-second", outcome: "queued" });
			if (end.quits) await pane.unregister("quit");
			else tmuxGone.add("pane-dead");
		}
		await phone.until({ id: "p-second", outcome: "lost", reason: "pane_gone" });
		expect(await (await watch(pane.row)).replayed()).toEqual([
			{ id: "p-first", outcome: "taken" },
			{ id: "p-second", outcome: "lost", reason: "pane_gone" },
		]);
	});

	it("is lost at once when its pane is reaped, though still alive, before it was delivered", async () => {
		const pane = await tmuxPane("pane-inbox");
		const phone = await watch(pane.row);
		expect(await prompt(pane.row, { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt(pane.row, { text: "second", id: "p-second" })).toBe(202);
		await pane.deliver();
		expect(await prompt(pane.row, { text: "third", id: "p-third" })).toBe(202);
		await reap("pane-inbox");
		await phone.until({ id: "p-third", outcome: "lost", reason: "pane_gone" });
		expect(await (await watch(pane.row)).replayed()).toEqual([
			{ id: "p-first", outcome: "taken" },
			{ id: "p-second", outcome: "queued" },
			{ id: "p-third", outcome: "lost", reason: "pane_gone" },
		]);
	});

	it("is not lost when a silent pane dies after another pane went on as its row", async () => {
		const old = await tmuxPane("pane-old");
		const phone = await watch(old.row);
		expect(await prompt(old.row, { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt(old.row, { text: "second", id: "p-second" })).toBe(202);
		await old.deliver();
		await phone.until({ id: "p-second", outcome: "queued" });
		await reap("pane-old");
		// The session resumed in another pane, which goes on as its row.
		const client = new OrchestratorClient();
		const sessionFile = join(dir, "pane-old.jsonl");
		await client.register({ id: "pane-new", cwd: dir, sessionFile, pane: "pane-new" });
		expect(supervisor.rowIdOf("pane-new")).toBe(old.row);
		expect(await prompt(old.row, { text: "third", id: "p-third" })).toBe(202);
		await client.register({ id: "pane-new", cwd: dir, sessionFile, pane: "pane-new" });
		await client.remoteReport("pane-new", { models: [], outcomes: [{ id: "p-third", outcome: "queued" }] });
		await phone.until({ id: "p-third", outcome: "queued" });
		tmuxGone.add("pane-old");
		await phone.until({ id: "p-second", outcome: "lost", reason: "pane_gone" });
		expect(await (await watch(old.row)).replayed()).toEqual([
			{ id: "p-first", outcome: "taken" },
			{ id: "p-second", outcome: "lost", reason: "pane_gone" },
			{ id: "p-third", outcome: "queued" },
		]);
		await client.unregister("pane-new", "quit");
	});

	it("is lost when pi drops it from its queue, live and to a stream that reconnects, past the pane's next session", async () => {
		const file = join(dir, "pane-dequeued.jsonl");
		const { registration, dequeue } = await fakePane("pane-dequeued", { sessionFile: file });
		const phone = await watch("pane-dequeued");
		expect(await prompt("pane-dequeued", { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt("pane-dequeued", { text: "second", id: "p-second" })).toBe(202);
		await phone.until({ id: "p-second", outcome: "queued" });
		// A /resume of the same file mid-turn: agent view stops the pane's heartbeat first, keeping its row,
		// then the pane reports it, and its next session goes on.
		await registration.stop({ unregister: false, reason: "resume" });
		await dequeue();
		await phone.until({ id: "p-second", outcome: "lost", reason: "dequeued" });
		await fakePane("pane-dequeued", { sessionFile: file });
		expect(await (await watch("pane-dequeued")).replayed()).toEqual([
			{ id: "p-first", outcome: "taken" },
			{ id: "p-second", outcome: "lost", reason: "dequeued" },
		]);
	});

	it("shows only the outcomes of prompts the daemon delivered to that pane", async () => {
		await fakePane("pane-own");
		// A pane cannot claim another's prompt, or one no phone sent.
		await new OrchestratorClient().remoteReport("pane-own", {
			models: [],
			outcomes: [{ id: "p-never-sent", outcome: "taken" }],
		});
		expect(await status("pane-own")).toMatchObject({ outcomes: [] });
	});
});

describe("prompt delivery", () => {
	it("keeps an outcome for a phone that reconnects within the window, then lets it go", () => {
		const delivery = new PromptDelivery(() => true);
		delivery.send("pane-1", { type: "prompt", text: "hi", id: "p-1" }, 0);
		delivery.reported("pane-1", [{ id: "p-1", outcome: "queued" }], 20);
		// Taken later, as pi starts the queued prompt: the window runs from then.
		delivery.reported("pane-1", [{ id: "p-1", outcome: "taken" }], 1000);
		expect(delivery.outcomes("pane-1", 1000 + DELIVERY_KEEP_MS)).toEqual([{ id: "p-1", outcome: "taken" }]);
		expect(delivery.outcomes("pane-2", 1000 + DELIVERY_KEEP_MS)).toEqual([]);
		expect(delivery.outcomes("pane-1", 1001 + DELIVERY_KEEP_MS)).toEqual([]);
	});

	it("keeps a queued prompt for as long as the turn ahead of it runs", () => {
		const delivery = new PromptDelivery(() => true);
		delivery.send("pane-1", { type: "prompt", text: "hi", id: "p-1" }, 0);
		delivery.reported("pane-1", [{ id: "p-1", outcome: "queued" }], 20);
		const later = 20 + 3 * DELIVERY_KEEP_MS;
		expect(delivery.outcomes("pane-1", later)).toEqual([{ id: "p-1", outcome: "queued" }]);
		delivery.reported("pane-1", [{ id: "p-1", outcome: "taken" }], later);
		expect(delivery.outcomes("pane-1", later)).toEqual([{ id: "p-1", outcome: "taken" }]);
	});

	it("tracks nothing a pane was not sent", () => {
		const delivery = new PromptDelivery(() => false);
		expect(delivery.send("gone", { type: "prompt", text: "hi", id: "p-1" })).toBe(false);
		delivery.reported("gone", [{ id: "p-1", outcome: "taken" }]);
		expect(delivery.outcomes("gone")).toEqual([]);
	});
});
