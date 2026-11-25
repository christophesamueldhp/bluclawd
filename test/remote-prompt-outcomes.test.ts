import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest, listSummaries } from "../daemon/handler.ts";
import type { PaneMessage, PromptOutcome, RefusedReason } from "../daemon/ipc/protocol.ts";
import { startIpcServer } from "../daemon/ipc/server.ts";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { RemoteControl } from "../daemon/remote/control.ts";
import { DELIVERY_KEEP_MS, PromptDelivery } from "../daemon/remote/delivery.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import { saveInstances, upsertInstance } from "../daemon/storage.ts";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import type { Tmux } from "../daemon/tmux.ts";
import { shutdownPlan } from "../ext/agent-view/index.ts";
import { SelfRegistration } from "../ext/agent-view/self-registration.ts";
import { refusal } from "../ext/remote/outcomes.ts";
import { paneUp, testRegistry } from "./helpers/registry.ts";
import { waitFor } from "./helpers/wait-for.ts";

describe("a prompt's outcome, back to the phone by its id", () => {
	let dir: string;
	let server: Server;
	let supervisor: ServerSupervisor;
	let control: RemoteControl;
	let base: string;
	let token: string;
	let clock: number;
	const lost = new Set<string>();
	const registrations: SelfRegistration[] = [];
	const streams: AbortController[] = [];

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
			delivery: supervisor.delivery,
			tmux: { attached: () => true, attachedAsync: async () => true } as unknown as Tmux,
			webDir: dir,
		});
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-outcomes-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		clock = Date.now();
		supervisor = new ServerSupervisor({
			now: () => clock,
			tmux: { hasSession: (name) => !lost.has(name), hangUpAsQuit: () => {} },
			dir,
		});
		server = await startIpcServer((request) => handleIpcRequest(supervisor, request, { remote: control }));
		control = remoteControl();
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
		supervisor.settleWaits();
		await new Promise((resolve) => server.close(resolve));
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

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
				const reason = refusal(message, { manualCompactionRunning: false, sessionFile }) ?? options.refuse;
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
		const dequeue = () => {
			for (const [i, o] of outcomes.entries())
				if (o.outcome === "queued") outcomes[i] = { id: o.id, outcome: "lost", reason: "dequeued" };
			return report();
		};
		return { received, registration, dequeue };
	}

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

	async function stillPane(id: string) {
		const client = new OrchestratorClient();
		await client.register({ id, cwd: dir, sessionFile: join(dir, `${id}.jsonl`) });
		await client.remoteReport(id, { models: [], outcomes: [] });
		return {
			unregister: () => client.unregister(id),
			report: (outcomes: boolean) =>
				client.remoteReport(id, outcomes ? { models: [], outcomes: [] } : { models: [] }),
		};
	}

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
			seen: () =>
				received
					.split("\n")
					.filter((l) => l.startsWith("data:") && l.includes('"outcomes"'))
					.flatMap((l) => (JSON.parse(l.slice(5)) as { outcomes: PromptOutcome[] }).outcomes),
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
			const targetSessionFile = "target" in end ? (end.target === "same" ? file : other) : undefined;
			const plan = shutdownPlan({ reason: end.reason, targetSessionFile }, file);
			const stopping = registration.stop({ unregister: plan.unregister, reason: end.reason });
			client.release();
			await stopping;
			if (next) await fakePane("pane-move", { sessionFile: next === "same" ? file : other });
			await phone.until(outcome);
		},
	);

	async function ask(session: string, waiting: { id: string; lifetime?: string }[]): Promise<PromptOutcome[]> {
		const query = waiting
			.map(({ id, lifetime }) => `prompt=${encodeURIComponent(lifetime === undefined ? id : `${id}@${lifetime}`)}`)
			.join("&");
		const res = await fetch(`${base}/api/sessions/${session}/outcomes?${query}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		return ((await res.json()) as { outcomes: PromptOutcome[] }).outcomes;
	}

	async function restart() {
		await control.stop();
		supervisor = new ServerSupervisor({ now: () => clock, tmux: paneUp, dir });
		control = remoteControl();
		const on = await control.handle({ type: "remote", action: "on", port: 0 });
		if (on.type !== "remote_result") throw new Error("not listening");
		base = `http://127.0.0.1:${on.port}`;
	}

	it.each([
		["reports outcomes", true, [{ id: "p-restart", outcome: "lost", reason: "daemon_restarted" }]],
		["is from an older build", false, []],
	] as const)(
		"is answered by a restarted daemon, which replays none, from what its pane's report says: it %s",
		async (_, reports, answer) => {
			const pane = await stillPane("pane-restart");
			const res = await fetch(`${base}/api/sessions/pane-restart/prompt`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ text: "hi", id: "p-restart" }),
			});
			expect(res.status).toBe(202);
			const { lifetime } = (await res.json()) as { lifetime: string };
			const waiting = [{ id: "p-restart", lifetime }];
			expect(await (await watch("pane-restart")).replayed()).toEqual([{ id: "p-restart", outcome: "sent" }]);
			expect(await ask("pane-restart", waiting)).toEqual([{ id: "p-restart", outcome: "sent" }]);
			await restart();
			expect(await (await watch("pane-restart")).replayed()).toEqual([]);
			expect(await ask("pane-restart", waiting)).toEqual([]);
			await pane.report(reports);
			expect(await ask("pane-restart", waiting)).toEqual(answer);
		},
	);

	it("ignores an id asked about with no lifetime", async () => {
		const pane = await stillPane("pane-unaged");
		expect(await prompt("pane-unaged", { text: "hi", id: "p-unaged" })).toBe(202);
		await pane.report(true);
		expect(await ask("pane-unaged", [{ id: "p-unaged" }])).toEqual([]);
	});

	it("is refused once tmux no longer has its pane, as its pi died unseen", async () => {
		await new OrchestratorClient().register({ id: "pane-dead", pane: "pane-dead", cwd: dir });
		lost.add("pane-dead");
		expect(await prompt("pane-dead", { text: "hi", id: "p-dead" })).toBe(409);
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
		clock += 60_000;
		await phone.until({ id: "p-reaped", outcome: "lost", reason: "pane_gone" });
	});

	async function tmuxPane(id: string, options: { started?: boolean } = {}) {
		const client = new OrchestratorClient();
		const sessionFile = join(dir, `${id}.jsonl`);
		let row = `row-${id}`;
		if (options.started) {
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
		return { row, beat, report, deliver };
	}

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

	it("is in its pane's status while that pane is silent", async () => {
		const pane = await tmuxPane("pane-quiet");
		const phone = await watch(pane.row);
		expect(await prompt(pane.row, { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt(pane.row, { text: "second", id: "p-second" })).toBe(202);
		await pane.deliver();
		await phone.until({ id: "p-second", outcome: "queued" });
		await reap("pane-quiet");
		await fakePane("pane-other");
		const res = await fetch(`${base}/api/sessions/${pane.row}/status`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect((await status(pane.row)).outcomes).toEqual([
			{ id: "p-first", outcome: "taken" },
			{ id: "p-second", outcome: "queued" },
		]);
	});

	it("is lost when pi drops it from its queue, live and to a stream that reconnects, past the pane's next session", async () => {
		const file = join(dir, "pane-dequeued.jsonl");
		const { registration, dequeue } = await fakePane("pane-dequeued", { sessionFile: file });
		const phone = await watch("pane-dequeued");
		expect(await prompt("pane-dequeued", { text: "first", id: "p-first" })).toBe(202);
		expect(await prompt("pane-dequeued", { text: "second", id: "p-second" })).toBe(202);
		await phone.until({ id: "p-second", outcome: "queued" });
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
		await new OrchestratorClient().remoteReport("pane-own", {
			models: [],
			outcomes: [{ id: "p-never-sent", outcome: "taken" }],
		});
		expect(await status("pane-own")).toMatchObject({ outcomes: [] });
	});
});

function deliveryFixture() {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-delivery-"));
	const clock = { now: Date.parse("2026-11-04T10:00:00.000Z") };
	const tmux = new Map<string, "up" | "gone">();
	const supervisor = testRegistry(dir, () => clock.now, {
		hasSession: (name) => tmux.get(name) !== "gone",
		hangUpAsQuit: () => {},
	});
	const file = join(dir, "s.jsonl");
	const other = join(dir, "other.jsonl");
	writeFileSync(file, "");
	writeFileSync(other, "");
	saveInstances(dir, [
		{ id: ROW, status: "stopped", cwd: dir, createdAt: new Date(clock.now).toISOString(), sessionFile: file },
	]);
	const beat = (pane = "pi-a", sessionFile = file) =>
		supervisor.registerExternal(
			{ id: pane, status: "online", cwd: dir, createdAt: new Date(clock.now).toISOString(), sessionFile, pane },
			"idle",
		);
	const send = (id: string) => supervisor.sendExternal(ROW, { type: "prompt", text: id, id });
	const lapse = (said: "up" | "gone" = "up") => {
		tmux.set("pi-a", said);
		clock.now += 20_000;
		supervisor.listExternalInstances();
	};
	const outcomes = () => supervisor.delivery.outcomes(ROW);
	return { supervisor, tmux, other, beat, send, lapse, outcomes };
}

const ROW = "row-s";
const given = (outcome: PromptOutcome["outcome"], reason?: string) =>
	({ id: "p-given", outcome, ...(reason ? { reason } : {}) }) as PromptOutcome;
const inbox = (outcome: PromptOutcome["outcome"], reason?: string) =>
	({ id: "p-inbox", outcome, ...(reason ? { reason } : {}) }) as PromptOutcome;

describe("prompt delivery, fed by the row table", () => {
	async function delivering() {
		const f = deliveryFixture();
		f.beat();
		await f.send("p-given");
		f.supervisor.drainExternal("pi-a");
		await f.send("p-inbox");
		return f;
	}

	it("keeps a prompt in its row's inbox until its pane's heartbeat takes it, in the order sent", async () => {
		const f = deliveryFixture();
		f.beat();
		expect(await f.send("p-1")).toBe(true);
		expect(await f.supervisor.sendExternal(ROW, { type: "abort" })).toBe(true);
		expect(f.outcomes()).toEqual([{ id: "p-1", outcome: "sent" }]);
		expect(f.supervisor.drainExternal("pi-a")).toEqual([
			{ type: "prompt", text: "p-1", id: "p-1" },
			{ type: "abort" },
		]);
		expect(f.supervisor.drainExternal("pi-a")).toEqual([]);
		expect(f.outcomes()).toEqual([{ id: "p-1", outcome: "sent" }]);
	});

	it("tracks nothing for a row no live pane takes", async () => {
		const f = deliveryFixture();
		expect(await f.send("p-1")).toBe(false);
		expect(f.outcomes()).toEqual([]);
	});

	it("settles what its pane reports of the prompts its row was given, and nothing else", async () => {
		const f = await delivering();
		f.supervisor.delivery.reported(ROW, [
			{ id: "p-given", outcome: "taken" },
			{ id: "p-never-sent", outcome: "taken" },
		]);
		f.supervisor.delivery.reported("row-other", [{ id: "p-inbox", outcome: "taken" }]);
		expect(f.outcomes()).toEqual([given("taken"), inbox("sent")]);
	});

	it.each<[string, (f: Awaited<ReturnType<typeof delivering>>) => void, PromptOutcome[]]>([
		[
			"it quits",
			(f) => f.supervisor.unregisterExternal("pi-a", "quit"),
			[given("lost", "pane_gone"), inbox("lost", "pane_gone")],
		],
		[
			"it unregisters with no reason (an older pane)",
			(f) => f.supervisor.unregisterExternal("pi-a"),
			[given("lost", "pane_gone"), inbox("lost", "pane_gone")],
		],
		[
			"its session ends for a new one",
			(f) => f.supervisor.unregisterExternal("pi-a", "new"),
			[given("refused", "session_changed"), inbox("refused", "session_changed")],
		],
		[
			"its session ends for a fork",
			(f) => f.supervisor.unregisterExternal("pi-a", "fork"),
			[given("refused", "session_changed"), inbox("refused", "session_changed")],
		],
		["it is reaped with tmux gone", (f) => f.lapse("gone"), [given("lost", "pane_gone"), inbox("lost", "pane_gone")]],
		[
			"its row is deleted",
			(f) => f.supervisor.deleteInstance(ROW),
			[given("lost", "pane_gone"), inbox("lost", "pane_gone")],
		],
	])("ends what its row's inbox and its pane hold when its pane ends: %s", async (_, ends, outcomes) => {
		const f = await delivering();
		ends(f);
		expect(f.outcomes()).toEqual(outcomes);
	});

	it("loses a Silent pane's inbox at once, while what it was given waits on its report", async () => {
		const f = await delivering();
		f.lapse();
		expect(f.outcomes()).toEqual([given("sent"), inbox("lost", "pane_gone")]);
		f.beat();
		f.supervisor.delivery.reported(ROW, [{ id: "p-given", outcome: "taken" }]);
		expect(f.outcomes()).toEqual([given("taken"), inbox("lost", "pane_gone")]);
	});

	it("loses what a Silent pane was given once tmux no longer has it", async () => {
		const f = await delivering();
		f.lapse();
		f.tmux.set("pi-a", "gone");
		f.supervisor.listExternalInstances();
		expect(f.outcomes()).toEqual([given("lost", "pane_gone"), inbox("lost", "pane_gone")]);
	});

	it("refuses what a Silent pane was given once it comes back on another session", async () => {
		const f = await delivering();
		f.lapse();
		f.beat("pi-a", f.other);
		expect(f.outcomes()).toEqual([given("refused", "session_changed"), inbox("lost", "pane_gone")]);
	});

	it("leaves the row's inbox to the pane that went on as its row when a Silent pane it held ends", async () => {
		const f = await delivering();
		f.lapse();
		f.beat("pi-b");
		await f.send("p-next");
		f.tmux.set("pi-a", "gone");
		f.supervisor.listExternalInstances();
		expect(f.outcomes()).toEqual([
			given("lost", "pane_gone"),
			inbox("lost", "pane_gone"),
			{ id: "p-next", outcome: "sent" },
		]);
		expect(f.supervisor.drainExternal("pi-b")).toEqual([{ type: "prompt", text: "p-next", id: "p-next" }]);
	});

	it("tells its listener of each row whose pane ended or fell silent", async () => {
		const f = await delivering();
		const changed: string[] = [];
		f.supervisor.delivery.settledByPaneGoing = (row) => changed.push(row);
		f.lapse();
		f.tmux.set("pi-a", "gone");
		f.supervisor.listExternalInstances();
		expect(changed).toEqual([ROW, ROW]);
	});
});

describe("prompt delivery's retention", () => {
	function given1() {
		const clock = { now: 0 };
		const delivery = new PromptDelivery(() => clock.now);
		delivery.queue("row-1", { type: "prompt", text: "hi", id: "p-1" });
		delivery.take("row-1", "pi-a");
		return { clock, delivery };
	}

	it("keeps an outcome for a phone that reconnects within the window, then lets it go", () => {
		const { clock, delivery } = given1();
		clock.now = 20;
		delivery.reported("row-1", [{ id: "p-1", outcome: "queued" }]);
		clock.now = 1000;
		delivery.reported("row-1", [{ id: "p-1", outcome: "taken" }]);
		clock.now = 1000 + DELIVERY_KEEP_MS;
		expect(delivery.outcomes("row-1")).toEqual([{ id: "p-1", outcome: "taken" }]);
		expect(delivery.outcomes("row-2")).toEqual([]);
		clock.now = 1001 + DELIVERY_KEEP_MS;
		expect(delivery.outcomes("row-1")).toEqual([]);
	});

	it("keeps a queued prompt for as long as the turn ahead of it runs", () => {
		const { clock, delivery } = given1();
		clock.now = 20;
		delivery.reported("row-1", [{ id: "p-1", outcome: "queued" }]);
		clock.now = 20 + 3 * DELIVERY_KEEP_MS;
		expect(delivery.outcomes("row-1")).toEqual([{ id: "p-1", outcome: "queued" }]);
		delivery.reported("row-1", [{ id: "p-1", outcome: "taken" }]);
		expect(delivery.outcomes("row-1")).toEqual([{ id: "p-1", outcome: "taken" }]);
	});
});

describe("prompt delivery's answer to a phone about the prompts it still waits on", () => {
	function delivering() {
		const delivery = new PromptDelivery(() => 0);
		delivery.queue("row-1", { type: "prompt", text: "a", id: "p-taken" });
		delivery.queue("row-1", { type: "prompt", text: "b", id: "p-sent" });
		delivery.take("row-1", "pi-a");
		delivery.reported("row-1", [{ id: "p-taken", outcome: "taken" }]);
		return delivery;
	}
	const asked = (lifetime: string, ...ids: string[]) => ids.map((id) => ({ id, lifetime }));

	it("answers each id it knows with its outcome", () => {
		const delivery = delivering();
		expect(delivery.answer("row-1", asked(delivery.lifetime, "p-taken", "p-sent"), true)).toEqual([
			{ id: "p-taken", outcome: "taken" },
			{ id: "p-sent", outcome: "sent" },
		]);
	});

	it("says nothing of one this lifetime accepted and let go: the phone's give-up decides", () => {
		const clock = { now: 0 };
		const delivery = new PromptDelivery(() => clock.now);
		delivery.queue("row-1", { type: "prompt", text: "a", id: "p-old" });
		clock.now = DELIVERY_KEEP_MS + 1;
		expect(delivery.answer("row-1", asked(delivery.lifetime, "p-old", "p-never"), true)).toEqual([]);
	});

	it("answers lost as daemon restarted for one an earlier lifetime accepted, when the row's pane reports outcomes", () => {
		const before = delivering();
		const restarted = new PromptDelivery(() => 0);
		expect(restarted.lifetime).not.toBe(before.lifetime);
		expect(restarted.answer("row-1", asked(before.lifetime, "p-sent"), true)).toEqual([
			{ id: "p-sent", outcome: "lost", reason: "daemon_restarted" },
		]);
	});

	it("says nothing of one an earlier lifetime accepted for a pane from an older build, or one yet to report: pi may have it", () => {
		const before = delivering();
		const restarted = new PromptDelivery(() => 0);
		expect(restarted.answer("row-1", asked(before.lifetime, "p-sent"), false)).toEqual([]);
	});
});
