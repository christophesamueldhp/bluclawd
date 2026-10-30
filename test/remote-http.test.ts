import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceSummary, PaneLaunch, PaneMessage, PaneReport } from "../daemon/ipc/protocol.ts";
import {
	BODY_MAX,
	IMAGE_MAX,
	IMAGES_MAX,
	PROMPT_BODY_MAX,
	PROMPT_MAX,
	type RemoteServer,
	startRemoteServer,
} from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import type { SessionSpec } from "../daemon/remote/spawn.ts";
import type { StatusLine } from "../daemon/remote/statusline.ts";
import { waitFor } from "./helpers/wait-for.ts";
import { validP256dh } from "./support/push.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({ SessionManager: { list: vi.fn() } }));

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
	let startFails: boolean;
	let terminalOpen: boolean;
	let reports: Map<string, PaneReport>;
	let statusExtra: StatusLine;
	let statusCwds: string[];
	let renders: Array<{ id: string; cwd: string; cols: number }>;
	let changed: unknown[][];

	beforeEach(async () => {
		vi.mocked(SessionManager.list).mockReset().mockResolvedValue([]);
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
				pane: "pi-live",
			},
			{ id: "stored", status: "stopped", cwd: "/p", sessionFile: join(dir, "stored.jsonl") },
		];
		sent = [];
		writeFileSync(join(dir, "pi.js"), "");
		launch = { command: [process.execPath, join(dir, "pi.js")] };
		started = [];
		startFails = false;
		terminalOpen = true;
		reports = new Map();
		statusExtra = {};
		statusCwds = [];
		renders = [];
		changed = [];
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
				terminalOpen: () => terminalOpen,
				report: (id) => reports.get(id),
				renameInstance: (id, name) => {
					changed.push(["rename", id, name]);
					return instances.some((i) => i.id === id && !i.external);
				},
				setPinned: (id, pinned) => {
					changed.push(["pin", id, pinned]);
					return instances.some((i) => i.id === id);
				},
				deleteInstance: (id) => {
					changed.push(["delete", id]);
					return instances.some((i) => i.id === id && !i.external);
				},
				statusLine: async (cwd) => {
					statusCwds.push(cwd);
					return statusExtra;
				},
				renderStatusline: async (session, report, cols) => {
					renders.push({ id: session.id, cwd: session.cwd, cols });
					return report.pistatusline ? [[{ text: `${cols} columns`, bold: true }]] : undefined;
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

	function saved(path: string, modified = 1): SessionInfo {
		return {
			path,
			id: path,
			cwd: dir,
			created: new Date(0),
			modified: new Date(modified),
			messageCount: 1,
			firstMessage: "Past conversation",
			allMessagesText: "",
		};
	}

	it("lists saved conversations newest first, including sessions absent from the rows", async () => {
		const token = await pair();
		vi.mocked(SessionManager.list).mockResolvedValue([
			saved(join(dir, "stored.jsonl")),
			{ ...saved(join(dir, "past.jsonl"), 2), name: "Saved task" },
			saved(join(dir, "live.jsonl")),
			{ ...saved(join(dir, "empty.jsonl")), messageCount: 0 },
		]);
		const res = await fetch(`${base}/api/sessions/past?cwd=${encodeURIComponent(dir)}`, { headers: auth(token) });
		expect(res.status).toBe(200);
		expect((await res.json()).sessions).toEqual([
			{ sessionFile: join(dir, "past.jsonl"), cwd: dir, label: "Saved task" },
			{ id: "stored", sessionFile: join(dir, "stored.jsonl"), cwd: dir, label: "Past conversation" },
		]);
		expect(SessionManager.list).toHaveBeenCalledWith(dir);
	});

	it("returns an explicit empty history", async () => {
		const token = await pair();
		const res = await fetch(`${base}/api/sessions/past?cwd=${encodeURIComponent(dir)}`, { headers: auth(token) });
		expect(await res.json()).toEqual({ sessions: [] });
	});

	it("resumes only a saved conversation from the requested directory without sending a prompt", async () => {
		const token = await pair();
		const sessionFile = join(dir, "past.jsonl");
		vi.mocked(SessionManager.list).mockResolvedValue([saved(sessionFile)]);
		const resume = (file: string) =>
			fetch(`${base}/api/sessions/resume`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify({ cwd: dir, sessionFile: file }),
			});
		expect((await resume("/arbitrary/file.jsonl")).status).toBe(404);
		expect((await resume(sessionFile)).status).toBe(201);
		expect(started).toEqual([{ cwd: dir, sessionFile, task: "", launch }]);
		instances.push({ id: "resumed", status: "online", external: true, cwd: dir, sessionFile });
		expect((await resume(sessionFile)).status).toBe(409);
		terminalOpen = false;
		expect((await resume(sessionFile)).status).toBe(409);
		expect(started).toHaveLength(1);
	});

	it("serves the PWA without a token, and nothing outside its directory", async () => {
		expect((await fetch(`${base}/`)).headers.get("content-type")).toContain("text/html");
		expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toContain("default-src 'self'");
		expect((await fetch(`${base}/app.js`)).status).toBe(200);
		expect((await fetch(`${base}/..%2Fremote.json`)).status).toBe(404);
		expect((await fetch(`${base}/missing.js`)).status).toBe(404);
	});

	it("answers only a loopback or tailnet Host, so a rebound DNS name reaches nothing", async () => {
		const get = (path: string, host: string) =>
			new Promise<{ status: number; body: string }>((resolve, reject) => {
				const req = request(`${base}${path}`, { headers: { host } }, (res) => {
					let body = "";
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
				});
				req.on("error", reject);
				req.end();
			});
		const port = server.port;
		for (const host of [
			`127.0.0.1:${port}`,
			"127.0.0.1",
			`localhost:${port}`,
			"LOCALHOST",
			`[::1]:${port}`,
			"mac.tail1234.ts.net",
			"Mac.Tail1234.TS.NET:443",
		]) {
			expect((await get("/", host)).status, host).toBe(200);
		}
		for (const host of ["evil.example", `evil.example:${port}`, "ts.net", "mac.ts.net.evil.example", "127.0.0.2"]) {
			for (const path of ["/", "/app.js", "/api/sessions", "/api/events?token=x"]) {
				expect(await get(path, host), `${host}${path}`).toEqual({ status: 421, body: '{"error":"bad_host"}' });
			}
		}
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

	it("pairs with the QR code's secret, once", async () => {
		const { secret } = store.createCode();
		const claim = () =>
			fetch(`${base}/api/pair`, {
				method: "POST",
				headers: json,
				body: JSON.stringify({ secret, deviceName: "iPhone" }),
			});
		const res = await claim();
		expect(res.status).toBe(200);
		const { token } = (await res.json()) as { token: string };
		expect((await fetch(`${base}/api/sessions`, { headers: auth(token) })).status).toBe(200);
		const again = await claim();
		expect(again.status).toBe(400);
		expect(await again.json()).toEqual({ error: "invalid_code" });
	});

	describe("handing a browser's pairing to its Home Screen app", () => {
		beforeEach(() => {
			writeFileSync(join(dir, "web", "manifest.webmanifest"), JSON.stringify({ name: "bluclawd", start_url: "/" }));
		});
		const handoffFor = async (token: string) => {
			const res = await fetch(`${base}/api/handoff`, { method: "POST", headers: authJson(token), body: "{}" });
			expect(res.status).toBe(200);
			return ((await res.json()) as { handoff: string }).handoff;
		};
		const exchange = (handoff: string) =>
			fetch(`${base}/api/pair/handoff`, {
				method: "POST",
				headers: json,
				body: JSON.stringify({ handoff, deviceName: "iPhone (Home Screen)" }),
			});

		it("gives a paired device a handoff, which pairs another device once", async () => {
			expect((await fetch(`${base}/api/handoff`, { method: "POST", headers: json, body: "{}" })).status).toBe(401);
			const token = await pair();
			const handoff = await handoffFor(token);
			const res = await exchange(handoff);
			expect(res.status).toBe(200);
			const { token: app } = (await res.json()) as { token: string };
			expect(app).not.toBe(token);
			for (const t of [token, app])
				expect((await fetch(`${base}/api/sessions`, { headers: auth(t) })).status).toBe(200);
			expect(store.load().devices.map((d) => d.name)).toEqual(["iPhone", "iPhone (Home Screen)"]);
			const again = await exchange(handoff);
			expect(again.status).toBe(400);
			expect(await again.json()).toEqual({ error: "invalid_handoff" });
		});

		it("refuses the handoff of a device removed since", async () => {
			const token = await pair();
			const handoff = await handoffFor(token);
			store.revoke(store.load().devices[0]!.id);
			expect((await exchange(handoff)).status).toBe(400);
		});

		it("serves the manifest with the handoff as its start_url, uncached; any other query gets the plain one", async () => {
			const handoff = await handoffFor(await pair());
			const res = await fetch(`${base}/manifest.webmanifest?handoff=${handoff}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/manifest+json");
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(await res.json()).toEqual({ name: "bluclawd", start_url: `/#handoff=${handoff}` });
			for (const query of ["", "?handoff=", "?handoff=short", `?handoff=${handoff}%22`, "?other=1"]) {
				const plain = await fetch(`${base}/manifest.webmanifest${query}`);
				expect(plain.headers.get("cache-control"), query).toBe("no-cache");
				expect(await plain.json(), query).toEqual({ name: "bluclawd", start_url: "/" });
			}
		});
	});

	describe("paired devices", () => {
		it("lists them, marking the one asking, with neither token hashes nor push endpoints", async () => {
			const phone = await pair();
			const pad = await pair();
			store.setPush(store.authenticate(pad)!.id, {
				endpoint: "https://web.push.apple.com/secret",
				keys: { p256dh: validP256dh(), auth: "AAAAAAAAAAAAAAAAAAAAAA" },
			});
			expect((await fetch(`${base}/api/devices`)).status).toBe(401);
			const res = await fetch(`${base}/api/devices`, { headers: auth(phone) });
			expect(res.status).toBe(200);
			const text = await res.text();
			for (const secret of [
				"tokenHash",
				"push",
				"web.push.apple.com",
				...store.load().devices.map((d) => d.tokenHash),
			]) {
				expect(text).not.toContain(secret);
			}
			const [first, second] = store.load().devices;
			expect(JSON.parse(text)).toEqual({
				devices: [
					{
						id: first!.id,
						name: "iPhone",
						createdAt: first!.createdAt,
						lastUsedAt: first!.lastUsedAt,
						current: true,
					},
					{
						id: second!.id,
						name: "iPhone",
						createdAt: second!.createdAt,
						lastUsedAt: second!.lastUsedAt,
						current: false,
					},
				],
			});
		});

		it("lets a phone disconnect only itself, which can then do nothing: the Mac removes the others", async () => {
			const phone = await pair();
			const pad = await pair();
			const [phoneId, padId] = store.load().devices.map((d) => d.id);
			const remove = (token: string, id: string) =>
				fetch(`${base}/api/devices/${encodeURIComponent(id!)}`, { method: "DELETE", headers: auth(token) });
			expect((await fetch(`${base}/api/devices/${padId}`, { method: "DELETE" })).status).toBe(401);
			const refused = await remove(phone, padId!);
			expect(refused.status).toBe(403);
			expect(await refused.json()).toEqual({ error: "forbidden" });
			expect((await remove(phone, "unknown")).status).toBe(403);
			expect((await fetch(`${base}/api/devices/%`, { method: "DELETE", headers: auth(phone) })).status).toBe(404);
			expect((await fetch(`${base}/api/sessions`, { headers: auth(pad) })).status).toBe(200);
			expect((await remove(phone, phoneId!)).status).toBe(200);
			expect((await fetch(`${base}/api/sessions`, { headers: auth(phone) })).status).toBe(401);
			expect(store.load().devices.map((d) => d.id)).toEqual([padId]);
		});
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

	it("answers each refusal phone control gives with its status", async () => {
		const token = await pair();
		const ask = async (method: string, path: string, body?: object) => {
			const res = await fetch(`${base}/api/sessions/${path}`, {
				method,
				headers: authJson(token),
				...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
			});
			return [res.status, ((await res.json()) as { error?: string }).error];
		};
		expect(await ask("POST", "live/model", { provider: "openai", id: "gpt-5" })).toEqual([409, "pane_too_old"]);
		reports.set("live", {
			models: [{ provider: "openai", id: "gpt-5" }],
			thinkingLevels: ["off"],
			trust: "always",
			commands: [{ name: "compact", source: "builtin" }],
			tasks: [{ id: "f2", kind: "shell", label: "sleep 60", startedAt: 2, foreground: true }],
		});
		expect(await ask("POST", "live/prompt", { text: "/compact" })).toEqual([409, "session_busy"]);
		instances[0]!.activity = "idle";
		instances[0]!.draft = true;
		expect(await ask("POST", "live/prompt", { text: "/compact" })).toEqual([409, "unsent_draft"]);
		for (const [method, path, body, status, error] of [
			["POST", "stored/prompt", { text: "hi" }, 409, "session_not_running"],
			["DELETE", "live", undefined, 409, "session_running"],
			["POST", "live/prompt", { text: "/settings" }, 400, "command_refused"],
			["POST", "live/model", {}, 400, "invalid_model"],
			["POST", "live/thinking", { level: "xhigh" }, 400, "invalid_thinking"],
			["POST", "live/trust", { trust: "sometimes" }, 400, "invalid_trust"],
			["POST", "stored/rename", { name: "" }, 400, "invalid_name"],
			["POST", "stored/pin", { pinned: "true" }, 400, "invalid_pinned"],
			["POST", "live/tasks/b9/stop", {}, 404, "unknown_task"],
			["GET", "live/tasks/f2/output", undefined, 404, "no_output"],
		] as const) {
			expect(await ask(method, path, body), `${method} ${path}`).toEqual([status, error]);
		}
		expect(sent).toEqual([]);
		expect(changed).toEqual([]);
	});

	describe("slash commands", () => {
		const send = async (text: string, id = "live", images?: object[]) => {
			const token = await pair();
			const res = await fetch(`${base}/api/sessions/${id}/prompt`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify({ text, ...(images ? { images } : {}) }),
			});
			return [res.status, ((await res.json()) as { error?: string }).error];
		};
		const commands = [
			{ name: "compact", source: "builtin" as const },
			{ name: "skill:pdf", source: "skill" as const },
		];

		it("has an idle pane type one into its prompt, as on the Mac, and lists the pane's commands", async () => {
			instances[0]!.activity = "idle";
			reports.set("live", { models: [], commands });
			expect(await send("/compact keep the notes")).toEqual([202, undefined]);
			expect(await send("  /skill:pdf report.pdf")).toEqual([202, undefined]);
			expect(sent.map((s) => s.message)).toEqual([
				{ type: "command", text: "/compact keep the notes" },
				{ type: "command", text: "  /skill:pdf report.pdf" },
			]);
			const token = await pair();
			const list = await fetch(`${base}/api/sessions/live/commands`, { headers: auth(token) });
			expect(await list.json()).toEqual({ commands });
			// The status, fetched after every report, leaves them out.
			const status = await fetch(`${base}/api/sessions/live/status`, { headers: auth(token) });
			expect((await status.json()) as object).toEqual({ report: { models: [] } });
		});
	});

	describe("background tasks", () => {
		it("lists a pane's tasks in its status, keeping their output files on the Mac", async () => {
			const token = await pair();
			const output = join(dir, "b1.output");
			reports.set("live", {
				models: [],
				tasks: [
					{ id: "b1", kind: "shell", label: "npm run dev", startedAt: 1, outputFile: output },
					{ id: "f2", kind: "shell", label: "sleep 60", startedAt: 2, foreground: true },
				],
			});
			const res = await fetch(`${base}/api/sessions/live/status`, { headers: auth(token) });
			expect(((await res.json()) as { report: object }).report).toEqual({
				models: [],
				tasks: [
					{ id: "b1", kind: "shell", label: "npm run dev", startedAt: 1, output: true },
					{ id: "f2", kind: "shell", label: "sleep 60", startedAt: 2, foreground: true },
				],
			});
		});

		it("gives a task's output tail as /tasks shows it, and stops a task the pane reported", async () => {
			const token = await pair();
			const output = join(dir, "b1.output");
			const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
			writeFileSync(output, `${"x".repeat(9000)}\n${lines.join("\n")}\n\x1b[31mred\x1b[0m\r\n`);
			reports.set("live", {
				models: [],
				tasks: [
					{ id: "b1", kind: "shell", label: "npm run dev", startedAt: 1, outputFile: output },
					{ id: "f2", kind: "shell", label: "sleep 60", startedAt: 2, foreground: true },
				],
			});
			const tail = await fetch(`${base}/api/sessions/live/tasks/b1/output`, { headers: auth(token) });
			expect(await tail.json()).toEqual({ lines: [...lines.slice(-8), "red"], size: expect.any(Number) });
			const none = await fetch(`${base}/api/sessions/live/tasks/f2/output`, { headers: auth(token) });
			expect([none.status, await none.json()]).toEqual([404, { error: "no_output" }]);
			const stop = (task: string, id = "live") =>
				fetch(`${base}/api/sessions/${id}/tasks/${task}/stop`, { method: "POST", headers: authJson(token) });
			expect((await stop("f2")).status).toBe(202);
			expect(sent).toEqual([{ id: "live", message: { type: "stop_task", id: "f2" } }]);
			const unknown = await stop("b9");
			expect([unknown.status, await unknown.json()]).toEqual([404, { error: "unknown_task" }]);
			expect((await stop("b1", "stored")).status).toBe(404);
			expect((await stop("../x")).status).toBe(404);
			const get = await fetch(`${base}/api/sessions/live/tasks/b1/stop`, { headers: auth(token) });
			expect(get.status).toBe(405);
			expect(sent).toHaveLength(1);
		});
	});

	describe("images", () => {
		const magic: Record<string, number[]> = {
			"image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
			"image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			"image/gif": [...Buffer.from("GIF89a")],
			"image/webp": [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")],
		};
		const image = (mimeType: string, size = 64) => {
			const bytes = Buffer.alloc(size, 1);
			bytes.set(magic[mimeType]!);
			return { mimeType, data: bytes.toString("base64") };
		};
		const prompt = async (id: string, body: object) => {
			const token = await pair();
			const res = await fetch(`${base}/api/sessions/${id}/prompt`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify(body),
			});
			return [res.status, ((await res.json()) as { error?: string }).error];
		};

		it("queues a running session's prompt with up to four images of each type, as large as 2 MB each", async () => {
			const images = Object.keys(magic).map((type) => image(type));
			expect(await prompt("live", { text: "look", images })).toEqual([202, undefined]);
			// Four at the limit: past the plain body limit.
			const large = Array.from({ length: IMAGES_MAX }, () => image("image/jpeg", IMAGE_MAX));
			expect(await prompt("live", { text: "big", images: large })).toEqual([202, undefined]);
			expect(sent).toEqual([
				{ id: "live", message: { type: "prompt", text: "look", images } },
				{ id: "live", message: { type: "prompt", text: "big", images: large } },
			]);
		});

		it("refuses an image that is not base64 of what its type says, too many, or one over 2 MB", async () => {
			const png = image("image/png");
			expect(await prompt("live", { text: "x", images: [{ ...png, mimeType: "image/jpeg" }] })).toEqual([
				400,
				"invalid_image",
			]);
			expect(await prompt("live", { text: "x", images: [{ ...png, mimeType: "image/svg+xml" }] })).toEqual([
				400,
				"invalid_image",
			]);
			expect(await prompt("live", { text: "x", images: [{ ...png, data: `${png.data.slice(1)}!` }] })).toEqual([
				400,
				"invalid_image",
			]);
			expect(await prompt("live", { text: "x", images: [{ mimeType: "image/png" }] })).toEqual([
				400,
				"invalid_image",
			]);
			expect(await prompt("live", { text: "x", images: png })).toEqual([400, "invalid_image"]);
			expect(await prompt("live", { text: "x", images: Array(IMAGES_MAX + 1).fill(png) })).toEqual([
				400,
				"invalid_image",
			]);
			expect(await prompt("live", { text: "x", images: [image("image/png", 2 * 1024 * 1024 + 1)] })).toEqual([
				413,
				"image_too_large",
			]);
			expect(sent).toEqual([]);
		});

		it("refuses images for a new session, which takes its prompt as an argument", async () => {
			const token = await pair();
			const res = await fetch(`${base}/api/sessions`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify({ cwd: dir, task: "go", images: [image("image/png")] }),
			});
			expect([res.status, ((await res.json()) as { error?: string }).error]).toEqual([400, "images_need_running"]);
			expect(started).toEqual([]);
			expect(sent).toEqual([]);
		});

		it("keeps the plain body limit on every other route", async () => {
			const token = await pair();
			const res = await fetch(`${base}/api/sessions/live/abort`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify({ pad: "x".repeat(BODY_MAX) }),
			});
			expect(res.status).toBe(413);
		});
	});

	describe("status, model and compact", () => {
		const report: PaneReport = {
			model: { provider: "anthropic", id: "claude-opus", name: "Opus" },
			models: [
				{ provider: "anthropic", id: "claude-opus", name: "Opus" },
				{ provider: "openai", id: "gpt-5", name: "GPT-5" },
			],
			thinkingLevel: "high",
			context: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
			usage: { input: 150, output: 25, cacheRead: 0, cacheWrite: 0, cost: 0.75 },
		};

		it("gives a running session's latest report, and none before it has sent one", async () => {
			const token = await pair();
			const status = () => fetch(`${base}/api/sessions/live/status`, { headers: auth(token) });
			const before = await status();
			expect(before.status).toBe(404);
			expect(await before.json()).toEqual({ error: "no_status" });
			reports.set("live", report);
			const after = await status();
			expect(after.status).toBe(200);
			expect(await after.json()).toEqual({ report });
			reports.set("stored", report);
			expect((await fetch(`${base}/api/sessions/stored/status`, { headers: auth(token) })).status).toBe(404);
			expect(
				(await fetch(`${base}/api/sessions/live/status`, { method: "POST", headers: authJson(token) })).status,
			).toBe(405);
		});

		it("switches a running session to a model it offers", async () => {
			reports.set("live", report);
			const token = await pair();
			const res = await fetch(`${base}/api/sessions/live/model`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify({ provider: "openai", id: "gpt-5" }),
			});
			expect(res.status).toBe(202);
			expect(sent).toEqual([{ id: "live", message: { type: "set_model", provider: "openai", id: "gpt-5" } }]);
		});

		it("has no way to rewrite a session's history: no tree, fork, clone or compact", async () => {
			reports.set("live", report);
			const token = await pair();
			for (const action of ["tree", "fork", "clone", "compact"]) {
				const res = await fetch(`${base}/api/sessions/live/${action}`, {
					method: "POST",
					headers: authJson(token),
					body: JSON.stringify({ entryId: "bbbb0002" }),
				});
				expect(res.status, action).toBe(404);
			}
			expect(sent).toEqual([]);
		});

		it("adds the git state of the session's own directory to its report", async () => {
			reports.set("live", report);
			statusExtra = {
				git: { branch: "main", owner: "christophe", added: 3, removed: 1 },
			};
			const token = await pair();
			const res = await fetch(`${base}/api/sessions/live/status`, { headers: auth(token) });
			expect(await res.json()).toEqual({ report: { ...report, ...statusExtra } });
			expect(statusCwds).toEqual(["/p"]);
		});

		it("draws the pane's pistatusline at the width the phone asks for, in place of the git state", async () => {
			const paths = { worker: "/pi/dist/render-worker.js", config: "/agent/pistatusline/settings.json" };
			reports.set("live", { ...report, pistatusline: paths });
			statusExtra = { git: { branch: "main", added: 0, removed: 0 } };
			const token = await pair();
			const status = async (query: string) =>
				(await (await fetch(`${base}/api/sessions/live/status${query}`, { headers: auth(token) })).json()) as {
					report: Record<string, unknown>;
				};
			expect((await status("?cols=52")).report).toEqual({
				...report,
				statusline: { lines: [[{ text: "52 columns", bold: true }]] },
			});
			expect(renders).toEqual([{ id: "live", cwd: "/p", cols: 52 }]);
			expect(statusCwds).toEqual([]);
			// Kept to what a phone may ask for; no width, or none that parses, is the plain status.
			expect((await status("?cols=999")).report.statusline).toEqual({
				lines: [[{ text: "200 columns", bold: true }]],
			});
			expect((await status("?cols=5")).report.statusline).toEqual({ lines: [[{ text: "20 columns", bold: true }]] });
			for (const query of ["", "?cols=wide", "?cols=-1"]) {
				expect((await status(query)).report).toEqual({ ...report, ...statusExtra });
			}
			expect(renders).toHaveLength(3);
			// A pane without pistatusline, or one it could not render: the git state as before.
			reports.set("live", report);
			expect((await status("?cols=52")).report).toEqual({ ...report, ...statusExtra });
		});

		const post = async (token: string, id: string, action: string, body: unknown) => {
			const res = await fetch(`${base}/api/sessions/${id}/${action}`, {
				method: "POST",
				headers: authJson(token),
				body: JSON.stringify(body),
			});
			return [res.status, await res.json()];
		};

		it("sets a thinking level the running session's model offers, even mid-turn", async () => {
			reports.set("live", { ...report, thinkingLevels: ["off", "low", "medium", "high"] });
			const token = await pair();
			expect(await post(token, "live", "thinking", { level: "low" })).toEqual([202, { ok: true }]);
			expect(sent).toEqual([{ id: "live", message: { type: "set_thinking", level: "low" } }]);
		});

		it("sets the trust mode through a running session that reports it", async () => {
			reports.set("live", { ...report, trust: "always" });
			const token = await pair();
			expect(await post(token, "live", "trust", { trust: "ask" })).toEqual([202, { ok: true }]);
			expect(sent).toEqual([{ id: "live", message: { type: "set_trust", trust: "ask" } }]);
		});
	});

	describe("rename, pin and delete", () => {
		const call = async (token: string, method: string, path: string, body?: object) => {
			const res = await fetch(`${base}/api/sessions/${path}`, {
				method,
				headers: authJson(token),
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			return [res.status, await res.json()];
		};

		it("renames a running session through its pane, an older one's too, and a stored one in the daemon", async () => {
			const token = await pair();
			expect(reports.has("live")).toBe(false);
			expect(await call(token, "POST", "live/rename", { name: "  fix the build  " })).toEqual([202, { ok: true }]);
			expect(sent).toEqual([{ id: "live", message: { type: "rename", name: "fix the build" } }]);
			expect(await call(token, "POST", "stored/rename", { name: "later" })).toEqual([200, { ok: true }]);
			expect(changed).toEqual([["rename", "stored", "later"]]);
		});

		it("pins and unpins a running or stored session", async () => {
			const token = await pair();
			expect(await call(token, "POST", "live/pin", { pinned: true })).toEqual([200, { ok: true }]);
			expect(await call(token, "POST", "stored/pin", { pinned: false })).toEqual([200, { ok: true }]);
			expect(await call(token, "POST", "nope/pin", { pinned: true })).toEqual([404, { error: "unknown_session" }]);
			expect(changed).toEqual([
				["pin", "live", true],
				["pin", "stored", false],
			]);
			expect(sent).toEqual([]);
		});

		it("deletes a stored row, never a running session's", async () => {
			const token = await pair();
			expect(await call(token, "DELETE", "live")).toEqual([409, { error: "session_running" }]);
			expect(await call(token, "DELETE", "stored")).toEqual([200, { ok: true }]);
			expect(await call(token, "DELETE", "nope")).toEqual([404, { error: "unknown_session" }]);
			expect(await call(token, "DELETE", "%E0%A4%A")).toEqual([404, { error: "unknown_session" }]);
			expect(changed).toEqual([["delete", "stored"]]);
		});

		it("needs a paired device's token for each", async () => {
			const unauthorized = (method: string, path: string) =>
				fetch(`${base}/api/sessions/${path}`, {
					method,
					headers: json,
					body: method === "POST" ? "{}" : undefined,
				});
			expect((await unauthorized("POST", "stored/rename")).status).toBe(401);
			expect((await unauthorized("POST", "stored/pin")).status).toBe(401);
			expect((await unauthorized("DELETE", "stored")).status).toBe(401);
			expect(changed).toEqual([]);
		});
	});

	describe("models for a new session", () => {
		const models = async (token: string) =>
			(await (await fetch(`${base}/api/models`, { headers: auth(token) })).json()) as {
				models: Array<{ provider: string; id: string; name?: string }>;
			};

		it("lists every running pane's models once, sorted, and none before any pane reported", async () => {
			const token = await pair();
			expect(await models(token)).toEqual({ models: [] });
			instances = [...instances, { id: "two", status: "online", cwd: "/p", external: true, activity: "idle" }];
			const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" };
			const gpt = { provider: "openai", id: "gpt-5" };
			const sonnet = { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" };
			reports.set("live", { models: [gpt, opus] });
			reports.set("two", { models: [opus, sonnet] });
			// A stored row's report is a pane's that went: not listed.
			reports.set("stored", { models: [{ provider: "old", id: "gone" }] });
			expect(await models(token)).toEqual({ models: [opus, sonnet, gpt] });
			expect((await fetch(`${base}/api/models`)).status).toBe(401);
		});

		it("starts a new session with any model it lists", async () => {
			const token = await pair();
			reports.set("live", {
				models: [
					{ provider: "openrouter", id: "anthropic/claude-opus-5-5:beta" },
					{ provider: "anthropic", id: "claude-opus-5-5" },
				],
			});
			for (const { provider, id } of (await models(token)).models) {
				const res = await fetch(`${base}/api/sessions`, {
					method: "POST",
					headers: authJson(token),
					body: JSON.stringify({ cwd: dir, task: "go", model: `${provider}/${id}` }),
				});
				expect(res.status).toBe(201);
			}
			expect(started.map((s) => s.model)).toEqual([
				"anthropic/claude-opus-5-5",
				"openrouter/anthropic/claude-opus-5-5:beta",
			]);
		});
	});

	it("only reads while no terminal on the Mac shows pi", async () => {
		const token = await pair();
		const list = async () =>
			(await (await fetch(`${base}/api/sessions`, { headers: auth(token) })).json()) as {
				terminalOpen: boolean;
			};
		expect((await list()).terminalOpen).toBe(true);
		terminalOpen = false;
		expect((await list()).terminalOpen).toBe(false);
		const send = async (method: string, path: string, body?: object) => {
			const res = await fetch(`${base}${path}`, {
				method,
				headers: authJson(token),
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			return [res.status, ((await res.json()) as { error?: string }).error];
		};
		for (const [method, path, body] of [
			["POST", "/api/sessions/live/prompt", { text: "hi" }],
			["POST", "/api/sessions/live/abort", {}],
			["POST", "/api/sessions/live/keys", { keys: ["Enter"] }],
			["POST", "/api/sessions", { cwd: dir, task: "go" }],
			["DELETE", "/api/sessions/stored", undefined],
		] as const) {
			expect(await send(method, path, body), path).toEqual([409, "pi_not_open"]);
		}
		expect(sent).toEqual([]);
		expect(started).toEqual([]);
		expect(changed).toEqual([]);
		const messages = await fetch(`${base}/api/sessions/live/messages`, { headers: auth(token) });
		expect(messages.status).not.toBe(409);
	});

	it("refuses an empty or oversized prompt, and an oversized body", async () => {
		const token = await pair();
		const post = (path: string, body: string) =>
			fetch(`${base}${path}`, { method: "POST", headers: authJson(token), body });
		expect((await post("/api/sessions/live/prompt", JSON.stringify({ text: "  " }))).status).toBe(400);
		expect(
			(await post("/api/sessions/live/prompt", JSON.stringify({ text: "x".repeat(PROMPT_MAX + 1) }))).status,
		).toBe(413);
		expect((await post("/api/sessions/live/prompt", "x".repeat(PROMPT_BODY_MAX + 1))).status).toBe(413);
		expect(sent).toEqual([]);
		expect(started).toEqual([]);
	});

	it("starts a new session in a directory", async () => {
		const token = await pair();
		const start = (body: object) =>
			fetch(`${base}/api/sessions`, { method: "POST", headers: authJson(token), body: JSON.stringify(body) });
		const res = await start({ cwd: dir, task: "  fix the build ", model: "anthropic/claude-opus-5-5" });
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ pane: "pi-0000000a" });
		expect((await start({ cwd: dir, task: "go" })).status).toBe(201);
		// No pane lists its commands yet: a new session starts with none.
		const command = await start({ cwd: dir, task: "/settings" });
		expect([command.status, await command.json()]).toEqual([400, { error: "command_refused" }]);
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
		// A pi upgraded since its pane started may have moved: its pane would die at once.
		for (const command of [
			[join(dir, "old-node"), join(dir, "pi.js")],
			[process.execPath, join(dir, "old-pi.js")],
		]) {
			launch = { command };
			expect(await start({ cwd: dir, task: "go" })).toEqual([503, "no_launch"]);
		}
		launch = undefined;
		expect(await start({ cwd: dir, task: "go" })).toEqual([503, "no_launch"]);
		expect(started).toEqual([]);
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

	it("answers start_failed when a new session's pane fails to start", async () => {
		startFails = true;
		const token = await pair();
		const res = await fetch(`${base}/api/sessions`, {
			method: "POST",
			headers: authJson(token),
			body: JSON.stringify({ cwd: dir, task: "go" }),
		});
		expect([res.status, await res.json()]).toEqual([500, { error: "start_failed" }]);
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

	it("completes a typed directory path with the folders it may go on to", async () => {
		for (const name of ["Projects", "photos", ".config", "Public"]) mkdirSync(join(dir, name));
		writeFileSync(join(dir, "plan.txt"), "");
		const token = await pair();
		const complete = async (under: string) =>
			(
				await (
					await fetch(`${base}/api/directories?under=${encodeURIComponent(under)}`, { headers: auth(token) })
				).json()
			).directories;
		const home = process.env.HOME;
		process.env.HOME = dir;
		try {
			// Whatever the case, folders only, the hidden ones once a "." is typed.
			expect(await complete("~/p")).toEqual(["photos", "Projects", "Public"].map((n) => join(dir, n)));
			expect(await complete(`${dir}/pr`)).toEqual([join(dir, "Projects")]);
			expect(await complete("~/.c")).toEqual([join(dir, ".config")]);
			expect(await complete("~/Projects/")).toEqual([]);
			expect(await complete("~/missing/x")).toEqual([]);
			expect(await complete("relative")).toEqual([]);
		} finally {
			process.env.HOME = home;
		}
	});

	it("pages a transcript back from a message, and says whether older ones are left", async () => {
		const ids = ["a1a1a1a1", "b2b2b2b2", "c3c3c3c3", "d4d4d4d4"];
		writeFileSync(join(dir, "live.jsonl"), ids.map((id, i) => entry(id, i ? ids[i - 1] : null, `m${i}`)).join(""));
		const token = await pair();
		const page = async (query: string) => {
			const res = await fetch(`${base}/api/sessions/live/messages?${query}`, { headers: auth(token) });
			const body = (await res.json()) as { messages?: Array<{ id: string }>; more?: boolean; error?: string };
			return { status: res.status, ids: body.messages?.map((m) => m.id), more: body.more, error: body.error };
		};
		expect(await page("limit=2")).toMatchObject({ ids: ["c3c3c3c3", "d4d4d4d4"], more: true });
		expect(await page("limit=2&before=c3c3c3c3")).toMatchObject({ ids: ["a1a1a1a1", "b2b2b2b2"], more: false });
		expect(await page("limit=1&before=c3c3c3c3")).toMatchObject({ ids: ["b2b2b2b2"], more: true });
		expect(await page("before=a1a1a1a1")).toMatchObject({ status: 200, ids: [], more: false });
		// Not on the branch (it moved since the page was loaded): nothing older to show from there.
		expect(await page("before=e5e5e5e5")).toMatchObject({ status: 200, ids: [], more: false });
		expect(await page("before=..%2Fx")).toMatchObject({ status: 400, error: "invalid_entry" });
		expect(await page("limit=100000")).toMatchObject({ ids: ids, more: false });
	});

	describe("a transcript's images", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const line = (id: string, parentId: string | null, role: string, content: unknown[]) =>
			`${JSON.stringify({ type: "message", id, parentId, message: { role, content, toolName: "read" } })}\n`;
		const image = (mimeType: string, data = png) => ({ type: "image", mimeType, data: data.toString("base64") });

		beforeEach(() => {
			writeFileSync(
				join(dir, "live.jsonl"),
				line("aaaaaaaa", null, "user", [{ type: "text", text: "look" }, image("image/png")]) +
					line("bbbbbbbb", "aaaaaaaa", "toolResult", [{ type: "text", text: "Read" }, image("image/svg+xml")]) +
					line("cccccccc", "bbbbbbbb", "user", [{ type: "text", text: "on" }]) +
					line("dddddddd", "aaaaaaaa", "user", [image("image/png")]),
			);
			instances = [{ ...instances[0], leafId: "cccccccc" }, instances[1]];
		});
		const get = (path: string, token?: string) =>
			fetch(`${base}/api/sessions/${path}`, token ? { headers: auth(token) } : undefined);

		it("serves one as its type, privately cached and never sniffed", async () => {
			const token = await pair();
			const res = await get("live/images/aaaaaaaa/0", token);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("image/png");
			expect(res.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
		});

		it("needs a paired device's token", async () => {
			expect((await get("live/images/aaaaaaaa/0")).status).toBe(401);
			expect((await get("live/images/aaaaaaaa/0", "bogus")).status).toBe(401);
		});

		it("finds only an image on the session's branch, of a type the phone shows", async () => {
			const token = await pair();
			const status = async (path: string) => {
				const res = await get(path, token);
				return [res.status, ((await res.json()) as { error: string }).error];
			};
			expect(await status("live/images/aaaaaaaa/1")).toEqual([404, "unknown_image"]);
			expect(await status("live/images/cccccccc/0")).toEqual([404, "unknown_image"]);
			expect(await status("live/images/eeeeeeee/0")).toEqual([404, "unknown_image"]);
			// On the branch the pane left.
			expect(await status("live/images/dddddddd/0")).toEqual([404, "unknown_image"]);
			expect(await status("live/images/bbbbbbbb/0")).toEqual([415, "unsupported_image"]);
			expect(await status("nope/images/aaaaaaaa/0")).toEqual([404, "unknown_session"]);
			expect(await status("stored/images/aaaaaaaa/0")).toEqual([404, "unknown_image"]);
			expect(await status("live/images/aaaaaaaa/-1")).toEqual([404, "not_found"]);
			expect(await status("live/images/..%2Fx/0")).toEqual([404, "not_found"]);
			expect(await status("live/images/aaaaaaaa/99999")).toEqual([404, "not_found"]);
			const post = await fetch(`${base}/api/sessions/live/images/aaaaaaaa/0`, {
				method: "POST",
				headers: authJson(token),
				body: "{}",
			});
			expect(post.status).toBe(405);
		});
	});

	it("gives an edit's diff with its result, and a tool result's whole output on request", async () => {
		const result = (id: string, parentId: string, text: string, details?: object) =>
			`${JSON.stringify({ type: "message", id, parentId, message: { role: "toolResult", toolName: "edit", content: [{ type: "text", text }], details } })}\n`;
		writeFileSync(
			join(dir, "live.jsonl"),
			entry("aaaaaaaa", null, "go") +
				result("bbbbbbbb", "aaaaaaaa", "Successfully replaced 1 block(s).", { diff: "-a\n+b" }) +
				result("cccccccc", "bbbbbbbb", "z".repeat(5000)),
		);
		const token = await pair();
		const get = async (path: string, init?: RequestInit) => {
			const res = await fetch(`${base}/api/sessions/${path}`, { headers: auth(token), ...init });
			return [res.status, await res.json()];
		};
		const [, page] = (await get("live/messages")) as [number, { messages: Array<Record<string, unknown>> }];
		expect(page.messages[1]).toMatchObject({ id: "bbbbbbbb", diff: "-a\n+b", diffTruncated: false });
		expect(page.messages[2]).toMatchObject({ id: "cccccccc", truncated: true });
		expect(await get("live/messages/cccccccc/output")).toEqual([200, { text: "z".repeat(5000), truncated: false }]);
		expect(await get("live/messages/aaaaaaaa/output")).toEqual([404, { error: "unknown_entry" }]);
		expect(await get("live/messages/eeeeeeee/output")).toEqual([404, { error: "unknown_entry" }]);
		expect(await get("nope/messages/cccccccc/output")).toEqual([404, { error: "unknown_session" }]);
		expect(await get("live/messages/x/output")).toEqual([404, { error: "not_found" }]);
		expect((await fetch(`${base}/api/sessions/live/messages/cccccccc/output`)).status).toBe(401);
		const post = await get("live/messages/cccccccc/output", {
			method: "POST",
			headers: authJson(token),
			body: "{}",
		});
		expect(post).toEqual([405, { error: "method_not_allowed" }]);
	});

	it("reads a running session's transcript from the leaf it reports", async () => {
		appendFileSync(join(dir, "live.jsonl"), entry("u2", "u1", "gone back from"));
		instances = [{ ...instances[0], leafId: "u1" }];
		const token = await pair();
		const res = await fetch(`${base}/api/sessions/live/messages`, { headers: auth(token) });
		expect(((await res.json()) as { messages: Array<{ id: string }> }).messages.map((m) => m.id)).toEqual(["u1"]);
	});

	it("reads an empty transcript for a running session whose file pi has not written yet", async () => {
		instances = [{ ...instances[0], activity: "idle", sessionFile: join(dir, "forked.jsonl") }];
		const token = await pair();
		const res = await fetch(`${base}/api/sessions/live/messages`, { headers: auth(token) });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ messages: [], more: false });
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

		it("ends the reply of a pane that went away mid-reply without saying so", async () => {
			const token = await pair();
			const watcher = await open(token, "live");
			expect((await watcher.collect(200)).text).toContain(": connected");
			const snapshot = { text: "Hel", tools: [] };
			server.live("live", snapshot);
			expect((await watcher.collect(200)).text).toContain(JSON.stringify({ sessionId: "live", live: snapshot }));
			// Reaped from the list: it died without unregistering.
			instances = instances.filter((i) => i.id !== "live");
			expect((await watcher.collect(1500)).text).toContain(JSON.stringify({ sessionId: "live", live: null }));
			const late = await open(token, "live");
			expect((await late.collect(300)).text).not.toContain("event: live");
			late.controller.abort();
			watcher.controller.abort();
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
			// The device whose streams they are, the bystander's (no session) too.
			expect(server.present()).toEqual(new Set([store.load().devices[0]!.id]));
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
			await waitFor(() => server.watching().size === 0);
			expect(server.watching()).toEqual(new Set());
			await waitFor(() => server.present().size === 0);
			expect(server.present()).toEqual(new Set());
			// Gone with its last watcher: a new one is not sent the old reply.
			const again = await open(token, "live");
			const first = (await again.collect(400)).text;
			expect(first).toContain(": connected");
			expect(first).not.toContain("event: live");
			again.controller.abort();
		});

		it("signals a status change to the clients that have the session open, without its content", async () => {
			const token = await pair();
			const watcher = await open(token, "live");
			const bystander = await open(token);
			expect((await watcher.collect(200)).text).toContain(": connected");
			server.status("live");
			const text = (await watcher.collect(300)).text;
			expect(text).toContain(`event: status\ndata: ${JSON.stringify({ sessionId: "live" })}`);
			expect((await bystander.collect(200)).text).not.toContain("event: status");
			watcher.controller.abort();
			bystander.controller.abort();
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
