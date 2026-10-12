import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstanceSummary, PaneLaunch, PaneMessage } from "../daemon/ipc/protocol.ts";
import { BODY_MAX, PROMPT_MAX, type RemoteServer, startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import type { SessionSpec } from "../daemon/remote/spawn.ts";
import { validP256dh } from "./support/push.ts";

const entry = (id: string, parentId: string | null, content: string) =>
	`${JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } })}\n`;

describe("remote HTTP API", () => {
	let dir: string;
	let store: RemoteStore;
	let server: RemoteServer;
	let base: string;
	let instances: InstanceSummary[];
	let sent: Array<{ id: string; message: PaneMessage }>;
	let launch: PaneLaunch | undefined;
	let started: SessionSpec[];
	let deleted: string[];
	let startFails: boolean;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-http-"));
		const web = join(dir, "web");
		mkdirSync(web);
		writeFileSync(join(web, "index.html"), "<!doctype html><title>bluclawd</title>");
		writeFileSync(join(web, "app.js"), "export {};");
		writeFileSync(join(dir, "live.jsonl"), entry("u1", null, "hello"));
		instances = [
			{
				id: "live",
				status: "online",
				cwd: "/p",
				external: true,
				activity: "working",
				sessionFile: join(dir, "live.jsonl"),
			},
			{ id: "stored", status: "stopped", cwd: "/p", sessionFile: join(dir, "stored.jsonl") },
		];
		sent = [];
		launch = { command: ["node", "pi.js"] };
		started = [];
		deleted = [];
		startFails = false;
		store = new RemoteStore(join(dir, "remote.json"));
		server = await startRemoteServer(
			{
				store,
				webDir: web,
				listInstances: () => instances,
				send: (id, message) => {
					sent.push({ id, message });
					return true;
				},
				launch: () => launch,
				startSession: (spec) => {
					if (startFails) throw new Error("tmux: no server");
					started.push(spec);
					return "pi-0000000a";
				},
				deleteInstance: (id) => {
					deleted.push(id);
					instances = instances.filter((i) => i.id !== id);
					return true;
				},
			},
			0,
		);
		base = `http://127.0.0.1:${server.port}`;
	});

	afterEach(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function pair(): Promise<string> {
		const { code } = store.createCode();
		const res = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ code, deviceName: "iPhone" }),
		});
		expect(res.status).toBe(200);
		return ((await res.json()) as { token: string }).token;
	}
	const auth = (token: string) => ({ authorization: `Bearer ${token}` });
	const json = { "content-type": "application/json" };
	const authJson = (token: string) => ({ ...auth(token), ...json });

	it("serves the PWA without a token, and nothing outside its directory", async () => {
		expect((await fetch(`${base}/`)).headers.get("content-type")).toContain("text/html");
		expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toContain("default-src 'self'");
		expect((await fetch(`${base}/app.js`)).status).toBe(200);
		expect((await fetch(`${base}/..%2Fremote.json`)).status).toBe(404);
		expect((await fetch(`${base}/missing.js`)).status).toBe(404);
	});

	it("rejects the API without a valid token", async () => {
		expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
		expect((await fetch(`${base}/api/sessions`, { headers: auth("bogus") })).status).toBe(401);
		expect((await fetch(`${base}/api/events?token=bogus`)).status).toBe(401);
	});

	it("rejects a wrong pairing code", async () => {
		store.createCode();
		const res = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: json,
			body: JSON.stringify({ code: "abc", deviceName: "x" }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_code" });
	});

	it("lists sessions and reads a transcript", async () => {
		const token = await pair();
		const list = (await (await fetch(`${base}/api/sessions`, { headers: auth(token) })).json()) as {
			sessions: Array<{ id: string; band: string }>;
		};
		expect(list.sessions.map((s) => [s.id, s.band])).toEqual([
			["live", "working"],
			["stored", "idle"],
		]);
		const live = await (await fetch(`${base}/api/sessions/live/messages`, { headers: auth(token) })).json();
		expect(live.messages).toEqual([{ kind: "user", id: "u1", text: "hello" }]);
		const stored = await (await fetch(`${base}/api/sessions/stored/messages`, { headers: auth(token) })).json();
		expect(stored.messages).toEqual([]);
		expect((await fetch(`${base}/api/sessions/nope/messages`, { headers: auth(token) })).status).toBe(404);
	});

	it("queues a prompt and an abort for a running session", async () => {
		const token = await pair();
		const prompt = await fetch(`${base}/api/sessions/live/prompt`, {
			method: "POST",
			headers: authJson(token),
			body: JSON.stringify({ text: "next" }),
		});
		expect(prompt.status).toBe(202);
		const abort = await fetch(`${base}/api/sessions/live/abort`, { method: "POST", headers: authJson(token) });
		expect(abort.status).toBe(202);
		expect(sent).toEqual([
			{ id: "live", message: { type: "prompt", text: "next" } },
			{ id: "live", message: { type: "abort" } },
		]);
	});

	it("refuses a stored session without a file, an empty or oversized prompt, and an oversized body", async () => {
		instances = [...instances, { id: "fileless", status: "stopped", cwd: "/p" }];
		const token = await pair();
		const post = (path: string, body: string) =>
			fetch(`${base}${path}`, { method: "POST", headers: authJson(token), body });
		expect((await post("/api/sessions/fileless/prompt", JSON.stringify({ text: "hi" }))).status).toBe(409);
		expect((await post("/api/sessions/stored/abort", "{}")).status).toBe(409);
		expect((await post("/api/sessions/live/prompt", JSON.stringify({ text: "  " }))).status).toBe(400);
		expect(
			(await post("/api/sessions/live/prompt", JSON.stringify({ text: "x".repeat(PROMPT_MAX + 1) }))).status,
		).toBe(413);
		expect((await post("/api/sessions/live/prompt", "x".repeat(BODY_MAX + 1))).status).toBe(413);
		expect(sent).toEqual([]);
		expect(started).toEqual([]);
	});

	it("resumes a stored session with the reply as its first prompt, replacing its row", async () => {
		const token = await pair();
		const res = await fetch(`${base}/api/sessions/stored/prompt`, {
			method: "POST",
			headers: authJson(token),
			body: JSON.stringify({ text: "carry on" }),
		});
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ ok: true, pane: "pi-0000000a" });
		expect(started).toEqual([{ cwd: "/p", task: "carry on", sessionFile: join(dir, "stored.jsonl"), launch }]);
		expect(deleted).toEqual(["stored"]);
		expect(sent).toEqual([]);
	});

	it("starts a new session in a directory", async () => {
		const token = await pair();
		const start = (body: object) =>
			fetch(`${base}/api/sessions`, { method: "POST", headers: authJson(token), body: JSON.stringify(body) });
		const res = await start({ cwd: dir, task: "  fix the build ", model: "anthropic/claude-opus-5-5" });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ pane: "pi-0000000a" });
		expect((await start({ cwd: dir, task: "go" })).status).toBe(201);
		expect(started).toEqual([
			{ cwd: dir, task: "fix the build", model: "anthropic/claude-opus-5-5", launch },
			{ cwd: dir, task: "go", launch },
		]);
	});

	it("refuses to start a session with a bad directory, task or model, or before any pane registered", async () => {
		const token = await pair();
		const start = async (body: object) => {
			const res = await fetch(`${base}/api/sessions`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify(body),
			});
			return [res.status, ((await res.json()) as { error?: string }).error];
		};
		expect(await start({ cwd: "relative", task: "go" })).toEqual([400, "invalid_cwd"]);
		expect(await start({ cwd: join(dir, "missing"), task: "go" })).toEqual([400, "invalid_cwd"]);
		expect(await start({ cwd: join(dir, "live.jsonl"), task: "go" })).toEqual([400, "invalid_cwd"]);
		expect(await start({ cwd: dir, task: " " })).toEqual([400, "empty_prompt"]);
		expect(await start({ cwd: dir, task: "x".repeat(PROMPT_MAX + 1) })).toEqual([413, "prompt_too_large"]);
		expect(await start({ cwd: dir, task: "go", model: "opus" })).toEqual([400, "invalid_model"]);
		expect(await start({ cwd: dir, task: "go", model: "--model/x" })).toEqual([400, "invalid_model"]);
		expect(await start({ cwd: dir, task: "go", model: "anthropic/x; rm -rf ~" })).toEqual([400, "invalid_model"]);
		expect(await start({ cwd: dir, task: "go", model: "anthropic/x;y" })).toEqual([400, "invalid_model"]);
		launch = undefined;
		expect(await start({ cwd: dir, task: "go" })).toEqual([503, "no_launch"]);
		const resume = await fetch(`${base}/api/sessions/stored/prompt`, {
			method: "POST",
			headers: authJson(token),
			body: JSON.stringify({ text: "hi" }),
		});
		expect(resume.status).toBe(503);
		expect(started).toEqual([]);
		expect(deleted).toEqual([]);
	});

	it("expands a leading ~ in the directory to the home directory", async () => {
		const token = await pair();
		const start = (cwd: string) =>
			fetch(`${base}/api/sessions`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify({ cwd, task: "go" }),
			});
		mkdirSync(join(dir, "sub"));
		const home = process.env.HOME;
		process.env.HOME = dir;
		try {
			expect((await start("~")).status).toBe(201);
			expect((await start("~/sub")).status).toBe(201);
			expect((await start("~/missing")).status).toBe(400);
			expect((await start("~nobody")).status).toBe(400);
			expect(started.map((s) => s.cwd)).toEqual([homedir(), join(dir, "sub")]);
		} finally {
			process.env.HOME = home;
		}
	});

	it("resumes a stored session once when two replies race", async () => {
		const token = await pair();
		const body = JSON.stringify({ text: "first" });
		// The first reply's body arrives only after the second reply was handled.
		const slow = request(`${base}/api/sessions/stored/prompt`, {
			method: "POST",
			headers: { ...authJson(token), "content-length": Buffer.byteLength(body) },
		});
		const slowStatus = new Promise<number>((resolve, reject) => {
			slow.on("response", (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			slow.on("error", reject);
		});
		slow.flushHeaders();
		await new Promise((r) => setTimeout(r, 100));
		const fast = await fetch(`${base}/api/sessions/stored/prompt`, {
			method: "POST",
			headers: authJson(token),
			body: JSON.stringify({ text: "second" }),
		});
		slow.end(body);
		expect([fast.status, await slowStatus]).toEqual([202, 409]);
		expect(started.map((s) => s.task)).toEqual(["second"]);
		expect(deleted).toEqual(["stored"]);
	});

	it("keeps a stored row whose pane failed to start", async () => {
		startFails = true;
		const token = await pair();
		const post = (path: string, body: object) =>
			fetch(`${base}${path}`, { method: "POST", headers: authJson(token), body: JSON.stringify(body) });
		const resume = await post("/api/sessions/stored/prompt", { text: "hi" });
		expect([resume.status, await resume.json()]).toEqual([500, { error: "start_failed" }]);
		expect((await post("/api/sessions", { cwd: dir, task: "go" })).status).toBe(500);
		expect(deleted).toEqual([]);
	});

	it("lists the directories of listed sessions, most recent first", async () => {
		instances = [
			{ id: "a", status: "online", cwd: "/old", external: true, createdAt: "2026-10-01T00:00:00Z" },
			{ id: "b", status: "online", cwd: "/new", external: true, createdAt: "2026-10-03T00:00:00Z" },
			{ id: "c", status: "stopped", cwd: "/old", sessionFile: "/s/c.jsonl", createdAt: "2026-10-02T00:00:00Z" },
		];
		const token = await pair();
		const res = await fetch(`${base}/api/directories`, { headers: auth(token) });
		expect(await res.json()).toEqual({ directories: ["/new", "/old"] });
	});

	it("reads a running session's transcript from the leaf it reports", async () => {
		appendFileSync(join(dir, "live.jsonl"), entry("u2", "u1", "gone back from"));
		instances = [{ ...instances[0], leafId: "u1" }];
		const token = await pair();
		const res = await fetch(`${base}/api/sessions/live/messages`, { headers: auth(token) });
		expect(((await res.json()) as { messages: Array<{ id: string }> }).messages.map((m) => m.id)).toEqual(["u1"]);
	});

	it("signals transcript and list changes over SSE", async () => {
		const token = await pair();
		const controller = new AbortController();
		const res = await fetch(`${base}/api/events?token=${token}&session=live`, { signal: controller.signal });
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		let received = "";
		const until = async (needle: string) => {
			while (!received.includes(needle)) {
				const { value, done } = await reader.read();
				if (done) throw new Error("stream ended");
				received += decoder.decode(value);
			}
		};
		await until(": connected");
		appendFileSync(join(dir, "live.jsonl"), entry("u2", "u1", "more"));
		await until("event: messages");
		instances = [...instances, { id: "new", status: "online", cwd: "/p", external: true, activity: "idle" }];
		await until("event: sessions");
		// A pane going back with /tree moves its leaf without writing to the file.
		const signalled = received.split("event: messages").length;
		instances = instances.map((i) => (i.id === "live" ? { ...i, leafId: "u1" } : i));
		while (received.split("event: messages").length === signalled) {
			const { value, done } = await reader.read();
			if (done) throw new Error("stream ended");
			received += decoder.decode(value);
		}
		controller.abort();
	});

	it("requires a JSON content type on every POST", async () => {
		const { code } = store.createCode();
		const res = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ code, deviceName: "x" }),
		});
		expect(res.status).toBe(415);
		expect(await res.json()).toEqual({ error: "unsupported_media_type" });
		const token = await pair();
		const bare = await fetch(`${base}/api/sessions/live/abort`, { method: "POST", headers: auth(token) });
		expect(bare.status).toBe(415);
		expect(sent).toEqual([]);
	});

	it("answers 404 for a malformed percent-encoded session id", async () => {
		const token = await pair();
		const res = await fetch(`${base}/api/sessions/%E0%A4%A/messages`, { headers: auth(token) });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "unknown_session" });
	});

	describe("push subscriptions", () => {
		const p256dh = validP256dh();
		const auth16 = Buffer.alloc(16, 1).toString("base64url");
		const key = async (token: string) =>
			(await (await fetch(`${base}/api/push/key`, { headers: auth(token) })).json()) as {
				publicKey: string;
				subscribed: boolean;
			};
		const post = (token: string, path: string, body: object) =>
			fetch(`${base}/api/push/${path}`, { method: "POST", headers: authJson(token), body: JSON.stringify(body) });

		it("gives the VAPID public key, the same each time, only to a paired device", async () => {
			expect((await fetch(`${base}/api/push/key`)).status).toBe(401);
			const token = await pair();
			const first = await key(token);
			expect(Buffer.from(first.publicKey, "base64url")).toHaveLength(65);
			expect(first.subscribed).toBe(false);
			expect((await key(token)).publicKey).toBe(first.publicKey);
		});

		it("subscribes and unsubscribes the calling device only", async () => {
			const phone = await pair();
			const other = await pair();
			const subscription = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh, auth: auth16 } };
			const res = await post(phone, "subscribe", subscription);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
			expect(store.load().devices.map((d) => d.push)).toEqual([subscription, undefined]);
			expect((await key(phone)).subscribed).toBe(true);
			expect((await key(other)).subscribed).toBe(false);
			expect((await post(other, "unsubscribe", {})).status).toBe(200);
			expect(store.load().devices[0].push).toEqual(subscription);
			expect((await post(phone, "unsubscribe", {})).status).toBe(200);
			expect(store.load().devices[0].push).toBeUndefined();
		});

		it("refuses a subscription that is not a browser's", async () => {
			const token = await pair();
			const bad = [
				{},
				{ endpoint: "http://web.push.apple.com/abc", keys: { p256dh, auth: auth16 } },
				{ endpoint: "not a url", keys: { p256dh, auth: auth16 } },
				{ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: p256dh.slice(4), auth: auth16 } },
				{ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: `A${p256dh.slice(1)}`, auth: auth16 } },
				{ endpoint: "https://web.push.apple.com/abc", keys: { p256dh, auth: "short" } },
				{ endpoint: "https://web.push.apple.com/abc", keys: { p256dh, auth: `${auth16.slice(1)}!` } },
			];
			for (const body of bad) {
				const res = await post(token, "subscribe", body);
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({ error: "invalid_subscription" });
			}
			expect(store.load().devices[0].push).toBeUndefined();
		});
	});

	describe("event stream", () => {
		const open = async (token: string, session?: string) => {
			const controller = new AbortController();
			const query = session ? `&session=${session}` : "";
			const res = await fetch(`${base}/api/events?token=${token}${query}`, { signal: controller.signal });
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			// One read stays pending across calls: abandoning a timed-out read would swallow its chunk.
			let pending: ReturnType<typeof reader.read> | undefined;
			/** Everything that arrives within `ms`, or until the stream ends. */
			const collect = async (ms: number) => {
				let text = "";
				let ended = false;
				const deadline = Date.now() + ms;
				while (Date.now() < deadline) {
					const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), deadline - Date.now()));
					pending ??= reader.read();
					const next = await Promise.race([pending, timeout]);
					if (next === "timeout") break;
					pending = undefined;
					if (next.done) {
						ended = true;
						break;
					}
					text += decoder.decode(next.value);
				}
				return { text, ended };
			};
			return { collect, controller };
		};

		it("ignores a reordering of the same sessions, and still signals a real change", async () => {
			const token = await pair();
			const one = { ...instances[0], lastSeenAt: "2026-10-12T10:00:03Z" };
			const two: InstanceSummary = {
				id: "two",
				status: "online",
				cwd: "/p",
				external: true,
				activity: "working",
				lastSeenAt: "2026-10-12T10:00:00Z",
			};
			instances = [one, two];
			const { collect, controller } = await open(token);
			expect((await collect(200)).text).toContain(": connected");
			// Agent view sorts by recency, so a newer heartbeat on "two" swaps the rows.
			instances = [
				{ ...one, lastSeenAt: "2026-10-12T10:00:06Z" },
				{ ...two, lastSeenAt: "2026-10-12T10:00:09Z" },
			];
			expect((await collect(1500)).text).not.toContain("event: sessions");
			instances = [...instances, { id: "three", status: "online", cwd: "/p", external: true, activity: "idle" }];
			expect((await collect(2500)).text).toContain("event: sessions");
			controller.abort();
		});

		it("streams a watched session's live reply to the clients that have it open, and forgets it when they leave", async () => {
			const token = await pair();
			const watcher = await (async () => {
				const controller = new AbortController();
				const res = await fetch(`${base}/api/events?token=${token}&session=live`, { signal: controller.signal });
				const reader = res.body!.getReader();
				const decoder = new TextDecoder();
				let received = "";
				const until = async (needle: string) => {
					while (!received.includes(needle)) {
						const { value, done } = await reader.read();
						if (done) throw new Error("stream ended");
						received += decoder.decode(value);
					}
					return received;
				};
				return { until, controller };
			})();
			const bystander = await open(token);
			await watcher.until(": connected");
			expect(server.watching()).toEqual(new Set(["live"]));
			const snapshot = { text: "Hel", tools: [{ id: "c1", name: "bash", summary: "ls", running: true }] };
			server.live("live", snapshot);
			// Not watched: not kept, not sent.
			server.live("other", { text: "x", tools: [] });
			const sent = await watcher.until("event: live");
			expect(sent).toContain(`data: ${JSON.stringify({ sessionId: "live", live: snapshot })}`);
			server.live("live", null);
			await watcher.until(`data: ${JSON.stringify({ sessionId: "live", live: null })}`);
			expect((await bystander.collect(200)).text).not.toContain("event: live");

			// A client that opens the session mid-reply gets the reply so far at once.
			server.live("live", snapshot);
			const late = new AbortController();
			const res = await fetch(`${base}/api/events?token=${token}&session=live`, { signal: late.signal });
			const reader = res.body!.getReader();
			let text = "";
			while (!text.includes("event: live")) text += new TextDecoder().decode((await reader.read()).value);
			expect(text).toContain(JSON.stringify(snapshot));
			late.abort();

			watcher.controller.abort();
			bystander.controller.abort();
			for (let i = 0; i < 50 && server.watching().size > 0; i++) await new Promise((r) => setTimeout(r, 20));
			expect(server.watching()).toEqual(new Set());
			// Gone with its last watcher: a new one is not sent the old reply.
			const again = await open(token, "live");
			const first = (await again.collect(400)).text;
			expect(first).toContain(": connected");
			expect(first).not.toContain("event: live");
			again.controller.abort();
		});

		it("tells a watcher the reply ended even when the daemon kept no snapshot of it", async () => {
			const token = await pair();
			const watcher = await open(token, "live");
			expect((await watcher.collect(200)).text).toContain(": connected");
			server.live("live", null);
			expect((await watcher.collect(300)).text).toContain(
				`data: ${JSON.stringify({ sessionId: "live", live: null })}`,
			);
			watcher.controller.abort();
		});

		it("sends a revoked device no live reply, and closes its stream", async () => {
			const token = await pair();
			const watcher = await open(token, "live");
			expect((await watcher.collect(200)).text).toContain(": connected");
			store.revoke(store.load().devices[0].id);
			server.live("live", { text: "secret", tools: [] });
			const after = await watcher.collect(500);
			expect(after.text).not.toContain("event: live");
			expect(after.ended).toBe(true);
			watcher.controller.abort();
		});

		it("closes the stream of a device that was revoked", async () => {
			const token = await pair();
			const { collect, controller } = await open(token);
			await collect(200);
			store.revoke(store.load().devices[0].id);
			expect((await collect(2500)).ended).toBe(true);
			controller.abort();
		});
	});
});
