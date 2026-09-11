# Checkpoint / Rewind Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `ext/checkpoints/index.ts` a real-git test suite and fix the four defects it exposes (tracked-ignored files deleted on restore, everything staged after restore, wrong checkpoint at fork points, no safety net on the fork path).

**Architecture:** One extension file keeps all logic; it gains two exported helpers (`checkpointForTurn`, `restoreWithSafetyNet`) so both the `/rewind` handler and the `session_before_fork` handler share the destructive sequence, and so tests can drive the awaited paths without the fire-and-forget `turn_start` capture. Tests run real git in `mkdtemp` repositories through an exec shim shaped like pi's unexported `execCommand`.

**Tech Stack:** TypeScript, vitest 4 (`npm test` = `vitest run`), git CLI, `@earendil-works/pi-coding-agent` 0.84.4 types.

Spec: `docs/superpowers/specs/2026-09-11-checkpoint-rewind-hardening-design.md`.

---

## File structure

- Modify: `ext/checkpoints/index.ts` — capture (seed temp index from HEAD), restore (reset index to HEAD afterwards), new `checkpointForTurn`, new `restoreWithSafetyNet`, both handlers rewired, header text corrected.
- Create: `test/checkpoints.test.ts` — harness (exec shim, temp repo, `pi`/`ctx` stubs) + unit + integration tests.
- No other files change. `test/registration.test.ts` keeps passing as-is: the extension still registers one command (`rewind`) and three events.

Conventions to follow (read them once before starting):
- `test/sandbox-strict.test.ts` — style of a small vitest file in this repo (tabs, `describe`/`it`, no `beforeAll` unless needed).
- `scripts/probe-extensions.ts` — how `factory(pi)` is driven with a stub `ExtensionAPI`.
- Run a single file with `npx vitest run test/checkpoints.test.ts`; the whole suite with `npm test`; then `npm run typecheck` and `npm run lint` (biome).

---

### Task 1: Test harness and unit tests for the pure helpers

**Files:**
- Create: `test/checkpoints.test.ts`
- Modify: `ext/checkpoints/index.ts` (add `checkpointForTurn`)

- [ ] **Step 1: Create the test file with the harness and the unit tests**

```ts
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
			{ type: "custom", customType: "checkpoint", id: "c2", parentId: null, timestamp: "t2", data: { sha: "b".repeat(40) } } as SessionEntry,
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
```

- [ ] **Step 2: Run it to verify it fails on the missing export**

Run: `npx vitest run test/checkpoints.test.ts`
Expected: FAIL — `checkpointForTurn` is not exported (`SyntaxError: The requested module ... does not provide an export named 'checkpointForTurn'` or an "is not a function" TypeError).

- [ ] **Step 3: Add `checkpointForTurn` to `ext/checkpoints/index.ts`**

Insert directly after the `listCheckpoints` function (after its closing `}` at the current line 189):

```ts
/**
 * The checkpoint to restore when forking at the user message `turnEntryId`:
 * the OLDEST capture of that turn. A prompt runs several turns, each captured
 * with the same turnEntryId; the first capture is the tree before the prompt
 * changed anything, which is what replaying the prompt from scratch needs.
 */
export function checkpointForTurn(entries: SessionEntry[], turnEntryId: string): Checkpoint | undefined {
	if (!turnEntryId) return undefined;
	return listCheckpoints(entries)
		.reverse()
		.find((c) => c.turnEntryId === turnEntryId);
}
```

- [ ] **Step 4: Run the unit tests and verify they pass**

Run: `npx vitest run test/checkpoints.test.ts`
Expected: PASS, 3 tests (`listCheckpoints` 1, `checkpointForTurn` 2).

- [ ] **Step 5: Commit**

```bash
git add test/checkpoints.test.ts ext/checkpoints/index.ts
git commit -m "checkpoints: test harness, listCheckpoints unit test, checkpointForTurn helper"
```

---

### Task 2: Non-intrusive capture, prune, non-repo — integration tests for the current behaviour

These pass against the existing code; they lock in the header's claims before anything changes.

**Files:**
- Modify: `test/checkpoints.test.ts` (append)

- [ ] **Step 1: Append the tests**

```ts
// ── integration: exported git functions ──────────────────────────────────────

describe("captureCheckpoint", () => {
	it("returns undefined outside a git repository", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bluclawd-cp-nogit-"));
		cleanups.push(dir);
		const exec = makeExec();
		expect(await isGitRepo(dir, exec)).toBe(false);
		expect(await captureCheckpoint(dir, exec)).toBeUndefined();
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

	it("records the sha under refs/bluclawd/checkpoints/ with the commit as parent", async () => {
		const { dir, exec, git } = await makeRepo();
		const sha = await capture(dir, exec);
		expect((await git("rev-parse", `refs/bluclawd/checkpoints/${sha}`)).trim()).toBe(sha);
		expect((await git("rev-parse", `${sha}^`)).trim()).toBe((await git("rev-parse", "HEAD")).trim());
	});
});

describe("pruneCheckpointRefs", () => {
	it("deletes only the refs outside the keep set", async () => {
		const { dir, exec, git, write } = await makeRepo();
		const keep = await capture(dir, exec);
		await write("a.txt", "second\n");
		const drop = await capture(dir, exec);
		expect(keep).not.toBe(drop);

		expect(await pruneCheckpointRefs(dir, exec, new Set([keep]))).toBe(1);
		const refs = (await git("for-each-ref", "--format=%(refname)", "refs/bluclawd/checkpoints/")).trim();
		expect(refs).toBe(`refs/bluclawd/checkpoints/${keep}`);
	});
});
```

- [ ] **Step 2: Run and verify they pass**

Run: `npx vitest run test/checkpoints.test.ts`
Expected: PASS, 7 tests. If the "parent" assertion fails with `sha^` unknown, the repo has no commit — check `makeRepo` ran its commit step.

- [ ] **Step 3: Commit**

```bash
git add test/checkpoints.test.ts
git commit -m "checkpoints: lock in non-intrusive capture and prune behaviour with real git"
```

---

### Task 3: Defect 1 — tracked-but-ignored files survive a restore

**Files:**
- Modify: `test/checkpoints.test.ts` (append)
- Modify: `ext/checkpoints/index.ts` (`captureCheckpoint`, lines ~250–305)

- [ ] **Step 1: Write the failing test**

```ts
describe("restoreCheckpoint — tracked files that match .gitignore", () => {
	it("captures their modifications and keeps them on restore", async () => {
		const { dir, exec, git, write, read } = await makeRepo();
		await write("cfg.txt", "committed\n");
		await write(".gitignore", "cfg.txt\n");
		await git("add", "-A");
		await git("commit", "-q", "-m", "track cfg then ignore it");
		await write("cfg.txt", "checkpointed\n");

		const sha = await capture(dir, exec);
		expect((await git("ls-tree", "--name-only", sha)).split("\n")).toContain("cfg.txt");

		await write("cfg.txt", "later\n");
		expect(await restoreCheckpoint(dir, exec, sha)).toBe(true);
		expect(await read("cfg.txt")).toBe("checkpointed\n");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/checkpoints.test.ts -t "gitignore"`
Expected: FAIL at the `ls-tree` assertion — `cfg.txt` is not in the checkpoint tree (and if you skip that line, `read("cfg.txt")` throws ENOENT: the restore deleted it).

- [ ] **Step 3: Seed the temporary index from HEAD before staging**

In `captureCheckpoint`, replace the body of the `try` block up to and including the `commit` call's `parentArgs` with this (the `commit`/`updateRef` steps below it stay unchanged):

```ts
	const tmpIndex = join(tmpdir(), `bluclawd-checkpoint-${randomUUID()}.index`);
	try {
		// Seed the temp index with HEAD's entries first, so `add -A` sees tracked
		// files even when they match .gitignore (the committed-then-ignored
		// pattern). An empty index would drop them from the tree and a later
		// restore would delete them. Skipped on an unborn HEAD: nothing to seed.
		const head = await headSha(cwd, exec);
		if (head) {
			const seed = await exec("env", [`GIT_INDEX_FILE=${tmpIndex}`, "git", "read-tree", head], {
				cwd,
				timeout: GIT_TIMEOUT_MS,
			}).catch(() => undefined);
			if (!seed || seed.code !== 0) return undefined;
		}

		const add = await exec("env", [`GIT_INDEX_FILE=${tmpIndex}`, "git", "add", "-A"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		if (!add || add.code !== 0) return undefined;

		const writeTree = await exec("env", [`GIT_INDEX_FILE=${tmpIndex}`, "git", "write-tree"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		const tree = writeTree?.stdout.trim();
		if (!writeTree || writeTree.code !== 0 || !tree) return undefined;

		const parentArgs = head ? ["-p", head] : [];
```

Delete the old `headRef` block (`const headRef = await exec("git", ["rev-parse", "HEAD"] ...` and its `parentArgs` line) — `head` replaces it.

Add this helper above `captureCheckpoint` (after `isGitRepo`):

```ts
/** Current HEAD commit sha, or undefined on an unborn HEAD (fresh `git init`). */
async function headSha(cwd: string, exec: ExtensionAPI["exec"]): Promise<string | undefined> {
	const result = await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	const sha = result?.stdout.trim();
	return result?.code === 0 && sha ? sha : undefined;
}
```

- [ ] **Step 4: Run the file and verify everything passes**

Run: `npx vitest run test/checkpoints.test.ts`
Expected: PASS, 8 tests — including the Task 2 non-intrusiveness test (the seeding step must not touch the real index either).

- [ ] **Step 5: Commit**

```bash
git add test/checkpoints.test.ts ext/checkpoints/index.ts
git commit -m "checkpoints: seed the temp index from HEAD so tracked-but-ignored files survive a rewind"
```

---

### Task 4: Defect 2 — restore leaves the tree looking like ordinary uncommitted work

**Files:**
- Modify: `test/checkpoints.test.ts` (append)
- Modify: `ext/checkpoints/index.ts` (`restoreCheckpoint`, lines ~313–319)

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/checkpoints.test.ts -t "index state"`
Expected: FAIL — status is `["A  new.txt", "M  a.txt", "?? later.txt"]` (staged), and the unborn case shows `["A  a.txt"]`.

- [ ] **Step 3: Reset the index to HEAD after the tree restore**

Replace `restoreCheckpoint` with:

```ts
/**
 * Restore the working tree to a previously captured checkpoint. This is the
 * one deliberately destructive operation in this file — only call it from an
 * explicit, user-confirmed action. `read-tree --reset -u` rewrites the index
 * and working tree together; the index is then reset to HEAD so the result
 * reads as ordinary uncommitted work (modified files unstaged, new files
 * untracked) instead of a fully staged tree. Returns false (never throws) if
 * the sha can't be restored (e.g. not a git repo, unknown sha).
 */
export async function restoreCheckpoint(cwd: string, exec: ExtensionAPI["exec"], sha: string): Promise<boolean> {
	const result = await exec("git", ["read-tree", "--reset", "-u", sha], {
		cwd,
		timeout: RESTORE_TIMEOUT_MS,
	}).catch(() => undefined);
	if (result?.code !== 0) return false;

	const head = await headSha(cwd, exec);
	const unstage = await exec("git", head ? ["reset", "-q"] : ["read-tree", "--empty"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return unstage?.code === 0;
}
```

- [ ] **Step 4: Run the file and verify everything passes**

Run: `npx vitest run test/checkpoints.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add test/checkpoints.test.ts ext/checkpoints/index.ts
git commit -m "checkpoints: reset the index to HEAD after a restore so nothing appears staged"
```

---

### Task 5: Shared `restoreWithSafetyNet` — `/rewind` handler tests (files-only, fail-closed)

**Files:**
- Modify: `test/checkpoints.test.ts` (append)
- Modify: `ext/checkpoints/index.ts` (new export; `/rewind` handler lines ~518–581)

- [ ] **Step 1: Write the handler tests**

```ts
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
```

- [ ] **Step 2: Run to verify the current handler already satisfies them (baseline)**

Run: `npx vitest run test/checkpoints.test.ts -t "/rewind"`
Expected: PASS, 2 tests — this proves the refactor in Step 3 is behaviour-preserving. If either fails here, stop and read the assertion: the harness, not the extension, is wrong.

- [ ] **Step 3: Extract `restoreWithSafetyNet` and call it from `/rewind`**

Add this exported function directly above `/** Module-scoped overlap guard ... */` (the `let isCapturing = false;` line):

```ts
/**
 * The whole destructive sequence, shared by `/rewind` and the fork-point
 * offer: safety-net capture → fail-closed confirmation if that capture failed
 * → restore → report. Returns true only when the tree was restored. The
 * caller has already asked the user whether to overwrite their changes.
 */
export async function restoreWithSafetyNet(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targetSha: string,
	safetySubject: string,
): Promise<boolean> {
	// Deliberately bypasses the isCapturing guard (see file header) — this is a
	// foreground, user-awaited, one-off action.
	const safetySha = await captureCheckpoint(ctx.cwd, pi.exec);
	if (safetySha) {
		pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, {
			sha: safetySha,
			turnEntryId: ctx.sessionManager.getLeafEntry()?.id ?? "",
			subject: safetySubject,
		});
	} else {
		// Fail-closed. Restoring now would overwrite the user's current
		// uncommitted work with NO way to recover it — exactly the data loss the
		// safety net exists to prevent. Do NOT restore unless the user opts in.
		const proceed = await ctx.ui.confirm(
			"Safety checkpoint failed",
			"Could not snapshot your current changes before rewinding. If you restore now, your current uncommitted changes will be UNRECOVERABLE. Restore anyway, without a safety checkpoint?",
		);
		if (!proceed) {
			ctx.ui.notify("Rewind aborted: safety checkpoint failed, current changes left untouched.", "error");
			return false;
		}
	}

	const restored = await restoreCheckpoint(ctx.cwd, pi.exec, targetSha);
	if (restored) {
		ctx.ui.notify("Working tree restored to checkpoint.", "info");
		return true;
	}
	// read-tree can be interrupted mid-write (e.g. SIGTERM on RESTORE_TIMEOUT_MS),
	// potentially leaving a partially-applied tree. Point the user at the
	// safety-net sha (when one was taken) so they can get back to where they were.
	const recovery = safetySha
		? ` Your pre-rewind state is checkpointed at ${safetySha.slice(0, 7)} — run /rewind to return to it.`
		: "";
	ctx.ui.notify(`Failed to restore checkpoint; the working tree may be in a partially-applied state.${recovery}`, "error");
	return false;
}
```

Then in the `/rewind` handler, replace everything from the comment `// Safety net: checkpoint the current (about-to-be-overwritten) state first` down to the end of the handler body (the closing of the `else` that notifies "Failed to restore checkpoint") with:

```ts
			const restored = await restoreWithSafetyNet(pi, ctx, target.sha, "(before rewind)");
			// Move the conversation LAST: it swaps what the session is pointing at, so
			// anything after it would run against state that is being replaced — the
			// same ordering FleetView's switchSession hand-off exists for.
			if (restored && scopeChoice.talk) await ctx.navigateTree(target.turnEntryId);
```

- [ ] **Step 4: Run the file and verify everything still passes**

Run: `npx vitest run test/checkpoints.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add test/checkpoints.test.ts ext/checkpoints/index.ts
git commit -m "checkpoints: extract restoreWithSafetyNet from /rewind, cover files-only and fail-closed paths"
```

---

### Task 6: Defects 3 and 4 — fork-point offer restores the oldest checkpoint, with a safety net

**Files:**
- Modify: `test/checkpoints.test.ts` (append)
- Modify: `ext/checkpoints/index.ts` (`session_before_fork` handler, lines ~434–452)

- [ ] **Step 1: Write the failing test**

```ts
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
		await handlers.get("session_before_fork")?.({ type: "session_before_fork", entryId: "u1", position: "before" }, ctx);

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
		await handlers.get("session_before_fork")?.({ type: "session_before_fork", entryId: "u1", position: "before" }, ctx);

		expect(await read("a.txt")).toBe("v2\n");
		expect(appendedSubjects(entries)).not.toContain("(before fork)");
	});
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npx vitest run test/checkpoints.test.ts -t "session_before_fork"`
Expected: first test FAILS — `a.txt` is `mid-prompt` (newest checkpoint chosen) and no `(before fork)` entry exists. Second test passes.

- [ ] **Step 3: Rewire the fork handler**

Replace the whole `pi.on("session_before_fork", ...)` block with:

```ts
	// Offer to put the code back where it was when the forked-at prompt began.
	// Always asks first, never auto-restores; shares /rewind's safety net.
	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const match = checkpointForTurn(ctx.sessionManager.getBranch(), event.entryId);
		if (!match) return;

		const choice = await ctx.ui.select(`Restore code to the checkpoint at this fork point? (${match.subject})`, [
			"Yes, restore code to that checkpoint (your current uncommitted changes are checkpointed first)",
			"No, keep current code",
		]);
		if (!choice?.startsWith("Yes")) return;
		await restoreWithSafetyNet(pi, ctx, match.sha, "(before fork)");
	});
```

- [ ] **Step 4: Run the file and verify everything passes**

Run: `npx vitest run test/checkpoints.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add test/checkpoints.test.ts ext/checkpoints/index.ts
git commit -m "checkpoints: fork-point offer restores the turn's first checkpoint and takes a safety net"
```

---

### Task 7: Correct the file header

**Files:**
- Modify: `ext/checkpoints/index.ts` header comment (lines 1–108) and the follow-up note (lines 136–150)

- [ ] **Step 1: Apply these text edits to the header**

1. In the capture step list, replace step 1:

   Old:
   ```
    *   1. `env GIT_INDEX_FILE=<tmp> git add -A`   — stage the ENTIRE working tree
    *      (tracked + untracked, respecting .gitignore, matching `git stash`'s
    *      scope) into the fresh temp index. The real index is never opened.
   ```
   New:
   ```
    *   1. `env GIT_INDEX_FILE=<tmp> git read-tree HEAD` (skipped on an unborn
    *      HEAD) then `env GIT_INDEX_FILE=<tmp> git add -A` — seed the temp index
    *      with HEAD's entries, then stage the ENTIRE working tree on top:
    *      tracked files (modified, deleted, or matching .gitignore — the
    *      committed-then-ignored `.env` pattern) plus untracked files, the same
    *      scope as `git stash -u`. Without the seed, tracked-but-ignored files
    *      are missing from the tree and a restore DELETES them. The real index
    *      is never opened.
   ```

2. Replace the sentence `See \`test/core-ext-checkpoints.test.ts\` for the byte-identical before/after proof.` with `See \`test/checkpoints.test.ts\` for the byte-identical before/after proof.`

3. Replace the two "documented, not fixed" paragraphs (from `Files present in the checkpoint tree that were previously untracked` through `it would erase files the USER dropped in too) — documented, not fixed.`) with:

   ```
    * After the tree restore, the index is reset to HEAD (`git reset -q`, or
    * `read-tree --empty` on an unborn HEAD) so the result reads as ordinary
    * uncommitted work: modified files unstaged, new files untracked. A checkpoint
    * is a flattened tree — it does not record what was staged — so anything the
    * user had staged is unstaged after a restore, the same loss as `git stash
    * pop` without `--index`. Checkpoints captured before the HEAD-seeding change
    * above still lack tracked-but-ignored files; restoring one of those still
    * removes such files, and that cannot be repaired retroactively.
    *
    * `read-tree --reset -u` only touches paths that differ between the target
    * tree and the current index, so a file created AFTER the checkpoint
    * (agent-written, never git-added) is in neither and SURVIVES a restore.
    * Removing such strays would need an explicit untracked-diff + delete pass
    * with its own safety questions (it would erase files the USER dropped in
    * too) — documented, not fixed.
   ```

4. In the "Restore (destructive, fail-closed)" section, replace `only ever runs from an explicit, confirmed \`/rewind\` (or a fork-point restore the user opted into).` with `only ever runs through \`restoreWithSafetyNet\`, from an explicit, confirmed \`/rewind\` or a fork-point restore the user opted into — both take the safety net below.`

5. Add, after the "Restore" section's last paragraph and before `── Persistence & pruning`:

   ```
    * The fork-point offer (`session_before_fork`) restores the OLDEST checkpoint
    * of the forked-at turn (`checkpointForTurn`): a prompt runs several turns and
    * each is captured, and replaying the prompt needs the tree from before its
    * first turn. Its safety-net entry lands on the OUTGOING session's branch, so
    * the forked session's first automatic prune drops that ref; the commit
    * object stays restorable by sha until `git gc` (default two weeks). Known
    * limitation, shared with every concurrent-session case (see pruning below).
    *
   ```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean. If biome complains about line width in the header, wrap at the same column as neighbouring lines.

- [ ] **Step 3: Commit**

```bash
git add ext/checkpoints/index.ts
git commit -m "checkpoints: header matches the seeded capture, index reset, and fork-point behaviour"
```

---

### Task 8: Full verification and live check

**Files:** none new.

- [ ] **Step 1: Full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green; `test/registration.test.ts` still reports `checkpoints: commands ["rewind"], events 3`.

- [ ] **Step 2: Live verify in tmux (working-tree recipe, real HOME)**

In a scratch git repo with a tracked-then-ignored file and some ` M` / `??` entries:

```bash
mkdir -p "$CLAUDE_JOB_DIR/tmp/live" && cd "$CLAUDE_JOB_DIR/tmp/live" && git init -q
printf 'secret=1\n' > .env && printf 'x\n' > a.txt && git add -A && git commit -qm init
printf '.env\n' > .gitignore && git add .gitignore && git commit -qm ignore
printf 'secret=2\n' > .env && printf 'y\n' >> a.txt && printf 'n\n' > new.txt
git status --short   # expect " M .env" (tracked files show even when ignored), " M a.txt", "?? new.txt"
```

Start bluclawd from the repo checkout with every extension file loaded from the working tree (`pi -ne -e <each ext/*/index.ts>`, the recipe in memory `bluclawd-standalone-package`), send a trivial prompt so a checkpoint is captured, edit `a.txt` again, then run `/rewind` → pick the checkpoint → "Files only" → confirm. Afterwards, in the shell:

```bash
git status --short; cat .env
```
Expected: same shape as before (` M`, `??`, not `M ` / `A `), and `.env` still present with `secret=2`.

- [ ] **Step 3: Record the observed output in the plan and mark the tasks done**

Paste the two `git status --short` outputs and the `cat .env` line under this step, then commit the plan with the boxes ticked:

```bash
git add docs/superpowers/plans/2026-09-11-checkpoint-rewind-hardening.md
git commit -m "docs: checkpoint hardening plan verified live"
```
