import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
function makeExec(extraEnv: Record<string, string> = {}): Exec {
	return (command, args, options) =>
		new Promise((resolve) => {
			execFile(
				command,
				args,
				{
					cwd: options?.cwd,
					timeout: options?.timeout,
					env: { ...GIT_ENV, ...extraEnv },
					maxBuffer: 64 * 1024 * 1024,
				},
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
	const status = async () => (await git("status", "--porcelain")).split("\n").filter(Boolean).sort();
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

const SESSION = "session-a";

/** Capture with the real function and assert it worked, so failures point at capture, not the test. */
async function capture(dir: string, exec: Exec): Promise<string> {
	const sha = await captureCheckpoint(dir, exec, SESSION);
	expect(sha).toMatch(/^[0-9a-f]{40}$/);
	return sha as string;
}

/** A checkpoint-shaped commit of the current index, dated `daysAgo` days back, not yet under any ref. */
async function commitAt(dir: string, daysAgo: number): Promise<string> {
	const date = `${Math.floor(Date.now() / 1000) - daysAgo * 86400} +0000`;
	const exec = makeExec({
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
		GIT_AUTHOR_NAME: "x",
		GIT_AUTHOR_EMAIL: "x@x",
		GIT_COMMITTER_NAME: "x",
		GIT_COMMITTER_EMAIL: "x@x",
	});
	const tree = (await exec("git", ["write-tree"], { cwd: dir })).stdout.trim();
	const commit = await exec("git", ["commit-tree", tree, "-m", `fixture ${daysAgo}d`], { cwd: dir });
	expect(commit.code).toBe(0);
	return commit.stdout.trim();
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
		sessionManager: { getBranch: () => entries, getLeafEntry: () => entries.at(-1), getSessionId: () => SESSION },
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
			{
				type: "custom",
				customType: "other",
				id: "x",
				parentId: null,
				timestamp: "t",
				data: { sha: "z" },
			} as SessionEntry,
			{
				type: "custom",
				customType: "checkpoint",
				id: "bad",
				parentId: null,
				timestamp: "t",
				data: {},
			} as SessionEntry,
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

// ── integration: exported git functions ──────────────────────────────────────

describe("captureCheckpoint", () => {
	it("returns undefined outside a git repository", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bluclawd-cp-nogit-"));
		cleanups.push(dir);
		const exec = makeExec();
		expect(await isGitRepo(dir, exec)).toBe(false);
		expect(await captureCheckpoint(dir, exec, SESSION)).toBeUndefined();
	});

	it("never changes git status or the real index, and leaves no temp index behind", async () => {
		const { dir, exec, write, status } = await makeRepo();
		await write("a.txt", "edited\n");
		await write("new.txt", "new\n");
		const statusBefore = await status();
		const indexBefore = await readFile(join(dir, ".git", "index"));

		await capture(dir, exec);

		const indexAfter = await readFile(join(dir, ".git", "index"));
		expect(indexAfter.equals(indexBefore)).toBe(true);
		expect(await status()).toEqual(statusBefore);
		expect(statusBefore).toEqual([" M a.txt", "?? new.txt"]);
		const leftovers = (await readdir(tmpdir())).filter((f) => f.startsWith("bluclawd-checkpoint-"));
		expect(leftovers).toEqual([]);
	});

	it("records the sha under refs/bluclawd/checkpoints/<sessionId>/ with the commit as parent", async () => {
		const { dir, exec, git } = await makeRepo();
		const sha = await capture(dir, exec);
		expect((await git("rev-parse", `refs/bluclawd/checkpoints/${SESSION}/${sha}`)).trim()).toBe(sha);
		expect((await git("rev-parse", `${sha}^`)).trim()).toBe((await git("rev-parse", "HEAD")).trim());
	});
});

describe("pruneCheckpointRefs", () => {
	it("keeps own-branch refs, drops own and legacy strays, and drops foreign refs only past the TTL", async () => {
		const { dir, exec, git, write } = await makeRepo();
		const keep = await capture(dir, exec);
		await write("a.txt", "second\n");
		const ownStray = await capture(dir, exec);
		expect(keep).not.toBe(ownStray);
		const legacy = await commitAt(dir, 0);
		await git("update-ref", `refs/bluclawd/checkpoints/${legacy}`, legacy);
		const foreignFresh = await commitAt(dir, 1);
		await git("update-ref", `refs/bluclawd/checkpoints/session-b/${foreignFresh}`, foreignFresh);
		const foreignOld = await commitAt(dir, 31);
		await git("update-ref", `refs/bluclawd/checkpoints/session-b/${foreignOld}`, foreignOld);

		expect(await pruneCheckpointRefs(dir, exec, SESSION, new Set([keep]))).toBe(3);
		const refs = (await git("for-each-ref", "--format=%(refname)", "refs/bluclawd/checkpoints/"))
			.trim()
			.split("\n")
			.sort();
		expect(refs).toEqual(
			[`refs/bluclawd/checkpoints/${SESSION}/${keep}`, `refs/bluclawd/checkpoints/session-b/${foreignFresh}`].sort(),
		);
	});

	it("keeps a legacy flat ref that the current branch still references", async () => {
		const { dir, git } = await makeRepo();
		const legacy = await commitAt(dir, 0);
		await git("update-ref", `refs/bluclawd/checkpoints/${legacy}`, legacy);
		expect(await pruneCheckpointRefs(dir, makeExec(), SESSION, new Set([legacy]))).toBe(0);
	});
});

describe("restoreCheckpoint — tracked files that match .gitignore", () => {
	it("captures their modifications and keeps them on restore", async () => {
		const { dir, exec, git, write, read } = await makeRepo();
		await write("cfg.txt", "committed\n");
		await write(".gitignore", "cfg.txt\n");
		await git("add", "-f", "cfg.txt", ".gitignore");
		await git("commit", "-q", "-m", "track cfg then ignore it");
		expect((await git("ls-files")).split("\n")).toContain("cfg.txt");
		await write("cfg.txt", "checkpointed\n");

		const sha = await capture(dir, exec);
		expect((await git("ls-tree", "--name-only", sha)).split("\n")).toContain("cfg.txt");

		await write("cfg.txt", "later\n");
		expect(await restoreCheckpoint(dir, exec, sha)).toBe(true);
		expect(await read("cfg.txt")).toBe("checkpointed\n");
	});
});

describe("restoreCheckpoint — index state afterwards", () => {
	it("leaves modified files unstaged and new files untracked; later files survive", async () => {
		const { dir, exec, write, read, status } = await makeRepo();
		await write("a.txt", "v1\n");
		await write("new.txt", "new\n");
		const sha = await capture(dir, exec);

		await write("a.txt", "v2\n");
		await write("later.txt", "later\n");
		expect(await restoreCheckpoint(dir, exec, sha)).toBe(true);

		expect(await read("a.txt")).toBe("v1\n");
		expect(await read("later.txt")).toBe("later\n");
		expect(await status()).toEqual([" M a.txt", "?? later.txt", "?? new.txt"]);
	});

	it("works on an unborn HEAD (fresh git init, no commits)", async () => {
		const { dir, exec, write, read, status } = await makeRepo({ commit: false });
		await write("a.txt", "first\n");
		const sha = await capture(dir, exec);
		await write("a.txt", "changed\n");
		expect(await restoreCheckpoint(dir, exec, sha)).toBe(true);
		expect(await read("a.txt")).toBe("first\n");
		expect(await status()).toEqual(["?? a.txt"]);
	});
});

// ── integration: handlers through the factory ────────────────────────────────

describe("/rewind (files only)", () => {
	it("checkpoints the current tree as a safety net, then restores the chosen one", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "make v1"), checkpointEntry(sha, "u1", "make v1")];
		await write("a.txt", "v2\n");

		const { commands } = loadFactory(exec, entries);
		// select 0 = the only checkpoint, select 0 = "Files only", confirm = overwrite
		const { ctx, notices, navigated } = makeCtx(dir, entries, { select: [0, 0], confirm: [true] });
		await commands.get("rewind")?.("", ctx);

		expect(await read("a.txt")).toBe("v1\n");
		expect(appendedSubjects(entries)).toContain("(before rewind)");
		expect(notices.at(-1)?.message).toContain("restored");
		expect(navigated).toEqual([]);

		// The safety net itself restores v2.
		const safety = listCheckpoints(entries).find((c) => c.subject === "(before rewind)");
		expect(await restoreCheckpoint(dir, exec, safety?.sha ?? "")).toBe(true);
		expect(await read("a.txt")).toBe("v2\n");
	});

	it("is fail-closed: a failed safety capture aborts unless the user opts into the unsafe path", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "make v1"), checkpointEntry(sha, "u1", "make v1")];
		await write("a.txt", "v2\n");

		const { commands } = loadFactory(failOnce(exec, "write-tree"), entries);
		const declined = makeCtx(dir, entries, { select: [0, 0], confirm: [true, false] });
		await commands.get("rewind")?.("", declined.ctx);
		expect(await read("a.txt")).toBe("v2\n");
		expect(declined.notices.at(-1)).toMatchObject({ type: "error" });
		expect(declined.notices.at(-1)?.message).toContain("aborted");
		expect(appendedSubjects(entries)).not.toContain("(before rewind)");

		const { commands: again } = loadFactory(failOnce(exec, "write-tree"), entries);
		const accepted = makeCtx(dir, entries, { select: [0, 0], confirm: [true, true] });
		await again.get("rewind")?.("", accepted.ctx);
		expect(await read("a.txt")).toBe("v1\n");
		expect(appendedSubjects(entries)).not.toContain("(before rewind)");
	});
});

describe("session_before_fork", () => {
	it("restores the OLDEST checkpoint of the forked turn and takes a safety net first", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "before-prompt\n");
		const older = await capture(dir, exec);
		await write("a.txt", "mid-prompt\n");
		const newer = await capture(dir, exec);
		const entries = [
			userEntry("u1", "long prompt"),
			checkpointEntry(older, "u1", "long prompt"),
			checkpointEntry(newer, "u1", "long prompt"),
		];
		await write("a.txt", "after-prompt\n");

		const { handlers } = loadFactory(exec, entries);
		const { ctx, notices } = makeCtx(dir, entries, { select: [0] }); // "Yes, restore ..."
		await handlers.get("session_before_fork")?.(
			{ type: "session_before_fork", entryId: "u1", position: "before" },
			ctx,
		);

		expect(await read("a.txt")).toBe("before-prompt\n");
		expect(appendedSubjects(entries)).toContain("(before fork)");
		expect(notices.at(-1)?.message).toContain("restored");
	});

	it("does nothing when the user keeps the current code", async () => {
		const { dir, exec, write, read } = await makeRepo();
		await write("a.txt", "v1\n");
		const sha = await capture(dir, exec);
		const entries = [userEntry("u1", "p"), checkpointEntry(sha, "u1", "p")];
		await write("a.txt", "v2\n");

		const { handlers } = loadFactory(exec, entries);
		const { ctx } = makeCtx(dir, entries, { select: [1] }); // "No, keep current code"
		await handlers.get("session_before_fork")?.(
			{ type: "session_before_fork", entryId: "u1", position: "before" },
			ctx,
		);

		expect(await read("a.txt")).toBe("v2\n");
		expect(appendedSubjects(entries)).not.toContain("(before fork)");
	});
});

describe("turn_start capture", () => {
	it("labels the checkpoint with the user message that is persisted AFTER turn_start fires", async () => {
		// pi's agent loop emits turn_start before message_start/message_end for the
		// prompt, so the branch has no user message for this turn yet when the
		// handler runs; it appears while the capture's git calls are in flight.
		const { dir, exec } = await makeRepo();
		const entries: SessionEntry[] = [userEntry("u0", "previous prompt")];
		const { handlers } = loadFactory(exec, entries);
		const { ctx } = makeCtx(dir, entries);

		const turn = handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
		entries.push(userEntry("u1", "the prompt that started this turn"));
		await turn;
		const deadline = Date.now() + 5000;
		while (listCheckpoints(entries).length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}

		const [checkpoint] = listCheckpoints(entries);
		expect(checkpoint).toBeDefined();
		expect(checkpoint?.turnEntryId).toBe("u1");
		expect(checkpoint?.subject).toBe("the prompt that started this turn");
	});
});
