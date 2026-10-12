# Remote Control Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Control every agent-view session from an iPhone through a PWA served by bluclawd's daemon on `127.0.0.1`, reached over `tailscale serve`: pair, list sessions with status, read a session's transcript, send a prompt, stop a turn.

**Architecture:** A new `daemon/remote/` module inside the existing daemon adds a `node:http` listener next to the Unix socket. It reuses the supervisor's registry (`list`) and its pane message queue (`send` → `PaneMessage`, picked up on each pane's 3 s heartbeat), reads transcripts from each session's `.jsonl`, and signals changes over SSE. A new `ext/remote` extension adds `/remote-control`, which talks to the daemon over the existing socket with one new IPC request, `remote`.

**Tech Stack:** TypeScript on Node 26 (native type stripping), `node:http`, `node:crypto`, vitest, vanilla JS ES modules for the PWA (`// @ts-check`, no build step). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-remote-control-phase1-design.md`

**Commits:** AGENTS.md §8 says to ask before every commit. Each task ends with a commit step: ask the user before running it, or batch several tasks into one approved commit.

**Conventions:** tabs; biome's formatter (line width 120); `import type` for types; no TypeScript parameter properties (`erasableSyntaxOnly` forbids them); tests are self-contained, with JSONL fixtures as inline strings.

---

## File structure

| File | Responsibility |
|---|---|
| `daemon/remote/transcript.ts` (new) | Session `.jsonl` text → `RemoteMessage[]` along the active branch. Pure, plus one file read |
| `daemon/remote/pairing.ts` (new) | `RemoteStore`: `remote.json` (on/off, port, devices with token hashes), in-memory pairing code |
| `daemon/remote/sessions.ts` (new) | The phone's session list via agent view's own `collectRows` / `buildBands` |
| `daemon/remote/events.ts` (new) | `RemoteEvents`: SSE clients, a 1 s poll of the list signature and the open session's file |
| `daemon/remote/http.ts` (new) | `startRemoteServer`: router, auth, body limits, static PWA files |
| `daemon/remote/control.ts` (new) | `RemoteControl`: matches the listener to `remote.json`, answers the `remote` IPC request |
| `daemon/remote/web/*` (new) | The PWA: `index.html`, `style.css`, `api.js`, `app.js`, `sw.js`, `manifest.webmanifest`, `tsconfig.json` |
| `daemon/ipc/protocol.ts` | Add `RemoteRequest` / `RemoteResponse` |
| `daemon/handler.ts` | Extract `listSummaries()`; `setRemoteControl()`; `case "remote"` |
| `daemon/serve.ts` | Create and apply `RemoteControl` at start, stop it on shutdown |
| `ext/agent-view/orchestrator-client.ts` | `remote()` client method |
| `ext/_shared/settings.ts` | `remotePort()` reader for `remote.port` |
| `ext/remote/tailscale.ts` (new) | `tailscale status/serve` helpers |
| `ext/remote/message.ts` (new) | The pairing instructions text |
| `ext/remote/index.ts` (new) | `/remote-control` command |
| `ext/index.ts`, `package.json`, `ext/help/categories.ts`, `biome.json`, `test/registration.test.ts`, `README.md` | Wiring and docs |

---

### Task 1: Transcript reader

**Files:**
- Create: `daemon/remote/transcript.ts`
- Test: `test/remote-transcript.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/remote-transcript.test.ts
import { describe, expect, it } from "vitest";
import { activeBranch, parseEntries, TEXT_MAX, toolSummary, transcriptFrom } from "../daemon/remote/transcript.ts";

const jsonl = (...entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const msg = (id: string, parentId: string | null, message: object) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-10-12T00:00:00Z",
	message,
});

describe("remote transcript", () => {
	it("reduces each kind of entry to what the phone shows", () => {
		const text = jsonl(
			{ type: "session", version: 3, id: "s", cwd: "/p" },
			{ type: "model_change", id: "m0", parentId: null, provider: "anthropic", modelId: "claude-opus-5-5" },
			msg("u1", "m0", {
				role: "user",
				content: [
					{ type: "text", text: "run the tests" },
					{ type: "image", data: "x", mimeType: "image/png" },
				],
			}),
			msg("a1", "u1", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "text", text: "Running." },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test", description: "Run tests" } },
				],
			}),
			msg("r1", "a1", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "1 failed" }],
			}),
			{ type: "custom_message", id: "x1", parentId: "r1", customType: "note", display: true, content: "Task done\nmore" },
			msg("b1", "x1", { role: "bashExecution", command: "ls", exitCode: 0 }),
			{ type: "compaction", id: "k1", parentId: "b1", summary: "…" },
		);
		expect(transcriptFrom(text, 50)).toEqual([
			{ kind: "marker", id: "m0", text: "Model: anthropic/claude-opus-5-5" },
			{ kind: "user", id: "u1", text: "run the tests\n[Image]" },
			{
				kind: "assistant",
				id: "a1",
				text: "Running.",
				thinking: "plan",
				tools: [{ id: "c1", name: "bash", summary: "npm test" }],
			},
			{ kind: "toolResult", id: "r1", toolCallId: "c1", toolName: "bash", ok: false, text: "1 failed", truncated: false },
			{ kind: "marker", id: "x1", text: "Task done" },
			{ kind: "marker", id: "b1", text: "!ls" },
			{ kind: "marker", id: "k1", text: "Conversation compacted" },
		]);
	});

	it("follows the branch the file's last entry is on", () => {
		const text = jsonl(
			msg("u1", null, { role: "user", content: "first" }),
			msg("u2", "u1", { role: "user", content: "abandoned" }),
			msg("u3", "u1", { role: "user", content: "kept" }),
		);
		expect(transcriptFrom(text, 50).map((m) => m.id)).toEqual(["u1", "u3"]);
	});

	it("skips lines that do not parse, such as a half-written last line", () => {
		const text = `${jsonl(msg("u1", null, { role: "user", content: "hi" }))}\n{"type":"mess`;
		expect(parseEntries(text)).toHaveLength(1);
		expect(transcriptFrom(text, 50)).toHaveLength(1);
	});

	it("truncates a long tool result and keeps only the last `limit` messages", () => {
		const text = jsonl(
			msg("u1", null, { role: "user", content: "a" }),
			msg("r1", "u1", {
				role: "toolResult",
				toolCallId: "c",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "x".repeat(TEXT_MAX + 10) }],
			}),
		);
		const messages = transcriptFrom(text, 1);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ kind: "toolResult", truncated: true });
		expect((messages[0] as { text: string }).text).toHaveLength(TEXT_MAX + 1);
	});

	it("keeps a failed model request and drops an empty assistant message", () => {
		const text = jsonl(
			msg("a1", null, { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }),
			msg("a2", "a1", { role: "assistant", content: [], stopReason: "aborted" }),
		);
		expect(transcriptFrom(text, 50)).toEqual([{ kind: "assistant", id: "a1", text: "", tools: [], error: "rate limited" }]);
	});

	it("summarises a tool call by its main argument", () => {
		expect(toolSummary({ path: "a.ts", offset: 3 })).toBe("a.ts");
		expect(toolSummary({ command: "echo 1\necho 2" })).toBe("echo 1");
		expect(toolSummary({})).toBe("");
	});

	it("an empty file has no branch", () => {
		expect(activeBranch([])).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/remote-transcript.test.ts`
Expected: FAIL, `Cannot find module '../daemon/remote/transcript.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// daemon/remote/transcript.ts
/**
 * A session's .jsonl as the phone's chat. The active branch is the `parentId` chain from the
 * file's last entry (pi appends to the branch it is on); each entry is reduced to what a phone
 * shows. Pure apart from `loadTranscript`'s one read.
 */
import { readFileSync } from "node:fs";
import { textOf } from "../session-state.ts";

export interface RemoteToolCall {
	id: string;
	name: string;
	/** The call's main argument: its command, path or pattern. */
	summary: string;
}

export type RemoteMessage =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; text: string; thinking?: string; tools: RemoteToolCall[]; error?: string }
	| {
			kind: "toolResult";
			id: string;
			toolCallId?: string;
			toolName: string;
			ok: boolean;
			text: string;
			truncated: boolean;
	  }
	| { kind: "marker"; id: string; text: string };

/** A tool result or a thinking block is cut to this many characters. */
export const TEXT_MAX = 2048;
const SUMMARY_MAX = 120;

interface Part {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		stopReason?: string;
		errorMessage?: string;
		command?: string;
	};
	provider?: string;
	modelId?: string;
	content?: unknown;
	display?: boolean;
}

export function parseEntries(text: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Entry;
			if (entry && typeof entry === "object") entries.push(entry);
		} catch {
			// the last line may still be being written
		}
	}
	return entries;
}

/** The entries from the root to the file's last entry, following `parentId`. */
export function activeBranch(entries: Entry[]): Entry[] {
	const byId = new Map<string, Entry>();
	for (const entry of entries) if (entry.id && entry.type !== "session") byId.set(entry.id, entry);
	let current = [...entries].reverse().find((entry) => entry.id && entry.type !== "session");
	const branch: Entry[] = [];
	const seen = new Set<string>();
	while (current?.id && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

function clip(text: string): { text: string; truncated: boolean } {
	return text.length > TEXT_MAX ? { text: `${text.slice(0, TEXT_MAX)}…`, truncated: true } : { text, truncated: false };
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

function partsOf(content: unknown): Part[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Part[]) : [];
}

/** Text parts on their own lines, an image as `[Image]`. */
function plainText(content: unknown): string {
	return partsOf(content)
		.map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "image" ? "[Image]" : ""))
		.filter(Boolean)
		.join("\n");
}

/** The argument a tool call is about, as Claude Code shows it: `Bash(npm test)`. */
export function toolSummary(args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const value = [a.command, a.path, a.pattern, a.url, a.query, a.description].find(
		(v) => typeof v === "string" && v.trim(),
	);
	return typeof value === "string" ? firstLine(value) : "";
}

function toRemote(entry: Entry): RemoteMessage | undefined {
	const id = entry.id ?? "";
	if (entry.type === "model_change") return { kind: "marker", id, text: `Model: ${entry.provider}/${entry.modelId}` };
	if (entry.type === "compaction") return { kind: "marker", id, text: "Conversation compacted" };
	if (entry.type === "custom_message" && entry.display) {
		const text = firstLine(plainText(entry.content));
		return text ? { kind: "marker", id, text } : undefined;
	}
	if (entry.type !== "message" || !entry.message) return undefined;
	const message = entry.message;
	switch (message.role) {
		case "user":
			return { kind: "user", id, text: plainText(message.content) };
		case "assistant": {
			const parts = partsOf(message.content);
			const text = textOf(message.content);
			const thinking = parts
				.filter((part) => part.type === "thinking" && part.thinking)
				.map((part) => part.thinking)
				.join("\n\n");
			const tools = parts
				.filter((part) => part.type === "toolCall")
				.map((part) => ({ id: part.id ?? "", name: part.name ?? "tool", summary: toolSummary(part.arguments) }));
			const error = message.stopReason === "error" ? message.errorMessage || "the model request failed" : undefined;
			if (!text && !thinking && tools.length === 0 && !error) return undefined;
			return {
				kind: "assistant",
				id,
				text,
				...(thinking ? { thinking: clip(thinking).text } : {}),
				tools,
				...(error ? { error } : {}),
			};
		}
		case "toolResult": {
			const { text, truncated } = clip(plainText(message.content));
			return {
				kind: "toolResult",
				id,
				toolCallId: message.toolCallId,
				toolName: message.toolName ?? "tool",
				ok: message.isError !== true,
				text,
				truncated,
			};
		}
		case "bashExecution":
			return typeof message.command === "string" ? { kind: "marker", id, text: `!${message.command}` } : undefined;
		default:
			return undefined;
	}
}

/** The last `limit` messages of the active branch. */
export function transcriptFrom(text: string, limit: number): RemoteMessage[] {
	const messages = activeBranch(parseEntries(text))
		.map(toRemote)
		.filter((message): message is RemoteMessage => message !== undefined);
	return messages.slice(-limit);
}

/** A session that has not written its file yet has an empty transcript. */
export function loadTranscript(sessionFile: string | undefined, limit: number): RemoteMessage[] {
	if (!sessionFile) return [];
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	return transcriptFrom(text, limit);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/remote-transcript.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit** (ask first)

```bash
git add daemon/remote/transcript.ts test/remote-transcript.test.ts
git commit -m "feat(remote): read a session's transcript for the phone"
```

---

### Task 2: Pairing store

**Files:**
- Create: `daemon/remote/pairing.ts`
- Test: `test/remote-pairing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/remote-pairing.test.ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT, RemoteStore } from "../daemon/remote/pairing.ts";

describe("remote pairing", () => {
	let dir: string;
	let path: string;
	let store: RemoteStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-"));
		path = join(dir, "remote.json");
		store = new RemoteStore(path);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function pairDevice(name = "iPhone"): string {
		const { code } = store.createCode(0);
		const result = store.claim(code, name, 1);
		if (!("token" in result)) throw new Error(result.error);
		return result.token;
	}

	it("starts off, on the default port, with no devices", () => {
		expect(store.load()).toEqual({ enabled: false, port: DEFAULT_PORT, devices: [] });
	});

	it("exchanges a code for a token once, storing only the token's hash, owner-only", () => {
		const { code } = store.createCode(1000);
		expect(code).toMatch(/^\d{6}$/);
		const result = store.claim(code, "iPhone", 2000);
		if (!("token" in result)) throw new Error(result.error);
		expect(store.authenticate(result.token, 3000)?.name).toBe("iPhone");
		expect(store.claim(code, "iPhone", 2500)).toEqual({ error: "invalid_code" });
		expect(readFileSync(path, "utf8")).not.toContain(result.token);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("expires a code after five minutes", () => {
		const { code } = store.createCode(0);
		expect(store.claim(code, "iPhone", 5 * 60_000 + 1)).toEqual({ error: "expired_code" });
	});

	it("invalidates a code after five wrong attempts", () => {
		const { code } = store.createCode(0);
		const wrong = code === "000000" ? "111111" : "000000";
		for (let i = 0; i < 5; i++) expect(store.claim(wrong, "x", 1)).toEqual({ error: "invalid_code" });
		expect(store.claim(code, "x", 1)).toEqual({ error: "invalid_code" });
	});

	it("rejects an empty or unknown token and a revoked device", () => {
		const token = pairDevice();
		expect(store.authenticate("", 2)).toBeUndefined();
		expect(store.authenticate("nope", 2)).toBeUndefined();
		const [device] = store.load().devices;
		expect(store.revoke(device.id)).toBe(true);
		expect(store.authenticate(token, 3)).toBeUndefined();
		expect(store.revoke(device.id)).toBe(false);
	});

	it("names a device that sent no name", () => {
		pairDevice("");
		expect(store.load().devices[0].name).toBe("Phone");
	});

	it("keeps devices and the port when switching on and off", () => {
		pairDevice();
		store.setEnabled(true, 9000);
		expect(store.load()).toMatchObject({ enabled: true, port: 9000 });
		store.setEnabled(false);
		expect(store.load()).toMatchObject({ enabled: false, port: 9000 });
		expect(store.load().devices).toHaveLength(1);
	});

	it("treats a corrupt remote.json as empty", () => {
		store.setEnabled(true);
		writeFileSync(path, "{nope");
		expect(store.load()).toEqual({ enabled: false, port: DEFAULT_PORT, devices: [] });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/remote-pairing.test.ts`
Expected: FAIL, `Cannot find module '../daemon/remote/pairing.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// daemon/remote/pairing.ts
/**
 * Who may use remote control: paired devices, each holding a random token of which only the
 * SHA-256 hash is kept, in remote.json next to the daemon's socket (owner-only). A device pairs
 * by exchanging a short-lived 6-digit code that `/remote-control` shows; the code lives only in
 * the daemon's memory.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getServerDir } from "../paths.ts";

export const DEFAULT_PORT = 7878;
const CODE_TTL_MS = 5 * 60_000;
const CODE_ATTEMPTS = 5;
/** `lastUsedAt` is rewritten at most this often, not on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface RemoteDevice {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
	lastUsedAt?: string;
}

export interface RemoteState {
	enabled: boolean;
	port: number;
	devices: RemoteDevice[];
}

export type ClaimResult = { token: string; deviceId: string } | { error: "invalid_code" | "expired_code" };

export function getRemotePath(): string {
	return join(getServerDir(), "remote.json");
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export class RemoteStore {
	private readonly path: string;
	private code: { value: string; expiresAt: number; attempts: number } | undefined;

	constructor(path: string = getRemotePath()) {
		this.path = path;
	}

	load(): RemoteState {
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RemoteState>;
			return {
				enabled: raw.enabled === true,
				port: Number.isInteger(raw.port) ? (raw.port as number) : DEFAULT_PORT,
				devices: Array.isArray(raw.devices) ? raw.devices : [],
			};
		} catch {
			return { enabled: false, port: DEFAULT_PORT, devices: [] };
		}
	}

	private save(state: RemoteState): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
		renameSync(tmp, this.path);
	}

	setEnabled(enabled: boolean, port?: number): RemoteState {
		const state = this.load();
		state.enabled = enabled;
		if (port !== undefined) state.port = port;
		this.save(state);
		return state;
	}

	/** A new code replaces any earlier one. */
	createCode(now: number = Date.now()): { code: string; expiresAt: number } {
		const value = String(randomInt(0, 1_000_000)).padStart(6, "0");
		this.code = { value, expiresAt: now + CODE_TTL_MS, attempts: 0 };
		return { code: value, expiresAt: this.code.expiresAt };
	}

	claim(code: string, deviceName: string, now: number = Date.now()): ClaimResult {
		const current = this.code;
		if (!current) return { error: "invalid_code" };
		if (now > current.expiresAt) {
			this.code = undefined;
			return { error: "expired_code" };
		}
		if (code !== current.value) {
			current.attempts++;
			if (current.attempts >= CODE_ATTEMPTS) this.code = undefined;
			return { error: "invalid_code" };
		}
		this.code = undefined;
		const token = randomBytes(32).toString("base64url");
		const device: RemoteDevice = {
			id: randomUUID(),
			name: deviceName.trim().slice(0, 60) || "Phone",
			tokenHash: hashToken(token),
			createdAt: new Date(now).toISOString(),
		};
		const state = this.load();
		state.devices.push(device);
		this.save(state);
		return { token, deviceId: device.id };
	}

	authenticate(token: string, now: number = Date.now()): RemoteDevice | undefined {
		if (!token) return undefined;
		const hash = Buffer.from(hashToken(token), "hex");
		const state = this.load();
		const device = state.devices.find((d) => {
			const stored = Buffer.from(d.tokenHash, "hex");
			return stored.length === hash.length && timingSafeEqual(stored, hash);
		});
		if (!device) return undefined;
		const lastUsed = device.lastUsedAt ? Date.parse(device.lastUsedAt) : 0;
		if (now - lastUsed > LAST_USED_RESOLUTION_MS) {
			device.lastUsedAt = new Date(now).toISOString();
			this.save(state);
		}
		return device;
	}

	revoke(deviceId: string): boolean {
		const state = this.load();
		const devices = state.devices.filter((device) => device.id !== deviceId);
		if (devices.length === state.devices.length) return false;
		this.save({ ...state, devices });
		return true;
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/remote-pairing.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit** (ask first)

```bash
git add daemon/remote/pairing.ts test/remote-pairing.test.ts
git commit -m "feat(remote): pair devices with a short-lived code and hashed tokens"
```

---

### Task 3: Session list

**Files:**
- Create: `daemon/remote/sessions.ts`
- Test: `test/remote-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/remote-sessions.test.ts
import { describe, expect, it } from "vitest";
import type { InstanceSummary } from "../daemon/ipc/protocol.ts";
import { findSession, remoteSessions } from "../daemon/remote/sessions.ts";

const live = (
	id: string,
	activity: InstanceSummary["activity"],
	extra: Partial<InstanceSummary> = {},
): InstanceSummary => ({
	id,
	status: "online",
	cwd: "/p",
	external: true,
	activity,
	createdAt: "2026-10-12T00:00:00Z",
	sessionFile: `/s/${id}.jsonl`,
	...extra,
});

describe("remote sessions", () => {
	it("groups rows into agent view's bands, Needs input first", () => {
		const sessions = remoteSessions([
			live("a", "idle", { label: "idle one" }),
			live("b", "working", { detail: "npm test" }),
			live("c", "awaiting_input"),
		]);
		expect(sessions.map((s) => [s.id, s.band])).toEqual([
			["c", "needs"],
			["b", "working"],
			["a", "idle"],
		]);
		expect(sessions[1]).toMatchObject({ detail: "npm test", alive: true, state: "working" });
		expect(sessions[2].label).toBe("idle one");
	});

	it("puts pinned rows in their own band, first", () => {
		const sessions = remoteSessions([live("a", "working"), live("p", "idle", { pinned: true })]);
		expect(sessions.map((s) => [s.id, s.band])).toEqual([
			["p", "pinned"],
			["a", "working"],
		]);
	});

	it("lists a stored row as not alive, and its live twin instead when both exist", () => {
		const stored: InstanceSummary = {
			id: "old",
			status: "stopped",
			cwd: "/p",
			sessionFile: "/s/x.jsonl",
			outcome: "done",
		};
		expect(remoteSessions([stored])[0]).toMatchObject({ id: "old", alive: false, band: "idle" });
		expect(remoteSessions([stored, live("new", "idle", { sessionFile: "/s/x.jsonl" })]).map((s) => s.id)).toEqual([
			"new",
		]);
	});

	it("finds a session's file and whether a pane runs it", () => {
		const stored: InstanceSummary = { id: "old", status: "stopped", cwd: "/p", sessionFile: "/s/old.jsonl" };
		const list = [stored, live("b", "idle")];
		expect(findSession(list, "b")).toEqual({ sessionFile: "/s/b.jsonl", running: true });
		expect(findSession(list, "old")).toEqual({ sessionFile: "/s/old.jsonl", running: false });
		expect(findSession(list, "zzz")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/remote-sessions.test.ts`
Expected: FAIL, `Cannot find module '../daemon/remote/sessions.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// daemon/remote/sessions.ts
/**
 * The phone's session list: agent view's own rows and bands (ext/agent-view/rows.ts, pure), so
 * the phone and the terminal agree on what is Needs input, Working or Idle.
 *
 * rows.ts sits outside daemon/, so editing it does not change the daemon's build id: a running
 * daemon keeps the old rows until it restarts.
 */
import { type AgentRow, buildBands, collectRows, type RowState } from "../../ext/agent-view/rows.ts";
import type { InstanceSummary } from "../ipc/protocol.ts";

export type RemoteBand = "pinned" | "needs" | "working" | "idle";

export interface RemoteSession {
	id: string;
	label: string;
	cwd: string;
	band: RemoteBand;
	state: RowState;
	/** A pane's pi runs it; a stored row has no process. */
	alive: boolean;
	detail: string;
	createdAt?: string;
	finishedAt?: string;
}

function sessionRows(instances: InstanceSummary[]): AgentRow[] {
	return collectRows(instances, undefined).filter((row) => !row.shell && !row.id.startsWith("pending:"));
}

/** In display order: agent view's state bands, each sorted as agent view sorts it. */
export function remoteSessions(instances: InstanceSummary[]): RemoteSession[] {
	const sessions: RemoteSession[] = [];
	for (const band of buildBands(sessionRows(instances), "state", (path) => path)) {
		for (const row of band.rows) {
			sessions.push({
				id: row.id,
				label: row.label,
				cwd: row.cwd,
				band: band.key as RemoteBand,
				state: row.state,
				alive: row.alive,
				detail: row.detail,
				createdAt: row.createdAt,
				finishedAt: row.finishedAt,
			});
		}
	}
	return sessions;
}

/** `running`: a pane's pi is registered as this id, so a queued message reaches it. */
export function findSession(
	instances: InstanceSummary[],
	id: string,
): { sessionFile?: string; running: boolean } | undefined {
	const row = sessionRows(instances).find((r) => r.id === id);
	if (!row) return undefined;
	return { sessionFile: row.sessionFile, running: instances.some((i) => i.id === id && i.external === true) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/remote-sessions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** (ask first)

```bash
git add daemon/remote/sessions.ts test/remote-sessions.test.ts
git commit -m "feat(remote): list sessions in agent view's bands"
```

---

### Task 4: SSE change signals

**Files:**
- Create: `daemon/remote/events.ts`
- Modify: `docs/superpowers/specs/2026-10-12-remote-control-phase1-design.md` (Change detection: poll only)

The events are tested through the HTTP server in Task 5.

- [ ] **Step 1: Write the implementation**

```ts
// daemon/remote/events.ts
/**
 * Server-Sent Events for the phone. They carry no content, only "refetch" signals: `sessions`
 * when the list changes, `messages` when the .jsonl of the session a client has open changes.
 * Polled once a second while any client is connected; the registry itself changes on the panes'
 * 3s heartbeats.
 */
import { statSync } from "node:fs";
import type { ServerResponse } from "node:http";

export interface EventSources {
	/** Changes exactly when the phone's session list would. */
	sessionsSignature(): string;
	sessionFile(sessionId: string): string | undefined;
}

interface Client {
	res: ServerResponse;
	sessionId?: string;
	fileSignature?: string;
}

const INTERVAL_MS = 1000;
/** A comment line this often keeps proxies and the phone from dropping an idle stream. */
const PING_EVERY_TICKS = 25;

function fileSignature(file: string | undefined): string {
	if (!file) return "none";
	try {
		const stat = statSync(file);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

function send(res: ServerResponse, event: string, data: object): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class RemoteEvents {
	private readonly sources: EventSources;
	private readonly clients = new Set<Client>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastSessions: string | undefined;
	private ticks = 0;

	constructor(sources: EventSources) {
		this.sources = sources;
	}

	/** `sessionId`: the session the client has open, whose file it is told about. */
	add(res: ServerResponse, sessionId?: string): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		const client: Client = {
			res,
			sessionId,
			fileSignature: sessionId ? fileSignature(this.sources.sessionFile(sessionId)) : undefined,
		};
		this.clients.add(client);
		res.on("close", () => {
			this.clients.delete(client);
			if (this.clients.size === 0) this.stopTimer();
		});
		if (!this.timer) {
			this.lastSessions = this.sources.sessionsSignature();
			this.timer = setInterval(() => this.tick(), INTERVAL_MS);
		}
	}

	private tick(): void {
		const sessions = this.sources.sessionsSignature();
		const changed = sessions !== this.lastSessions;
		this.lastSessions = sessions;
		const ping = ++this.ticks % PING_EVERY_TICKS === 0;
		for (const client of this.clients) {
			if (changed) send(client.res, "sessions", {});
			if (client.sessionId) {
				const signature = fileSignature(this.sources.sessionFile(client.sessionId));
				if (signature !== client.fileSignature) {
					client.fileSignature = signature;
					send(client.res, "messages", { sessionId: client.sessionId });
				}
			}
			if (ping) client.res.write(": ping\n\n");
		}
	}

	close(): void {
		this.stopTimer();
		for (const client of this.clients) client.res.end();
		this.clients.clear();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
```

- [ ] **Step 2: Update the spec's Change detection paragraph**

In `docs/superpowers/specs/2026-10-12-remote-control-phase1-design.md`, replace the paragraph under `### Change detection` with:

```markdown
While any phone is connected, `events.ts` polls once a second: the session list's signature
(its JSON) and, for each connected client, the `stat` (size and mtime) of the `sessionFile` of
the session it has open. Any change in the list sends `sessions`; any change in size or mtime
(growth, or a rewrite that shrinks the file) sends `messages`. A poll replaces `fs.watch`: the
registry changes on 3 s heartbeats anyway, and polling needs no per-platform fallback.
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 4: Commit** (ask first)

```bash
git add daemon/remote/events.ts docs/superpowers/specs/2026-10-12-remote-control-phase1-design.md
git commit -m "feat(remote): signal list and transcript changes over SSE"
```

---

### Task 5: HTTP server

**Files:**
- Create: `daemon/remote/http.ts`
- Test: `test/remote-http.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/remote-http.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/remote-http.test.ts`
Expected: FAIL, `Cannot find module '../daemon/remote/http.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// daemon/remote/http.ts
/**
 * The phone's HTTP API and the PWA's static files, on 127.0.0.1 only: the phone reaches it
 * through `tailscale serve`, never directly. Every /api route except POST /api/pair needs a
 * paired device's token: a bearer header, or `?token=` on the SSE stream, which EventSource
 * cannot give headers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { InstanceSummary, PaneMessage } from "../ipc/protocol.ts";
import { RemoteEvents } from "./events.ts";
import type { RemoteStore } from "./pairing.ts";
import { findSession, remoteSessions } from "./sessions.ts";
import { loadTranscript } from "./transcript.ts";

export interface RemoteDeps {
	store: RemoteStore;
	listInstances(): InstanceSummary[];
	/** Queue a message for a pane's pi; false when no pane is registered as that id. */
	send(sessionId: string, message: PaneMessage): boolean;
	webDir: string;
}

export interface RemoteServer {
	/** The port actually bound (differs from the requested one only for port 0). */
	port: number;
	close(): Promise<void>;
}

export const BODY_MAX = 64 * 1024;
export const PROMPT_MAX = 32 * 1024;
const MESSAGES_DEFAULT = 50;
const MESSAGES_MAX = 200;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
	".svg": "image/svg+xml",
};

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, code: string) {
		super(code);
		this.status = status;
	}
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(JSON.stringify(body));
}

/** Reads the whole body even past the limit, so the 413 reaches a client still sending. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size <= BODY_MAX) chunks.push(chunk as Buffer);
	}
	if (size > BODY_MAX) throw new HttpError(413, "body_too_large");
	if (size === 0) return {};
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	} catch {
		throw new HttpError(400, "invalid_json");
	}
}

function bearer(req: IncomingMessage): string {
	const header = req.headers.authorization ?? "";
	return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Only a file that is in the web directory by that exact name: no path from the request is joined. */
function serveStatic(webDir: string, path: string, req: IncomingMessage, res: ServerResponse): void {
	const name = path === "/" ? "index.html" : path.slice(1);
	const type = CONTENT_TYPES[extname(name)];
	if ((req.method !== "GET" && req.method !== "HEAD") || !type || !readdirSync(webDir).includes(name)) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
		return;
	}
	res.writeHead(200, { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
	res.end(req.method === "HEAD" ? undefined : readFileSync(join(webDir, name)));
}

async function handle(deps: RemoteDeps, events: RemoteEvents, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname;
	if (!path.startsWith("/api/")) return serveStatic(deps.webDir, path, req, res);

	if (path === "/api/pair" && req.method === "POST") {
		const body = await readJson(req);
		const result = deps.store.claim(String(body.code ?? ""), String(body.deviceName ?? ""));
		return "token" in result ? json(res, 200, { token: result.token }) : json(res, 400, { error: result.error });
	}

	const token = path === "/api/events" ? (url.searchParams.get("token") ?? "") : bearer(req);
	if (!deps.store.authenticate(token)) return json(res, 401, { error: "unauthorized" });

	if (path === "/api/events" && req.method === "GET") {
		events.add(res, url.searchParams.get("session") ?? undefined);
		return;
	}
	if (path === "/api/sessions" && req.method === "GET") {
		return json(res, 200, { sessions: remoteSessions(deps.listInstances()) });
	}

	const match = /^\/api\/sessions\/([^/]+)\/(messages|prompt|abort)$/.exec(path);
	if (!match) return json(res, 404, { error: "not_found" });
	const id = decodeURIComponent(match[1]);
	const session = findSession(deps.listInstances(), id);
	if (!session) return json(res, 404, { error: "unknown_session" });
	const action = match[2];

	if (action === "messages") {
		if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
		const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10) || MESSAGES_DEFAULT;
		const limit = Math.min(Math.max(requested, 1), MESSAGES_MAX);
		return json(res, 200, { messages: loadTranscript(session.sessionFile, limit) });
	}

	if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
	const body = await readJson(req);
	let message: PaneMessage;
	if (action === "prompt") {
		const text = typeof body.text === "string" ? body.text : "";
		if (!text.trim()) return json(res, 400, { error: "empty_prompt" });
		if (text.length > PROMPT_MAX) return json(res, 413, { error: "prompt_too_large" });
		message = { type: "prompt", text };
	} else {
		message = { type: "abort" };
	}
	if (!session.running || !deps.send(id, message)) return json(res, 409, { error: "session_not_running" });
	return json(res, 202, { ok: true });
}

export function startRemoteServer(deps: RemoteDeps, port: number, host = "127.0.0.1"): Promise<RemoteServer> {
	const events = new RemoteEvents({
		sessionsSignature: () => JSON.stringify(remoteSessions(deps.listInstances())),
		sessionFile: (id) => findSession(deps.listInstances(), id)?.sessionFile,
	});
	const server: Server = createServer((req, res) => {
		handle(deps, events, req, res).catch((error: unknown) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof HttpError) json(res, error.status, { error: error.message });
			else json(res, 500, { error: "internal_error" });
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			const address = server.address();
			resolve({
				port: typeof address === "object" && address ? address.port : port,
				close: () =>
					new Promise<void>((done) => {
						events.close();
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/remote-http.test.ts`
Expected: PASS (7 tests). The SSE test takes about 2 s (two 1 s polls).

- [ ] **Step 5: Commit** (ask first)

```bash
git add daemon/remote/http.ts test/remote-http.test.ts
git commit -m "feat(remote): serve the phone's API and app on 127.0.0.1"
```

---

### Task 6: The `remote` IPC request and the daemon switch

**Files:**
- Create: `daemon/remote/control.ts`
- Modify: `daemon/ipc/protocol.ts` (add types; extend `RequestMap` / `ResponseMap`)
- Modify: `daemon/handler.ts` (extract `listSummaries`, add `setRemoteControl`, `case "remote"`)
- Modify: `daemon/serve.ts` (start and stop the switch)
- Test: `test/remote-control.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/remote-control.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleIpcRequest, setRemoteControl } from "../daemon/handler.ts";
import { RemoteControl } from "../daemon/remote/control.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";

describe("remote control switch", () => {
	let dir: string;
	let control: RemoteControl;
	const make = () =>
		new RemoteControl({
			store: new RemoteStore(join(dir, "remote.json")),
			listInstances: () => [],
			send: () => true,
			webDir: dir,
		});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-control-"));
		control = make();
	});
	afterEach(async () => {
		await control.stop();
		setRemoteControl(undefined);
		rmSync(dir, { recursive: true, force: true });
	});

	it("turns on with a pairing code and listens; off stops listening", async () => {
		const on = await control.handle({ type: "remote", action: "on", port: 0 });
		expect(on).toMatchObject({ type: "remote_result", ok: true, enabled: true, listening: true });
		if (on.type !== "remote_result") throw new Error(on.error);
		expect(on.code).toMatch(/^\d{6}$/);
		expect((await fetch(`http://127.0.0.1:${on.port}/api/sessions`)).status).toBe(401);
		expect(await control.handle({ type: "remote", action: "off" })).toMatchObject({ enabled: false, listening: false });
		await expect(fetch(`http://127.0.0.1:${on.port}/api/sessions`)).rejects.toThrow();
	});

	it("comes back on from remote.json, as after a daemon restart", async () => {
		await control.handle({ type: "remote", action: "on", port: 0 });
		await control.stop();
		control = make();
		await control.apply();
		expect(await control.handle({ type: "remote", action: "status" })).toMatchObject({ enabled: true, listening: true });
	});

	it("reports a port in use instead of throwing", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
		const { port } = blocker.address() as { port: number };
		const on = await control.handle({ type: "remote", action: "on", port });
		expect(on).toMatchObject({ enabled: true, listening: false });
		expect((on as { listenError?: string }).listenError).toContain("EADDRINUSE");
		blocker.close();
	});

	it("refuses a pairing code while off, and an unknown device", async () => {
		expect(await control.handle({ type: "remote", action: "pair" })).toMatchObject({ type: "error", ok: false });
		expect(await control.handle({ type: "remote", action: "revoke", deviceId: "nope" })).toMatchObject({
			type: "error",
			ok: false,
		});
	});

	it("is reached through the daemon's IPC handler", async () => {
		expect(await handleIpcRequest({ type: "remote", action: "status" })).toMatchObject({ type: "error" });
		setRemoteControl(control);
		expect(await handleIpcRequest({ type: "remote", action: "status" })).toMatchObject({
			type: "remote_result",
			enabled: false,
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/remote-control.test.ts`
Expected: FAIL, `Cannot find module '../daemon/remote/control.ts'`.

- [ ] **Step 3: Add the protocol types**

In `daemon/ipc/protocol.ts`, after `SaveRequest`:

```ts
/** Remote control from a phone (daemon/remote/): its switch, pairing codes and paired devices. */
export interface RemoteRequest {
	type: "remote";
	action: "status" | "on" | "off" | "pair" | "devices" | "revoke";
	/** With `on`: the port to listen on (pi's `remote.port` setting). */
	port?: number;
	/** With `revoke`. */
	deviceId?: string;
}
```

Add `remote: RemoteRequest;` to `RequestMap`. After `AckResponse`:

```ts
export interface RemoteDeviceInfo {
	id: string;
	name: string;
	createdAt: string;
	lastUsedAt?: string;
}

export interface RemoteResponse extends ResponseBase {
	type: "remote_result";
	enabled: boolean;
	/** The port bound while listening, else the configured one. */
	port: number;
	listening: boolean;
	/** Why the listener could not start (e.g. the port is in use). */
	listenError?: string;
	/** With `on` and `pair`: a 6-digit pairing code and when it expires (epoch ms). */
	code?: string;
	expiresAt?: number;
	devices: RemoteDeviceInfo[];
}
```

Add `remote: RemoteResponse;` to `ResponseMap`.

- [ ] **Step 4: Write `daemon/remote/control.ts`**

```ts
// daemon/remote/control.ts
/**
 * Remote control's switch, owned by the daemon. The on/off state and the port live in
 * remote.json, so the listener comes back when the daemon restarts (e.g. for a changed build).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ErrorResponse,
	InstanceSummary,
	PaneMessage,
	RemoteRequest,
	RemoteResponse,
} from "../ipc/protocol.ts";
import { type RemoteServer, startRemoteServer } from "./http.ts";
import { RemoteStore } from "./pairing.ts";

export const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

export interface RemoteControlDeps {
	listInstances(): InstanceSummary[];
	send(sessionId: string, message: PaneMessage): boolean;
	store?: RemoteStore;
	webDir?: string;
}

export class RemoteControl {
	readonly store: RemoteStore;
	private readonly deps: RemoteControlDeps;
	private server: RemoteServer | undefined;
	/** The configured port the running server was started for. */
	private serverPort: number | undefined;
	private listenError: string | undefined;

	constructor(deps: RemoteControlDeps) {
		this.deps = deps;
		this.store = deps.store ?? new RemoteStore();
	}

	/** Start or stop the listener to match remote.json. */
	async apply(): Promise<void> {
		const state = this.store.load();
		if (this.server && (!state.enabled || this.serverPort !== state.port)) await this.stop();
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
					webDir: this.deps.webDir ?? WEB_DIR,
				},
				state.port,
			);
			this.serverPort = state.port;
			this.listenError = undefined;
		} catch (error) {
			this.listenError = error instanceof Error ? error.message : String(error);
		}
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.serverPort = undefined;
		await server?.close();
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
				if (!this.server) return { type: "error", ok: false, error: "remote control is not listening" };
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
```

- [ ] **Step 5: Wire it into `daemon/handler.ts`**

Add to the protocol imports: `RemoteRequest,` and `RemoteResponse,`. Add below the imports:

```ts
import type { RemoteControl } from "./remote/control.ts";
```

Below `setShutdownHook`:

```ts
/** Installed by serve.ts: remote control's switch. Unset outside `serve` (tests). */
let remoteControl: RemoteControl | undefined;

export function setRemoteControl(control: RemoteControl | undefined): void {
	remoteControl = control;
}

/** Every row agent view lists: stored rows, then each pane's pi with its activity. */
export function listSummaries(): InstanceSummary[] {
	const stored = supervisor.listInstances().map((instance) => toInstanceSummary(instance));
	const external = supervisor
		.listExternalInstances()
		.map(({ record, activity }) => toInstanceSummary(record, activity, true));
	return [...stored, ...external];
}
```

Add this overload before the `DeleteRequest | …` overload:

```ts
export async function handleIpcRequest(request: RemoteRequest): Promise<RemoteResponse | ErrorResponse>;
```

Replace the body of `case "list"` with:

```ts
		case "list": {
			return { type: "list_result", ok: true, instances: listSummaries() };
		}
```

Add before `case "shutdown"`:

```ts
		case "remote": {
			if (!remoteControl) return { type: "error", ok: false, error: "remote control is not available in this process" };
			return remoteControl.handle(request);
		}
```

- [ ] **Step 6: Start and stop it in `daemon/serve.ts`**

Change the handler import to:

```ts
import { handleIpcRequest, listSummaries, setRemoteControl, setShutdownHook } from "./handler.ts";
```

Add `import { RemoteControl } from "./remote/control.ts";`. After `console.log(\`server listening on ${socketPath}\`);` add:

```ts
	const remote = new RemoteControl({
		listInstances: listSummaries,
		send: (id, message) => supervisor.sendExternal(id, message),
	});
	setRemoteControl(remote);
	await remote.apply();
```

In `shutdown`'s inner async function, after `server.close();`, add `await remote.stop();`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/remote-control.test.ts test/daemon-ipc-server.test.ts test/daemon-external-instances.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit** (ask first)

```bash
git add daemon/remote/control.ts daemon/ipc/protocol.ts daemon/handler.ts daemon/serve.ts test/remote-control.test.ts
git commit -m "feat(remote): switch remote control on and off in the daemon"
```

---

### Task 7: Client method and the port setting

**Files:**
- Modify: `ext/agent-view/orchestrator-client.ts`
- Modify: `ext/_shared/settings.ts`

- [ ] **Step 1: Add the client types and method**

In `ext/agent-view/orchestrator-client.ts`, after the `PaneMessage` type:

```ts
/** Mirror of daemon/ipc/protocol.ts RemoteDeviceInfo. */
export interface RemoteDeviceInfo {
	id: string;
	name: string;
	createdAt: string;
	lastUsedAt?: string;
}

/** Mirror of daemon/ipc/protocol.ts RemoteResponse, without the envelope. */
export interface RemoteResult {
	enabled: boolean;
	port: number;
	listening: boolean;
	listenError?: string;
	code?: string;
	expiresAt?: number;
	devices: RemoteDeviceInfo[];
}

export type RemoteAction =
	| { action: "status" | "off" | "pair" | "devices" }
	| { action: "on"; port?: number }
	| { action: "revoke"; deviceId: string };
```

Add `| ({ type: "remote" } & RemoteAction)` to the `Request` union. Add after `send()`:

```ts
	/** Remote control's switch, pairing codes and devices (daemon/remote/). */
	async remote(action: RemoteAction): Promise<RemoteResult> {
		const res = await this.request({ type: "remote", ...action }, 5000);
		if (res.type !== "remote_result") throw new Error("The agent daemon is out of date — restart pi to update it");
		return res as unknown as RemoteResult;
	}
```

- [ ] **Step 2: Add the settings reader**

In `ext/_shared/settings.ts`, add the import `import { DEFAULT_PORT } from "../../daemon/remote/pairing.ts";` and at the end:

```ts
/** `remote.port`: where remote control listens on 127.0.0.1. */
export function remotePort(sm: SettingsManager): number {
	const port = (merged(sm).remote as { port?: unknown } | undefined)?.port;
	return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit** (ask first)

```bash
git add ext/agent-view/orchestrator-client.ts ext/_shared/settings.ts
git commit -m "feat(remote): client for the daemon's remote request and the remote.port setting"
```

---

### Task 8: Tailscale helpers and pairing text

**Files:**
- Create: `ext/remote/tailscale.ts`, `ext/remote/message.ts`
- Test: `test/remote-tailscale.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/remote-tailscale.test.ts
import { describe, expect, it } from "vitest";
import { pairingText } from "../ext/remote/message.ts";
import { dnsNameOf, servesPort } from "../ext/remote/tailscale.ts";

describe("remote control: tailscale and pairing text", () => {
	it("reads the tailnet name without its trailing dot", () => {
		expect(dnsNameOf({ Self: { DNSName: "mac.tail1234.ts.net." } })).toBe("mac.tail1234.ts.net");
		expect(dnsNameOf({ Self: { DNSName: "" } })).toBeUndefined();
		expect(dnsNameOf({})).toBeUndefined();
	});

	it("detects a serve proxy to exactly this port", () => {
		const config = { Web: { "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7878" } } } } };
		expect(servesPort(config, 7878)).toBe(true);
		expect(servesPort(config, 787)).toBe(false);
		expect(servesPort({}, 7878)).toBe(false);
	});

	it("tells how to pair, with the code in two groups", () => {
		const text = pairingText("https://mac.tail1234.ts.net", "482913", 5 * 60_000, 0);
		expect(text).toContain("https://mac.tail1234.ts.net");
		expect(text).toContain("482 913");
		expect(text).toContain("expires in 5 min");
		expect(text).toContain("Add to Home Screen");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/remote-tailscale.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `ext/remote/tailscale.ts`**

```ts
// ext/remote/tailscale.ts
/**
 * The phone reaches remote control through Tailscale: `tailscale serve` proxies this machine's
 * tailnet HTTPS name to the daemon's 127.0.0.1 listener, reachable only from the tailnet.
 */
import { execFile } from "node:child_process";

export interface TailscaleInfo {
	installed: boolean;
	/** `host.tailnet.ts.net`, when logged in. */
	dnsName?: string;
	/** `tailscale serve` already proxies the port. */
	serving: boolean;
}

function run(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tailscale", args, { timeout: 10_000 }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout);
			error.message = stderr.trim() || error.message;
			reject(error);
		});
	});
}

/** `Self.DNSName` ends with the DNS root's dot. */
export function dnsNameOf(status: unknown): string | undefined {
	const name = (status as { Self?: { DNSName?: unknown } } | undefined)?.Self?.DNSName;
	return typeof name === "string" && name ? name.replace(/\.$/, "") : undefined;
}

/** Whether `tailscale serve status --json` shows a proxy to this port. */
export function servesPort(config: unknown, port: number): boolean {
	const text = JSON.stringify(config ?? {});
	return text.includes(`127.0.0.1:${port}"`) || text.includes(`localhost:${port}"`);
}

export async function tailscaleInfo(port: number): Promise<TailscaleInfo> {
	let status: unknown;
	try {
		status = JSON.parse(await run(["status", "--json"]));
	} catch (error) {
		return { installed: (error as NodeJS.ErrnoException).code !== "ENOENT", serving: false };
	}
	let serving = false;
	try {
		serving = servesPort(JSON.parse(await run(["serve", "status", "--json"])), port);
	} catch {
		// no serve configuration yet
	}
	return { installed: true, dnsName: dnsNameOf(status), serving };
}

/** Proxy https://<this machine's tailnet name>/ to 127.0.0.1:<port>, in the background. */
export async function serve(port: number): Promise<void> {
	await run(["serve", "--bg", String(port)]);
}
```

- [ ] **Step 4: Write `ext/remote/message.ts`**

```ts
// ext/remote/message.ts
/** What `/remote-control` shows once the phone can reach the daemon. */
export function pairingText(url: string, code: string, expiresAt: number, now: number = Date.now()): string {
	const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000));
	return [
		"Remote control is on",
		`1. On your phone, open ${url}`,
		"2. Share → Add to Home Screen, then open it from the Home Screen",
		`3. Enter the code ${code.slice(0, 3)} ${code.slice(3)} (expires in ${minutes} min)`,
		"/remote-control pair: a new code · /remote-control devices: paired devices · /remote-control: turn off",
	].join("\n");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/remote-tailscale.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit** (ask first)

```bash
git add ext/remote/tailscale.ts ext/remote/message.ts test/remote-tailscale.test.ts
git commit -m "feat(remote): find the tailnet URL and word the pairing steps"
```

---

### Task 9: `/remote-control` command and registration

**Files:**
- Create: `ext/remote/index.ts`
- Modify: `ext/index.ts`, `package.json` (`pi.extensions`), `ext/help/categories.ts`, `test/registration.test.ts`

- [ ] **Step 1: Update the registration test (failing)**

In `test/registration.test.ts`, add to `EXPECTED` after `"agent-view"`:

```ts
	remote: { commands: ["remote-control"], tools: [], shortcuts: 0, events: 0 },
```

and change the test name `"registers exactly the 9 expected extensions, no more, no fewer"` to `"registers exactly the 10 expected extensions, no more, no fewer"`.

Run: `npx vitest run test/registration.test.ts`
Expected: FAIL: the `remote` extension is missing.

- [ ] **Step 2: Write `ext/remote/index.ts`**

```ts
// ext/remote/index.ts
/**
 * `/remote-control`: control every agent-view session from a phone, as Claude Code's Remote
 * Control does. The daemon serves the phone (daemon/remote/); this command is its switch, shows
 * how to pair, and manages paired devices.
 */
import type { ExtensionAPI, ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { remotePort } from "../_shared/settings.ts";
import { currentDaemonBuildId, OrchestratorClient, type RemoteResult } from "../agent-view/orchestrator-client.ts";
import { pairingText } from "./message.ts";
import { serve, tailscaleInfo } from "./tailscale.ts";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A daemon started from older code has no remote control: replace it, as agent view does. */
async function daemon(): Promise<OrchestratorClient | undefined> {
	const client = new OrchestratorClient();
	if (!(await client.ensureDaemon())) return undefined;
	const info = await client.getDaemonInfo();
	if (info.buildId !== currentDaemonBuildId() && !(await client.restartDaemon()).restarted) return undefined;
	return client;
}

async function show(result: RemoteResult, ctx: ExtensionCommandContext): Promise<void> {
	if (!result.listening) {
		ctx.ui.notify(
			`Remote control could not listen on 127.0.0.1:${result.port}: ${result.listenError ?? "unknown error"}. ` +
				'Set "remote": { "port": <port> } in settings for another port, then run /remote-control twice.',
			"error",
		);
		return;
	}
	if (!result.code || !result.expiresAt) return;
	const pairing = (url: string) => pairingText(url, result.code ?? "", result.expiresAt ?? 0);
	const tailscale = await tailscaleInfo(result.port);
	if (!tailscale.installed) {
		ctx.ui.notify(
			`Tailscale is not installed, so your phone cannot reach this Mac: https://tailscale.com/download\n` +
				pairing(`http://127.0.0.1:${result.port} (this Mac only)`),
			"warning",
		);
		return;
	}
	if (!tailscale.dnsName) {
		ctx.ui.notify("Tailscale is not connected: run `tailscale up`, then /remote-control pair", "warning");
		return;
	}
	const url = `https://${tailscale.dnsName}`;
	if (!tailscale.serving) {
		const ok = await ctx.ui.confirm(
			"Expose remote control on your tailnet?",
			`Runs \`tailscale serve --bg ${result.port}\`: ${url} proxies to 127.0.0.1:${result.port} on this Mac, reachable only from your tailnet.`,
		);
		if (!ok) {
			ctx.ui.notify(`Not exposed. Run \`tailscale serve --bg ${result.port}\` yourself, then:\n${pairing(url)}`, "info");
			return;
		}
		try {
			await serve(result.port);
		} catch (error) {
			ctx.ui.notify(`tailscale serve failed: ${message(error)}`, "error");
			return;
		}
	}
	ctx.ui.notify(pairing(url), "info");
}

async function devices(client: OrchestratorClient, ctx: ExtensionCommandContext): Promise<void> {
	const { devices } = await client.remote({ action: "devices" });
	if (devices.length === 0) {
		ctx.ui.notify("No paired devices. /remote-control pair shows a code.", "info");
		return;
	}
	const labels = devices.map(
		(d, i) =>
			`${i + 1}. ${d.name} · paired ${d.createdAt.slice(0, 10)}` +
			(d.lastUsedAt ? ` · last used ${d.lastUsedAt.slice(0, 16).replace("T", " ")}` : ""),
	);
	const picked = await ctx.ui.select("Paired devices (enter revokes)", labels);
	if (picked === undefined) return;
	const device = devices[labels.indexOf(picked)];
	if (!device || !(await ctx.ui.confirm(`Revoke ${device.name}?`, "It will have to pair again."))) return;
	await client.remote({ action: "revoke", deviceId: device.id });
	ctx.ui.notify(`Revoked ${device.name}`, "info");
}

function factory(pi: ExtensionAPI): void {
	pi.registerCommand("remote-control", {
		description: "Control sessions from your phone: on/off, pair, devices",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub && sub !== "pair" && sub !== "devices") {
				ctx.ui.notify("Usage: /remote-control [pair | devices]", "warning");
				return;
			}
			const client = await daemon();
			if (!client) {
				ctx.ui.notify("The agent daemon is not running and could not be started", "error");
				return;
			}
			try {
				if (sub === "devices") return await devices(client, ctx);
				if (sub === "pair") return await show(await client.remote({ action: "pair" }), ctx);
				const status = await client.remote({ action: "status" });
				if (status.enabled) {
					await client.remote({ action: "off" });
					ctx.ui.notify("Remote control is off", "info");
					return;
				}
				const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
				await show(await client.remote({ action: "on", port: remotePort(settings) }), ctx);
			} catch (error) {
				ctx.ui.notify(`Remote control: ${message(error)}`, "error");
			}
		},
	});
}

const remoteExtension: InlineExtension = { name: "remote", factory };
export default remoteExtension.factory;
```

- [ ] **Step 3: Register the extension**

`ext/index.ts`: add `import remote from "./remote/index.ts";` (alphabetical among the imports) and `{ name: "remote", factory: remote },` right after the `agent-view` entry.

`package.json` `pi.extensions`: add `"./ext/remote/index.ts"` right after `"./ext/agent-view/index.ts"`.

`ext/help/categories.ts`: add `"remote-control": "Session",` right after `"agent-view": "Session",`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/registration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (ask first)

```bash
git add ext/remote/index.ts ext/index.ts package.json ext/help/categories.ts test/registration.test.ts
git commit -m "feat(remote): /remote-control turns remote control on and pairs a phone"
```

---

### Task 10: The PWA

**Files:**
- Create: `daemon/remote/web/index.html`, `manifest.webmanifest`, `style.css`, `api.js`, `app.js`, `sw.js`, `tsconfig.json`
- Modify: `package.json` (`typecheck` script), `biome.json` (`files.includes`)

User-facing copy is English, like the rest of bluclawd.

- [ ] **Step 1: `daemon/remote/web/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="bluclawd">
<meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="stylesheet" href="style.css">
<title>bluclawd</title>
</head>
<body>
<main id="app"></main>
<script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: `daemon/remote/web/manifest.webmanifest`**

```json
{
	"name": "bluclawd",
	"short_name": "bluclawd",
	"start_url": "/",
	"scope": "/",
	"display": "standalone",
	"background_color": "#141414",
	"theme_color": "#141414"
}
```

- [ ] **Step 3: `daemon/remote/web/style.css`**

```css
/* bluclawd's palettes (themes/bluclawd.json, bluclawd-light.json), following the phone's appearance. */
:root {
	--bg: #ffffff;
	--panel: #f5f5f5;
	--message: #f0f0f0;
	--text: #000000;
	--muted: #8a8a8a;
	--dim: #666666;
	--line: #e5e5e5;
	--accent: #00c0e8;
	--red: #ab2b3f;
	--yellow: #b07d00;
	color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #141414;
		--panel: #262626;
		--message: #373737;
		--text: #ffffff;
		--muted: #999999;
		--dim: #505050;
		--line: #2a2a2a;
		--red: #ff6b80;
		--yellow: #ffc107;
	}
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; -webkit-text-size-adjust: 100%; }
#app { height: 100dvh; display: flex; flex-direction: column; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.mono, .row small, .t { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.bar h1 { font-size: 20px; margin: 0; flex: 1; }
.title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.back { color: var(--accent); text-decoration: none; white-space: nowrap; }
.stop { background: none; border: 0; color: var(--red); font: inherit; font-weight: 600; padding: 0; }
.muted { color: var(--muted); font-size: 13px; }
.scroll { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.band { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 16px 16px 4px; font-weight: 500; }
.row { display: flex; gap: 10px; align-items: baseline; padding: 10px 16px; border-bottom: 1px solid var(--line); color: inherit; text-decoration: none; }
.row .name { flex: 1; min-width: 0; }
.row small { display: block; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.age { color: var(--muted); font-size: 12px; }
.glyph { width: 14px; text-align: center; color: var(--dim); }
.glyph.needs { color: var(--yellow); }
.glyph.failed { color: var(--red); }
.glyph.working { color: var(--accent); }
.glyph.working::before { content: "◐"; display: inline-block; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.log { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.u { align-self: flex-end; max-width: 85%; background: var(--message); border-radius: 16px; padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.a { white-space: pre-wrap; overflow-wrap: anywhere; }
.t { font-size: 12px; line-height: 1.45; background: var(--panel); border-left: 2px solid var(--accent); border-radius: 4px; padding: 6px 10px; color: var(--muted); overflow-wrap: anywhere; }
.t.err { border-left-color: var(--red); }
.t summary, .think summary { list-style: none; cursor: pointer; }
.t summary::-webkit-details-marker, .think summary::-webkit-details-marker { display: none; }
.t pre, .think pre { white-space: pre-wrap; margin: 6px 0 0; color: var(--text); font: inherit; }
.think { font-size: 13px; color: var(--muted); font-style: italic; }
.think summary::before { content: "▸ "; }
.think[open] summary::before { content: "▾ "; }
.marker { align-self: center; font-size: 12px; color: var(--muted); text-align: center; }
.queued { align-self: flex-end; font-size: 11px; color: var(--muted); margin-top: -4px; }
.working { color: var(--accent); font-size: 14px; }
.banner { margin: 8px 16px 0; padding: 8px 10px; border-radius: 8px; font-size: 13px; background: color-mix(in srgb, var(--yellow) 18%, var(--bg)); }
.banner.off { background: color-mix(in srgb, var(--red) 18%, var(--bg)); }
.composer { display: flex; gap: 8px; align-items: flex-end; padding: 8px 12px; border-top: 1px solid var(--line); }
.composer textarea { flex: 1; resize: none; border: 0; border-radius: 18px; padding: 8px 14px; background: var(--panel); color: var(--text); font: inherit; max-height: 140px; }
.send { width: 34px; height: 34px; flex: none; border-radius: 50%; border: 0; background: var(--accent); color: #000; font-size: 18px; }
.empty { color: var(--muted); text-align: center; margin: 40px 16px; }
.pair { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px; padding: 24px; text-align: center; }
.pair .logo { font-size: 40px; color: var(--accent); }
.pair input { font: 28px ui-monospace, Menlo, monospace; letter-spacing: .3em; text-align: center; width: 9ch; padding: 10px; border-radius: 10px; border: 1px solid var(--muted); background: var(--panel); color: var(--text); }
.pair button { background: var(--accent); color: #000; border: 0; border-radius: 12px; padding: 12px 40px; font: inherit; font-weight: 600; }
.error { color: var(--red); font-size: 14px; min-height: 1.4em; }
```

- [ ] **Step 4: `daemon/remote/web/api.js`**

```js
// @ts-check
/** The daemon's /api, with the paired device's token from this app's own storage. */

const TOKEN_KEY = "bluclawd.token";

export function getToken() {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

/** @param {string} token */
export function setToken(token) {
	localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
	try {
		localStorage.removeItem(TOKEN_KEY);
	} catch {
		// storage blocked: nothing to clear
	}
}

/** The token was revoked (or never valid): the app goes back to pairing. */
export class Unauthorized extends Error {}

/**
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<any>}
 */
async function call(method, path, body) {
	/** @type {Record<string, string>} */
	const headers = { authorization: `Bearer ${getToken() ?? ""}` };
	if (body) headers["content-type"] = "application/json";
	const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
	if (res.status === 401) {
		clearToken();
		throw new Unauthorized("unauthorized");
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

/** @param {string} id */
const session = (id) => `/api/sessions/${encodeURIComponent(id)}`;

export const api = {
	/** @param {string} code @param {string} deviceName @returns {Promise<string>} */
	async pair(code, deviceName) {
		const res = await fetch("/api/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, deviceName }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
		return data.token;
	},
	sessions: async () => (await call("GET", "/api/sessions")).sessions,
	/** @param {string} id */
	messages: async (id) => (await call("GET", `${session(id)}/messages?limit=100`)).messages,
	/** @param {string} id @param {string} text */
	prompt: (id, text) => call("POST", `${session(id)}/prompt`, { text }),
	/** @param {string} id */
	abort: (id) => call("POST", `${session(id)}/abort`, {}),
	/** @param {string | undefined} sessionId */
	events(sessionId) {
		const token = encodeURIComponent(getToken() ?? "");
		const open = sessionId ? `&session=${encodeURIComponent(sessionId)}` : "";
		return new EventSource(`/api/events?token=${token}${open}`);
	},
};
```

- [ ] **Step 5: `daemon/remote/web/app.js`**

```js
// @ts-check
/**
 * bluclawd's remote control on a phone: the session list (agent view's bands) and one
 * session's chat. Only the parts that change are re-rendered, so the composer keeps its text,
 * focus and keyboard while updates arrive.
 */
import { api, getToken, setToken, Unauthorized } from "./api.js";

/** @typedef {{ id: string, label: string, cwd: string, band: string, state: string, alive: boolean, detail: string, createdAt?: string, finishedAt?: string }} Session */
/** @typedef {{ kind: string, id: string, text?: string, thinking?: string, tools?: {id: string, name: string, summary: string}[], error?: string, toolCallId?: string, toolName?: string, ok?: boolean, truncated?: boolean }} Message */

const BANDS = [
	["pinned", "Pinned"],
	["needs", "Needs input"],
	["working", "Working"],
	["idle", "Idle"],
];
const OFFLINE_AFTER_MS = 5000;
const ERRORS = {
	session_not_running: "This session is not running. Open it on the Mac to continue.",
	unknown_session: "This session is gone.",
	invalid_code: "That code is wrong or was already used. Run /remote-control pair for a new one.",
	expired_code: "That code expired. Run /remote-control pair for a new one.",
};

const state = {
	/** @type {Session[]} */ sessions: [],
	/** @type {string | undefined} */ open: undefined,
	/** @type {Message[]} */ messages: [],
	/** @type {string[]} */ pending: [],
	online: true,
	/** @type {string | undefined} */ error: undefined,
};

/** @param {string} selector @returns {any} */
const $ = (selector) => document.querySelector(selector);
const app = $("#app");
/** @type {EventSource | undefined} */
let source;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let offlineTimer;
/** Which view the DOM holds: "pair", "list" or "chat:<id>". */
let shown = "";
let lastLog = "";

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @param {string | undefined} code */
function errorText(code) {
	return (code && ERRORS[/** @type {keyof typeof ERRORS} */ (code)]) || code || "Something went wrong";
}

/** @param {string | undefined} iso */
function age(iso) {
	const ms = iso ? Date.now() - Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(ms)) return "";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function deviceName() {
	const ua = navigator.userAgent;
	return /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Browser";
}

function standalone() {
	return matchMedia("(display-mode: standalone)").matches || /** @type {any} */ (navigator).standalone === true;
}

// ---- data ----

/** @param {unknown} error */
function handleError(error) {
	if (error instanceof Unauthorized) {
		source?.close();
		render();
		return;
	}
	state.error = errorText(error instanceof Error ? error.message : String(error));
	render();
}

async function loadSessions() {
	try {
		state.sessions = await api.sessions();
		state.error = undefined;
		render();
	} catch (error) {
		handleError(error);
	}
}

async function loadMessages() {
	const id = state.open;
	if (!id) return;
	try {
		/** @type {Message[]} */
		const messages = await api.messages(id);
		if (state.open !== id) return;
		state.messages = messages;
		// A sent prompt is pending until the transcript shows it.
		state.pending = state.pending.filter((text) => !messages.some((m) => m.kind === "user" && m.text === text));
		render();
	} catch (error) {
		handleError(error);
	}
}

/** @param {boolean} online */
function setOnline(online) {
	if (state.online === online) return;
	state.online = online;
	render();
}

/** One stream, reopened for the session on screen; any (re)open refetches everything. */
function connect() {
	source?.close();
	source = undefined;
	if (!getToken()) return;
	const current = api.events(state.open);
	source = current;
	current.onopen = () => {
		clearTimeout(offlineTimer);
		offlineTimer = undefined;
		setOnline(true);
		void loadSessions();
		void loadMessages();
	};
	current.addEventListener("sessions", () => void loadSessions());
	current.addEventListener("messages", () => void loadMessages());
	current.onerror = () => {
		offlineTimer ??= setTimeout(() => setOnline(false), OFFLINE_AFTER_MS);
		// EventSource gives up on an HTTP error, such as a revoked token: find out which, then retry.
		if (current.readyState === EventSource.CLOSED && source === current) {
			setTimeout(() => {
				if (source === current) void loadSessions().then(connect);
			}, 3000);
		}
	};
}

// ---- views ----

function pairView() {
	const hint = standalone()
		? "Enter the code <code>/remote-control</code> shows on your Mac."
		: "First add this page to your Home Screen (Share → Add to Home Screen), open it from there, then pair.";
	return `<form class="pair" id="pair">
<div class="logo">✻</div><h1>bluclawd</h1><p class="muted">${hint}</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-label="Pairing code">
<button>Pair</button><div class="error" id="pair-error"></div></form>`;
}

function listShell() {
	return `<header class="bar"><h1>Sessions</h1><span class="muted" id="online"></span></header>
<div id="banner"></div><section class="scroll" id="rows"></section>`;
}

/** @param {Session} s */
function rowHtml(s) {
	const glyph = s.state === "needs" ? "✻" : s.state === "working" ? "" : "∙";
	return `<a class="row" href="#s/${encodeURIComponent(s.id)}"><span class="glyph ${esc(s.state)}">${glyph}</span>
<span class="name">${esc(s.label)}<small>${esc(s.detail || s.state)}</small></span>
<span class="age">${age(s.finishedAt ?? s.createdAt)}</span></a>`;
}

function rowsHtml() {
	if (state.sessions.length === 0) return `<p class="empty">No sessions. Start one in agent view on the Mac.</p>`;
	return BANDS.map(([key, title]) => {
		const rows = state.sessions.filter((s) => s.band === key);
		return rows.length ? `<h2 class="band">${title}</h2>${rows.map(rowHtml).join("")}` : "";
	}).join("");
}

function chatShell() {
	return `<header class="bar"><a class="back" href="#">‹ Sessions</a><span class="title" id="title"></span>
<button class="stop" id="stop" hidden>Stop</button></header>
<div id="banner"></div><section class="scroll" id="scroll"><div class="log" id="log"></div></section>
<form class="composer" id="composer"><textarea id="text" rows="1" placeholder="Reply"></textarea>
<button class="send" aria-label="Send">↑</button></form>`;
}

/** @param {string} name @param {string} summary @param {Message | undefined} result @param {string} key */
function toolHtml(name, summary, result, key) {
	const title = `${esc(name.charAt(0).toUpperCase() + name.slice(1))}(${esc(summary)})`;
	if (!result) return `<div class="t">${title}</div>`;
	const first = (result.text ?? "").split("\n").find((line) => line.trim()) ?? (result.ok ? "done" : "error");
	return `<details class="t${result.ok ? "" : " err"}" data-key="${esc(key)}"><summary>${title}<br>⎿ ${esc(first)}</summary>
<pre>${esc(result.text ?? "")}${result.truncated ? "\n…" : ""}</pre></details>`;
}

/** @param {Session | undefined} session */
function logHtml(session) {
	/** @type {Map<string, Message>} */
	const results = new Map();
	for (const m of state.messages) if (m.kind === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	const calls = new Set(state.messages.flatMap((m) => (m.tools ?? []).map((t) => t.id)));
	const parts = [];
	for (const m of state.messages) {
		if (m.kind === "user") parts.push(`<div class="u">${esc(m.text)}</div>`);
		else if (m.kind === "assistant") {
			if (m.thinking) {
				parts.push(
					`<details class="think" data-key="think:${esc(m.id)}"><summary>Thinking</summary><pre>${esc(m.thinking)}</pre></details>`,
				);
			}
			if (m.text) parts.push(`<div class="a">${esc(m.text)}</div>`);
			for (const tool of m.tools ?? []) parts.push(toolHtml(tool.name, tool.summary, results.get(tool.id), tool.id));
			if (m.error) parts.push(`<div class="t err">${esc(m.error)}</div>`);
		} else if (m.kind === "toolResult" && !(m.toolCallId && calls.has(m.toolCallId))) {
			parts.push(toolHtml(m.toolName ?? "tool", "", m, m.id));
		} else if (m.kind === "marker") parts.push(`<div class="marker">${esc(m.text)}</div>`);
	}
	for (const text of state.pending) {
		parts.push(`<div class="u">${esc(text)}</div><div class="queued">sent · waiting for the session</div>`);
	}
	if (session?.state === "working") parts.push(`<div class="working">✻ ${esc(session.detail || "Working…")}</div>`);
	return parts.length ? parts.join("") : `<p class="empty">Nothing in this session yet.</p>`;
}

/** @param {Session | undefined} session */
function bannerHtml(session) {
	if (!state.online) return `<div class="banner off">Mac unreachable. Retrying…</div>`;
	if (state.error) return `<div class="banner off">${esc(state.error)}</div>`;
	if (session?.state === "needs") {
		return `<div class="banner">This session is waiting for an answer to a dialog on the Mac. A reply sent here becomes its next prompt.</div>`;
	}
	return "";
}

// ---- render ----

function render() {
	const view = !getToken() ? "pair" : state.open ? `chat:${state.open}` : "list";
	if (view !== shown) {
		shown = view;
		lastLog = "";
		app.innerHTML = view === "pair" ? pairView() : view === "list" ? listShell() : chatShell();
		if (view === "pair") bindPair();
		else if (view !== "list") bindChat();
	}
	if (view === "list") updateList();
	else if (view !== "pair") updateChat();
}

function updateList() {
	$("#online").textContent = state.online ? "● online" : "offline";
	$("#banner").innerHTML = bannerHtml(undefined);
	$("#rows").innerHTML = rowsHtml();
}

function updateChat() {
	const session = state.sessions.find((s) => s.id === state.open);
	$("#title").textContent = session?.label ?? "";
	$("#stop").hidden = session?.state !== "working";
	$("#banner").innerHTML = bannerHtml(session);
	const html = logHtml(session);
	if (html !== lastLog) {
		lastLog = html;
		const scroll = $("#scroll");
		const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
		const log = $("#log");
		const open = new Set([...log.querySelectorAll("details[open]")].map((d) => d.dataset.key));
		log.innerHTML = html;
		for (const d of log.querySelectorAll("details")) if (open.has(d.dataset.key)) d.open = true;
		if (atBottom) scroll.scrollTop = scroll.scrollHeight;
	}
	const text = $("#text");
	const stopped = session !== undefined && !session.alive;
	text.disabled = stopped;
	text.placeholder = stopped ? "Open this session on the Mac to continue" : "Reply";
}

function bindPair() {
	$("#pair").addEventListener("submit", async (/** @type {Event} */ event) => {
		event.preventDefault();
		const code = $("#code").value.replace(/\D/g, "");
		try {
			setToken(await api.pair(code, deviceName()));
			render();
			connect();
		} catch (error) {
			$("#pair-error").textContent = errorText(error instanceof Error ? error.message : String(error));
		}
	});
}

function bindChat() {
	const text = $("#text");
	text.addEventListener("input", () => {
		text.style.height = "auto";
		text.style.height = `${Math.min(text.scrollHeight, 140)}px`;
	});
	$("#composer").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		void send();
	});
	$("#stop").addEventListener("click", async () => {
		const id = state.open;
		if (!id) return;
		try {
			await api.abort(id);
		} catch (error) {
			handleError(error);
		}
	});
}

async function send() {
	const text = $("#text");
	const value = text.value.trim();
	const id = state.open;
	if (!value || !id) return;
	text.value = "";
	text.style.height = "auto";
	state.pending.push(value);
	render();
	try {
		await api.prompt(id, value);
	} catch (error) {
		state.pending = state.pending.filter((p) => p !== value);
		text.value = value;
		handleError(error);
	}
}

// ---- routing ----

function route() {
	const match = /^#s\/(.+)$/.exec(location.hash);
	const open = match ? decodeURIComponent(match[1]) : undefined;
	if (open !== state.open) {
		state.open = open;
		state.messages = [];
		state.pending = [];
		state.error = undefined;
		connect();
	}
	render();
}

window.addEventListener("hashchange", route);
// iOS suspends a backgrounded app's stream: reopen it on return.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") connect();
});
setInterval(() => {
	if (shown === "list") updateList();
}, 30_000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

state.open = /^#s\/(.+)$/.exec(location.hash)?.[1];
if (state.open) state.open = decodeURIComponent(state.open);
render();
connect();
```

- [ ] **Step 6: `daemon/remote/web/sw.js`**

```js
// Caches the app shell so the app opens, and says the Mac is unreachable, when the Mac is not.
// The API is never cached.
const CACHE = "bluclawd-shell-v1";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/api.js", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
	// Network first: a new build shows at once; the cache is only for when the Mac is unreachable.
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				const copy = response.clone();
				caches.open(CACHE).then((cache) => cache.put(event.request, copy));
				return response;
			})
			.catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("/"))),
	);
});
```

- [ ] **Step 7: `daemon/remote/web/tsconfig.json` and the scripts**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"lib": ["ES2022", "DOM", "DOM.Iterable"],
		"allowJs": true,
		"checkJs": true,
		"noEmit": true,
		"strict": false,
		"skipLibCheck": true,
		"types": []
	},
	"include": ["*.js"],
	"exclude": ["sw.js"]
}
```

`sw.js` runs in a service worker scope, which DOM types do not describe, so it is left out.

`package.json`: change the `typecheck` script to `"tsc --noEmit && tsc -p daemon/remote/web"`.

`biome.json`: add `"daemon/remote/web/**/*.js"` to `files.includes`.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0. If biome reports formatting, run `npx biome check --write daemon/remote/web` and re-run. Fix any remaining lint rule by hand (do not disable rules).

- [ ] **Step 9: Serve the PWA locally and look at it**

Start an isolated daemon and turn remote control on:

```bash
export PI_SERVER_DIR="$(mktemp -d)"
node --import ./daemon/pi-resolve-hook.mjs daemon/cli.ts serve &
node --input-type=module -e '
import { OrchestratorClient } from "./ext/agent-view/orchestrator-client.ts";
console.log(await new OrchestratorClient().remote({ action: "on", port: 7979 }));'
```

Expected: an object with `listening: true` and a 6-digit `code`. Open `http://127.0.0.1:7979` in a desktop browser with a phone-sized viewport (Chrome DevTools device mode, iPhone): the pairing screen shows. Enter the code: the Sessions screen shows "No sessions…". Then `kill %1` and `rm -rf "$PI_SERVER_DIR"`.

- [ ] **Step 10: Commit** (ask first)

```bash
git add daemon/remote/web package.json biome.json
git commit -m "feat(remote): the phone app: pairing, session list, chat"
```

---

### Task 11: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document it**

In the extension table, after the `agent-view` row, add:

```markdown
| `remote` | `/remote-control` |
```

In the command table, after the `←` / agent view row, add:

```markdown
| `/remote-control` | Claude Code's Remote Control, for every agent-view session: a phone app (a PWA the daemon serves) lists them in agent view's bands, shows a session's conversation, sends it a prompt and stops its turn. `/remote-control` turns it on (and off), `/remote-control pair` shows a new pairing code, `/remote-control devices` lists and revokes paired phones — see [Remote control](#remote-control) |
```

Before `## What this layer cannot do`, add:

```markdown
## Remote control

The daemon serves a phone app on `127.0.0.1` only (port 7878, or `"remote": { "port": … }` in
settings); the phone reaches it over [Tailscale](https://tailscale.com), never the LAN or the
internet. Once, on the Mac: install Tailscale and log in, then run `/remote-control` in any pi
session. It offers to run `tailscale serve --bg 7878`, which gives this Mac an HTTPS address on
your tailnet, and shows that address and a 6-digit code (5 minutes, single use). On the phone,
also on your tailnet: open the address in Safari, Share → Add to Home Screen, open the app from
the Home Screen and enter the code. The phone keeps a token; the daemon keeps only its hash, in
`~/.pi/server/remote.json`.

What the phone cannot do yet: new or resumed sessions, token-by-token streaming (a reply shows
when its message is complete, and a prompt reaches its session within the 3 s heartbeat),
answering a session's open dialog, push notifications, `/compact`, model switching, and
tree / fork. The daemon must be running (any `pi` starts it) and the Mac awake.
```

- [ ] **Step 2: Commit** (ask first)

```bash
git add README.md
git commit -m "docs: remote control from a phone"
```

---

### Task 12: Full verification

- [ ] **Step 1: Run every gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all exit 0; the test summary shows every suite passing (the earlier 446 tests plus the new remote suites). Report the actual counts. If lint reports only formatting in the new files, run `npx biome check --write` on them and re-run.

- [ ] **Step 2: Live check on this Mac**

1. Quit every running `pi` (the daemon restarts on the changed build), then start `pi` in a project and send it a short task so it is a live agent-view session.
2. Run `/remote-control`. Expected: the confirm prompt for `tailscale serve`, then the pairing text with an `https://….ts.net` URL and a code.
3. `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7878/api/sessions` prints `401`.
4. `TOKEN=$(curl -s -X POST http://127.0.0.1:7878/api/pair -d '{"code":"<code>","deviceName":"curl"}' | jq -r .token)`, then `curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7878/api/sessions | jq` lists the session.
5. `curl -s -X POST -H "authorization: Bearer $TOKEN" http://127.0.0.1:7878/api/sessions/<id>/prompt -d '{"text":"say hi"}'` returns `{"ok":true}`, and within 3 s the pi session starts a turn with "say hi".
6. `/remote-control devices` lists "curl"; revoke it, and step 4's sessions call returns 401.

- [ ] **Step 3: Live check on the iPhone**

On the iPhone (Tailscale app connected): open the `https://….ts.net` URL, Add to Home Screen, open it, pair with `/remote-control pair`'s code. Check: the session list matches agent view; open a session; send a prompt and see it appear as "sent · waiting", then in the transcript, then the reply; Stop ends a running turn; turn Wi-Fi off and on: the "Mac unreachable" banner appears and clears.

- [ ] **Step 4: Report**

Report each command's actual output, and anything that did not behave as listed above.
