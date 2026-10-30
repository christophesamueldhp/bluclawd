import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest, listSummaries, setRemoteControl } from "../daemon/handler.ts";
import type { PaneMessage, PromptOutcome } from "../daemon/ipc/protocol.ts";
import { startIpcServer } from "../daemon/ipc/server.ts";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { RemoteControl } from "../daemon/remote/control.ts";
import { DELIVERY_KEEP_MS, PromptDelivery } from "../daemon/remote/delivery.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import { supervisor } from "../daemon/supervisor.ts";
import type { Tmux } from "../daemon/tmux.ts";
import { SelfRegistration } from "../ext/agent-view/self-registration.ts";
import { waitFor } from "./helpers/wait-for.ts";

/**
 * A phone's prompt with its id, from the HTTP route through a real daemon socket to a pane's
 * registration and back as the outcome the phone reads in the session's status.
 */
describe("a prompt's outcome, back to the phone by its id", () => {
	let dir: string;
	let server: Server;
	let control: RemoteControl;
	let base: string;
	let token: string;
	const registrations: SelfRegistration[] = [];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-outcomes-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		server = await startIpcServer(handleIpcRequest);
		control = new RemoteControl({
			store: new RemoteStore(join(dir, "remote.json")),
			listInstances: listSummaries,
			send: (id, message) => supervisor.sendExternal(id, message),
			deleteInstance: () => false,
			renameInstance: () => false,
			setPinned: () => false,
			// A terminal shows pi, so the phone may prompt.
			tmux: { attached: () => true } as unknown as Tmux,
			webDir: dir,
		});
		setRemoteControl(control);
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
		await Promise.all(registrations.splice(0).map((r) => r.stop()));
		await control.stop();
		setRemoteControl(undefined);
		supervisor.settleWaits();
		await new Promise((resolve) => server.close(resolve));
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * A pane that reports outcomes, as a current one does: its first prompt starts a turn, and pi
	 * queues the ones after it behind that turn. `reports: false`: a pane from an older build.
	 */
	async function fakePane(id: string, options: { reports?: boolean } = {}) {
		const client = new OrchestratorClient();
		const reports = options.reports !== false;
		const outcomes: PromptOutcome[] = [];
		const received: PaneMessage[] = [];
		let turn = false;
		const report = () => client.remoteReport(id, reports ? { models: [], outcomes: [...outcomes] } : { models: [] });
		const registration = new SelfRegistration(
			client,
			() => ({ cwd: dir, sessionFile: join(dir, `${id}.jsonl`) }),
			(message) => {
				received.push(message);
				if (!reports || message.type !== "prompt" || !message.id) return;
				outcomes.push({ id: message.id, outcome: turn ? "queued" : "taken" });
				turn = true;
				void report();
			},
			id,
		);
		registrations.push(registration);
		registration.start();
		await waitFor(() => expect(supervisor.listExternalInstances().some((e) => e.record.id === id)).toBe(true));
		await report();
		return { received };
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
		await waitFor(() => expect(received).toEqual([{ type: "prompt", text: "hi", id: "p-old" }]));
		expect(await status("pane-old")).not.toHaveProperty("outcomes");
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
		delivery.delivered("pane-1", [{ type: "prompt", text: "hi", id: "p-1" }], 10);
		delivery.reported("pane-1", [{ id: "p-1", outcome: "queued" }], 20);
		// Taken later, as pi starts the queued prompt: the window runs from then.
		delivery.reported("pane-1", [{ id: "p-1", outcome: "taken" }], 1000);
		expect(delivery.outcomes("pane-1", 1000 + DELIVERY_KEEP_MS)).toEqual([{ id: "p-1", outcome: "taken" }]);
		expect(delivery.outcomes("pane-2", 1000 + DELIVERY_KEEP_MS)).toEqual([]);
		expect(delivery.outcomes("pane-1", 1001 + DELIVERY_KEEP_MS)).toEqual([]);
	});

	it("tracks nothing a pane was not sent", () => {
		const delivery = new PromptDelivery(() => false);
		expect(delivery.send("gone", { type: "prompt", text: "hi", id: "p-1" })).toBe(false);
		delivery.reported("gone", [{ id: "p-1", outcome: "taken" }]);
		expect(delivery.outcomes("gone")).toEqual([]);
	});
});
