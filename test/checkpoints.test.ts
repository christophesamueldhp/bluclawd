import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureCheckpoint,
	checkpointForTurn,
	factory,
	isGitRepo,
	listCheckpoints,
	pruneCheckpointRefs,
	restoreCheckpoint,
} from "../ext/checkpoints/index.ts";

type Exec = ExtensionAPI["exec"];

// ── harness ──────────────────────────────────────────────────────────────────

/** Keep the user's real git config out of the fixtures (hooksPath, gpgsign, fsmonitor, ...). */
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

/** Same contract as pi's (unexported) execCommand: resolves {code, stdout, stderr, killed}, never rejects. */
function makeExec(): Exec {
	return (command, args, options) =>
		new Promise((resolve) => {
			execFile(
				command,
				args,
				{ cwd: options?.cwd, timeout: options?.timeout, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 },
				(error, stdout, stderr) => {
					const err = error as (Error & { code?: unknown; killed?: boolean }) | null;
					const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
					resolve({ stdout, stderr, code, killed: Boolean(err?.killed) });
				},
			);
		});
}

/** Fail the first exec whose args contain `marker`; pass everything else through. */
function failOnce(exec: Exec, marker: string): Exec {
	let fired = false;
	return async (command, args, options) => {
		if (!fired && args.includes(marker)) {
			fired = true;
			return { stdout: "", stderr: "injected failure", code: 1, killed: false };
		}
		return exec(command, args, options);
	};
}

const cleanups: string[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(opts: { commit?: boolean } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "bluclawd-cp-test-"));
	cleanups.push(dir);
	const exec = makeExec();
	const git = async (...args: string[]): Promise<string> => {
		const r = await exec("git", args, { cwd: dir });
		if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
		return r.stdout;
	};
	const write = (name: string, content: string) => writeFile(join(dir, name), content);
	const read = (name: string) => readFile(join(dir, name), "utf8");
	const status = async () =>
		(await git("status", "--porcelain"))
			.split("\n")
			.filter(Boolean)
			.sort();
	await git("init", "-q");
	await git("config", "user.email", "test@bluclawd.local");
	await git("config", "user.name", "bluclawd test");
	if (opts.commit !== false) {
		await write("a.txt", "base\n");
		await git("add", "-A");
		await git("commit", "-q", "-m", "init");
	}
	return { dir, exec, git, write, read, status };
}

/** Capture with the real function and assert it worked, so failures point at capture, not the test. */
async function capture(dir: string, exec: Exec): Promise<string> {
	const sha = await captureCheckpoint(dir, exec);
	expect(sha).toMatch(/^[0-9a-f]{40}$/);
	return sha as string;
}

let nextEntryId = 1;
function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	} as unknown as SessionEntry;
}
function checkpointEntry(sha: string, turnEntryId: string, subject: string, id = `cp${nextEntryId++}`): SessionEntry {
	return {
		type: "custom",
		customType: "checkpoint",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		data: { sha, turnEntryId, subject },
	} as SessionEntry;
}

/** Drive `factory(pi)` with a recording stub; `appendEntry` lands on the same `entries` array `getBranch` returns. */
function loadFactory(exec: Exec, entries: SessionEntry[]) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		exec,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) =>
			handlers.set(event, handler),
		registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, def.handler),
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				customType,
				data,
				id: `appended${nextEntryId++}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
			} as SessionEntry);
		},
	} as unknown as ExtensionAPI;
	factory(pi);
	return { handlers, commands };
}

/** Scripted UI: `select` answers are option indexes, `confirm` answers are booleans, both consumed in order. */
function makeCtx(dir: string, entries: SessionEntry[], script: { select?: number[]; confirm?: boolean[] } = {}) {
	const selects = [...(script.select ?? [])];
	const confirms = [...(script.confirm ?? [])];
	const notices: Array<{ message: string; type?: string }> = [];
	const navigated: string[] = [];
	const ctx = {
		cwd: dir,
		hasUI: true,
		ui: {
			select: async (_title: string, options: string[]) => {
				const i = selects.shift();
				return i === undefined ? undefined : options[i];
			},
			confirm: async () => confirms.shift() ?? false,
			notify: (message: string, type?: string) => notices.push({ message, type }),
			input: async () => undefined,
		},
		sessionManager: { getBranch: () => entries, getLeafEntry: () => entries.at(-1) },
		navigateTree: async (id: string) => {
			navigated.push(id);
			return { cancelled: false };
		},
	} as unknown as ExtensionContext;
	return { ctx, notices, navigated };
}

const appendedSubjects = (entries: SessionEntry[]) => listCheckpoints(entries).map((c) => c.subject);

// ── unit: pure helpers ───────────────────────────────────────────────────────

describe("listCheckpoints", () => {
	it("keeps only checkpoint entries with a sha, newest first, with defaults filled in", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", "first"),
			checkpointEntry("a".repeat(40), "u1", "first", "c1"),
			{ type: "custom", customType: "other", id: "x", parentId: null, timestamp: "t", data: { sha: "z" } } as SessionEntry,
			{ type: "custom", customType: "checkpoint", id: "bad", parentId: null, timestamp: "t", data: {} } as SessionEntry,
			{
				type: "custom",
				customType: "checkpoint",
				id: "c2",
				parentId: null,
				timestamp: "t2",
				data: { sha: "b".repeat(40) },
			} as SessionEntry,
		];
		const list = listCheckpoints(entries);
		expect(list.map((c) => c.entryId)).toEqual(["c2", "c1"]);
		expect(list[0]).toMatchObject({ turnEntryId: "", subject: "(no subject)", timestamp: "t2" });
		expect(list[1]).toMatchObject({ turnEntryId: "u1", subject: "first" });
	});
});

describe("checkpointForTurn", () => {
	it("returns the OLDEST checkpoint of a turn — the tree before the prompt did anything", () => {
		const entries = [
			userEntry("u1", "do work"),
			checkpointEntry("1".repeat(40), "u1", "do work", "older"),
			checkpointEntry("2".repeat(40), "u1", "do work", "newer"),
			userEntry("u2", "more"),
			checkpointEntry("3".repeat(40), "u2", "more", "other-turn"),
		];
		expect(checkpointForTurn(entries, "u1")?.entryId).toBe("older");
		expect(checkpointForTurn(entries, "u2")?.entryId).toBe("other-turn");
	});

	it("returns undefined when the turn has no checkpoint", () => {
		expect(checkpointForTurn([userEntry("u1", "x")], "u1")).toBeUndefined();
	});
});
