import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstanceSummary, PaneMessage } from "../daemon/ipc/protocol.ts";
import { BODY_MAX, PROMPT_MAX, type RemoteServer, startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";

const entry = (id: string, parentId: string | null, content: string) =>
	`${JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } })}\n`;

describe("remote HTTP API", () => {
	let dir: string;
	let store: RemoteStore;
	let server: RemoteServer;
	let base: string;
	let instances: InstanceSummary[];
	let sent: Array<{ id: string; message: PaneMessage }>;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-http-"));
		const web = join(dir, "web");
		mkdirSync(web);
		writeFileSync(join(web, "index.html"), "<!doctype html><title>bluclawd</title>");
		writeFileSync(join(web, "app.js"), "export {};");
		writeFileSync(join(dir, "live.jsonl"), entry("u1", null, "hello"));
		instances = [
			{ id: "live", status: "online", cwd: "/p", external: true, activity: "working", sessionFile: join(dir, "live.jsonl") },
			{ id: "stored", status: "stopped", cwd: "/p", sessionFile: join(dir, "stored.jsonl") },
		];
		sent = [];
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
		const res = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code, deviceName: "iPhone" }) });
		expect(res.status).toBe(200);
		return ((await res.json()) as { token: string }).token;
	}
	const auth = (token: string) => ({ authorization: `Bearer ${token}` });

	it("serves the PWA without a token, and nothing outside its directory", async () => {
		expect((await fetch(`${base}/`)).headers.get("content-type")).toContain("text/html");
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
		const res = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code: "abc", deviceName: "x" }) });
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
			headers: auth(token),
			body: JSON.stringify({ text: "next" }),
		});
		expect(prompt.status).toBe(202);
		const abort = await fetch(`${base}/api/sessions/live/abort`, { method: "POST", headers: auth(token) });
		expect(abort.status).toBe(202);
		expect(sent).toEqual([
			{ id: "live", message: { type: "prompt", text: "next" } },
			{ id: "live", message: { type: "abort" } },
		]);
	});

	it("refuses a stored session, an empty or oversized prompt, and an oversized body", async () => {
		const token = await pair();
		const post = (path: string, body: string) => fetch(`${base}${path}`, { method: "POST", headers: auth(token), body });
		expect((await post("/api/sessions/stored/prompt", JSON.stringify({ text: "hi" }))).status).toBe(409);
		expect((await post("/api/sessions/live/prompt", JSON.stringify({ text: "  " }))).status).toBe(400);
		expect((await post("/api/sessions/live/prompt", JSON.stringify({ text: "x".repeat(PROMPT_MAX + 1) }))).status).toBe(
			413,
		);
		expect((await post("/api/sessions/live/prompt", "x".repeat(BODY_MAX + 1))).status).toBe(413);
		expect(sent).toEqual([]);
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
		controller.abort();
	});
});
