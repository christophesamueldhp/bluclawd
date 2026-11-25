import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { focusedComponent, isPromptEditor } from "../_shared/focus.ts";
import { holdTui } from "../_shared/hold-tui.ts";
import { readSettings } from "../_shared/startup-settings.ts";
import { timed } from "../_shared/timing.ts";

const CHECKPOINT_CUSTOM_TYPE = "checkpoint";
const CHECKPOINT_REF_PREFIX = "refs/bluclawd/checkpoints/";
const GIT_TIMEOUT_MS = 5000;
const RESTORE_TIMEOUT_MS = 30000;
const SUBJECT_MAX_CHARS = 100;
const MAX_CHECKPOINT_REFS = 50;

interface CheckpointData {
	sha: string;
	turnEntryId: string;
	subject: string;
}

export interface Checkpoint extends CheckpointData {
	entryId: string;
	timestamp: string;
}

export function checkpointsNewestFirst(entries: SessionEntry[]): Checkpoint[] {
	const checkpoints: Checkpoint[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CHECKPOINT_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<CheckpointData> | undefined;
		if (!data?.sha) continue;
		checkpoints.push({
			entryId: entry.id,
			sha: data.sha,
			turnEntryId: data.turnEntryId ?? "",
			subject: data.subject ?? "(no subject)",
			timestamp: entry.timestamp,
		});
	}
	return checkpoints.reverse();
}

export function oldestCheckpointForTurn(entries: SessionEntry[], turnEntryId: string): Checkpoint | undefined {
	if (!turnEntryId) return undefined;
	return checkpointsNewestFirst(entries)
		.reverse()
		.find((c) => c.turnEntryId === turnEntryId);
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block): block is { type: string; text: string } => (block as { type?: string })?.type === "text")
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

function truncateSubject(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (!singleLine) return "(empty message)";
	if (singleLine.length <= SUBJECT_MAX_CHARS) return singleLine;
	return `${singleLine.slice(0, SUBJECT_MAX_CHARS - 1)}…`;
}

type UserEntry = SessionMessageEntry & { message: Extract<SessionMessageEntry["message"], { role: "user" }> };

function userEntries(branch: SessionEntry[]): UserEntry[] {
	return branch.filter((e): e is UserEntry => e.type === "message" && e.message.role === "user");
}

function userSubject(entry: UserEntry): string {
	return truncateSubject(extractUserText(entry.message.content));
}

/**
 * The entry `message` was persisted as, else the latest user message on the branch,
 * for labeling. pi appends the same object it emits.
 */
function findTurnContext(
	branch: SessionEntry[],
	message: unknown,
): {
	turnEntryId: string;
	subject: string;
} {
	const users = userEntries(branch);
	const entry = users.find((e) => e.message === message) ?? users.at(-1);
	if (entry) return { turnEntryId: entry.id, subject: userSubject(entry) };
	const leaf = branch[branch.length - 1];
	return { turnEntryId: leaf?.id ?? "", subject: "(session start)" };
}

const FOREIGN_CHECKPOINT_TTL_DAYS = 30;

function refNameForSha(sessionId: string, sha: string): string {
	return `${CHECKPOINT_REF_PREFIX}${sessionId}/${sha}`;
}

export async function isGitRepo(cwd: string, exec: ExtensionAPI["exec"]): Promise<boolean> {
	const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 && result.stdout.trim() === "true";
}

async function headSha(cwd: string, exec: ExtensionAPI["exec"]): Promise<string | undefined> {
	const result = await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	const sha = result?.stdout.trim();
	return result?.code === 0 && sha ? sha : undefined;
}

export async function captureCheckpoint(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sessionId: string,
): Promise<string | undefined> {
	if (!(await isGitRepo(cwd, exec))) return undefined;

	const tmpIndex = join(tmpdir(), `bluclawd-checkpoint-${randomUUID()}.index`);
	const gitInIndex = (args: string[]) =>
		exec("env", [`GIT_INDEX_FILE=${tmpIndex}`, "git", ...args], { cwd, timeout: GIT_TIMEOUT_MS }).catch(
			() => undefined,
		);
	try {
		const head = await headSha(cwd, exec);
		const index = await exec("git", ["rev-parse", "--git-path", "index"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		if (index?.code !== 0 || !index.stdout.trim()) return undefined;
		try {
			await copyFile(resolve(cwd, index.stdout.trim()), tmpIndex);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
			if (head) {
				const seed = await gitInIndex(["read-tree", head]);
				if (seed?.code !== 0) return undefined;
			}
		}

		// Index optimization flags must not hide working-tree changes from the snapshot.
		const flags = await gitInIndex(["ls-files", "-v", "-z", "--", ":/"]);
		if (flags?.code !== 0) return undefined;
		const flagged = flags.stdout
			.split("\0")
			.filter((entry) => /^[a-zS] /.test(entry))
			.map((entry) => entry.slice(2));
		for (let i = 0; i < flagged.length; i += 100) {
			for (const flag of ["--no-assume-unchanged", "--no-skip-worktree"]) {
				const cleared = await gitInIndex(["update-index", flag, "--", ...flagged.slice(i, i + 100)]);
				if (cleared?.code !== 0) return undefined;
			}
		}

		const add = await gitInIndex(["add", "-A"]);
		if (!add || add.code !== 0) return undefined;

		const writeTree = await gitInIndex(["write-tree"]);
		const tree = writeTree?.stdout.trim();
		if (!writeTree || writeTree.code !== 0 || !tree) return undefined;

		const parentArgs = head ? ["-p", head] : [];

		const commit = await exec(
			"env",
			[
				"GIT_AUTHOR_NAME=bluclawd-checkpoint",
				"GIT_AUTHOR_EMAIL=checkpoint@bluclawd.local",
				"GIT_COMMITTER_NAME=bluclawd-checkpoint",
				"GIT_COMMITTER_EMAIL=checkpoint@bluclawd.local",
				"git",
				"commit-tree",
				tree,
				...parentArgs,
				"-m",
				"bluclawd checkpoint",
			],
			{ cwd, timeout: GIT_TIMEOUT_MS },
		).catch(() => undefined);
		const sha = commit?.stdout.trim();
		if (!commit || commit.code !== 0 || !sha) return undefined;

		const updateRef = await exec("git", ["update-ref", refNameForSha(sessionId, sha), sha], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		if (!updateRef || updateRef.code !== 0) return undefined;

		return sha;
	} catch {
		return undefined;
	} finally {
		await rm(tmpIndex, { force: true }).catch(() => {});
	}
}

function topPathspec(path: string, magic = ""): string {
	return `:(top,literal${magic})${path}`;
}

async function addedFiles(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sha: string,
	currentSha: string,
): Promise<string[] | undefined> {
	const result = await exec("git", ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", sha, currentSha], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 ? result.stdout.split("\0").filter(Boolean) : undefined;
}

async function userAddedFiles(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sha: string,
	currentSha: string,
	agentCreated: ReadonlySet<string>,
): Promise<string[]> {
	return ((await addedFiles(cwd, exec, sha, currentSha)) ?? []).filter((path) => !agentCreated.has(path));
}

export async function restoreCheckpoint(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sha: string,
	currentSha?: string,
	agentCreated: ReadonlySet<string> = new Set(),
): Promise<boolean> {
	const added = currentSha ? await addedFiles(cwd, exec, sha, currentSha) : [];
	if (!added) return false;

	const result = await exec("git", ["read-tree", "--reset", "-u", sha], {
		cwd,
		timeout: RESTORE_TIMEOUT_MS,
	}).catch(() => undefined);
	if (result?.code !== 0) return false;

	const remove = added.filter((path) => agentCreated.has(path)).map((path) => topPathspec(path));
	if (remove.length > 0) {
		const clean = await exec("git", ["clean", "-f", "-q", "--", ...remove], {
			cwd,
			timeout: RESTORE_TIMEOUT_MS,
		}).catch(() => undefined);
		if (clean?.code !== 0) return false;
	}
	// These are the user's. read-tree removed the tracked ones, so write them all back.
	const keep = added.filter((path) => !agentCreated.has(path)).map((path) => topPathspec(path));
	if (currentSha && keep.length > 0) {
		const checkout = await exec("git", ["checkout", currentSha, "--", ...keep], {
			cwd,
			timeout: RESTORE_TIMEOUT_MS,
		}).catch(() => undefined);
		if (checkout?.code !== 0) return false;
	}

	const head = await headSha(cwd, exec);
	const unstage = await exec("git", head ? ["reset", "-q"] : ["read-tree", "--empty"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return unstage?.code === 0;
}

export async function pruneCheckpointRefs(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sessionId: string,
	keepShas: ReadonlySet<string>,
): Promise<number> {
	const list = await exec(
		"git",
		["for-each-ref", "--format=%(refname) %(committerdate:unix)", CHECKPOINT_REF_PREFIX],
		{
			cwd,
			timeout: GIT_TIMEOUT_MS,
		},
	).catch(() => undefined);
	if (!list || list.code !== 0) return 0;

	const cutoff = Math.floor(Date.now() / 1000) - FOREIGN_CHECKPOINT_TTL_DAYS * 86400;
	let removed = 0;
	for (const line of list.stdout.split("\n")) {
		const [ref, dateText] = line.trim().split(" ");
		if (!ref) continue;
		const rest = ref.slice(CHECKPOINT_REF_PREFIX.length);
		const slash = rest.indexOf("/");
		const owner = slash === -1 ? sessionId : rest.slice(0, slash);
		const sha = slash === -1 ? rest : rest.slice(slash + 1);
		const date = Number.parseInt(dateText ?? "", 10);
		const hasDate = !Number.isNaN(date);
		const stale = owner === sessionId ? !keepShas.has(sha) : hasDate && date < cutoff;
		if (!stale) continue;
		const del = await exec("git", ["update-ref", "-d", ref], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		if (del?.code === 0) removed++;
	}
	return removed;
}

async function pruneOldCheckpointRefs(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sessionId: string,
	branch: SessionEntry[],
): Promise<void> {
	const shas = checkpointsNewestFirst(branch).map((c) => c.sha);
	await pruneCheckpointRefs(cwd, exec, sessionId, new Set(shas.slice(0, MAX_CHECKPOINT_REFS)));
}

const PREVIEW_MAX_LINES = 20;

function excludeArgs(paths: string[]): string[] {
	return paths.length > 0 ? ["--", ...paths.map((path) => topPathspec(path, ",exclude"))] : [];
}

async function diffStat(
	cwd: string,
	exec: ExtensionAPI["exec"],
	fromSha: string,
	toSha: string,
	exclude: string[] = [],
): Promise<string | undefined> {
	const result = await exec("git", ["diff", "--stat", "--stat-width=80", fromSha, toSha, ...excludeArgs(exclude)], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 ? result.stdout : undefined;
}

function clipLines(text: string, max: number): string {
	const lines = text.trimEnd().split("\n");
	if (lines.length <= max) return lines.join("\n");
	return `${lines.slice(0, max).join("\n")}\n… and ${lines.length - max} more`;
}

interface DiffStats {
	files: string[];
	insertions: number;
	deletions: number;
}

async function diffNumstat(
	cwd: string,
	exec: ExtensionAPI["exec"],
	fromSha: string,
	toSha?: string,
	exclude: string[] = [],
): Promise<DiffStats | undefined> {
	const args = ["diff", "--numstat", "--no-renames", fromSha, ...(toSha ? [toSha] : []), ...excludeArgs(exclude)];
	const result = await exec("git", args, {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	if (result?.code !== 0) return undefined;
	const stats: DiffStats = { files: [], insertions: 0, deletions: 0 };
	for (const line of result.stdout.split("\n")) {
		const [added, removed, file] = line.split("\t");
		if (!file) continue;
		stats.files.push(file);
		// Binary files show "-" for both counts.
		stats.insertions += Number.parseInt(added ?? "", 10) || 0;
		stats.deletions += Number.parseInt(removed ?? "", 10) || 0;
	}
	return stats;
}

function rowNote(stats: DiffStats | undefined): string {
	if (!stats) return "⚠ No code restore";
	const counts = `+${stats.insertions} -${stats.deletions}`;
	if (stats.files.length === 0) return "No code changes";
	if (stats.files.length === 1) return `${basename(stats.files[0] ?? "")} ${counts}`;
	return `${stats.files.length} files changed ${counts}`;
}

function restoreEffect(stats: DiffStats): string {
	const [first = "", second = ""] = stats.files.map((file) => basename(file));
	if (!first) return "The code has not changed (nothing will be restored).";
	const files =
		stats.files.length === 1
			? first
			: stats.files.length === 2
				? `${first} and ${second}`
				: `${first} and ${stats.files.length - 1} other files`;
	return `The code will be restored +${stats.insertions} -${stats.deletions} in ${files}.`;
}

function uniqueLabels(labels: string[]): string[] {
	const seen = new Map<string, number>();
	return labels.map((label) => {
		const n = (seen.get(label) ?? 0) + 1;
		seen.set(label, n);
		return n === 1 ? label : `${label} (${n})`;
	});
}

async function restoreWithSafetyNet(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targetSha: string,
	safetySubject: string,
	intro: string,
): Promise<{ restored: boolean; safety?: CheckpointData }> {
	// The captured tree is also the preview base, since `git diff <sha>`
	// against the working tree would skip untracked files.
	const safetySha = await captureCheckpoint(ctx.cwd, pi.exec, ctx.sessionManager.getSessionId());
	if (safetySha) {
		const kept = await userAddedFiles(
			ctx.cwd,
			pi.exec,
			targetSha,
			safetySha,
			agentCreatedFiles(ctx.sessionManager.getEntries()),
		);
		const stat = await diffStat(ctx.cwd, pi.exec, safetySha, targetSha, kept);
		if (stat !== undefined && stat.trim() === "") {
			ctx.ui.notify("Working tree already matches this checkpoint.", "info");
			return { restored: false };
		}
		const preview = stat === undefined ? "(preview unavailable)" : clipLines(stat, PREVIEW_MAX_LINES);
		const proceed = await ctx.ui.confirm(
			"Rewind",
			`${intro}\n\n${preview}\n\nYour current changes are checkpointed first, so this can be undone with /rewind. Continue?`,
		);
		if (!proceed) return { restored: false };
	}
	return restoreOverSafetyNet(pi, ctx, targetSha, safetySha, safetySubject, intro);
}

async function restoreOverSafetyNet(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targetSha: string,
	safetySha: string | undefined,
	safetySubject: string,
	intro: string,
): Promise<{ restored: boolean; safety?: CheckpointData }> {
	let safety: CheckpointData | undefined;
	if (safetySha) {
		safety = { sha: safetySha, turnEntryId: ctx.sessionManager.getLeafEntry()?.id ?? "", subject: safetySubject };
		pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, safety);
	} else {
		const proceed = await ctx.ui.confirm(
			"Safety checkpoint failed",
			`${intro}\n\nCould not snapshot your current changes before rewinding (no preview either). If you restore now, your current uncommitted changes will be UNRECOVERABLE. Restore anyway, without a safety checkpoint?`,
		);
		if (!proceed) {
			ctx.ui.notify("Rewind aborted: safety checkpoint failed, current changes left untouched.", "error");
			return { restored: false };
		}
	}

	const agentCreated = agentCreatedFiles(ctx.sessionManager.getEntries());
	const restored = await restoreCheckpoint(ctx.cwd, pi.exec, targetSha, safetySha, agentCreated);
	if (restored) {
		ctx.ui.notify("Working tree restored to checkpoint.", "info");
		return { restored: true, safety };
	}
	const recovery = safetySha
		? ` Your pre-rewind state is checkpointed at ${safetySha.slice(0, 7)} — run /rewind to return to it.`
		: "";
	ctx.ui.notify(
		`Failed to restore checkpoint; the working tree may be in a partially-applied state.${recovery}`,
		"error",
	);
	return { restored: false };
}

const CREATED_CUSTOM_TYPE = "checkpoint-created";
const CREATING_TOOLS = new Set(["write", "bash", "powershell"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

async function untrackedFiles(cwd: string, exec: ExtensionAPI["exec"]): Promise<Set<string> | undefined> {
	const result = await exec("git", ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 ? new Set(result.stdout.split("\0").filter(Boolean)) : undefined;
}

export function agentCreatedFiles(allSessionEntries: SessionEntry[]): Set<string> {
	const paths = new Set<string>();
	for (const entry of allSessionEntries) {
		if (entry.type !== "custom" || entry.customType !== CREATED_CUSTOM_TYPE) continue;
		for (const path of (entry.data as { paths?: string[] } | undefined)?.paths ?? []) paths.add(path);
	}
	return paths;
}

function piOwnsDoubleEscape(ctx: ExtensionContext): boolean {
	return readSettings(ctx).settings.getDoubleEscapeAction() !== "none";
}

function reappendSafetyNetOnNewBranch(pi: ExtensionAPI, safety: CheckpointData): void {
	pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, safety);
}

let failedCaptureCount = 0;

export function factory(pi: ExtensionAPI): void {
	let captureInFlight: Promise<void> | undefined;
	function checkpointUserMessage(ctx: ExtensionContext, message: unknown): void {
		if (captureInFlight) return;
		const sessionId = ctx.sessionManager.getSessionId();
		captureInFlight = captureCheckpoint(ctx.cwd, pi.exec, sessionId)
			.then(async (sha) => {
				// Read AFTER the capture, because pi persists the message after its message_end handlers.
				const { turnEntryId, subject } = findTurnContext(ctx.sessionManager.getBranch(), message);
				if (sha) {
					pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, { sha, turnEntryId, subject });
					void pruneOldCheckpointRefs(ctx.cwd, pi.exec, sessionId, ctx.sessionManager.getBranch());
					return;
				}
				if (!(await isGitRepo(ctx.cwd, pi.exec))) return;
				failedCaptureCount++;
				if (failedCaptureCount === 1 && ctx.hasUI) {
					ctx.ui.notify(
						`Checkpoint capture failed for "${subject}" — this prompt has no code restore in /rewind. ` +
							"Run /rewind to see which prompts are covered.",
						"warning",
					);
				}
			})
			.catch(() => {})
			.finally(() => {
				captureInFlight = undefined;
			});
	}

	pi.on("session_start", async (_event, ctx) => {
		failedCaptureCount = 0;
		if (ctx.mode === "tui") listenForDoubleEscape(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!offDoubleEscape) return;
		offDoubleEscape();
		offDoubleEscape = undefined;
		ctx.ui.setWidget("checkpoints:tui", undefined);
	});

	let offDoubleEscape: (() => void) | undefined;
	const listenForDoubleEscape = (ctx: ExtensionContext): void => {
		offDoubleEscape?.();
		const tui = holdTui(ctx, "checkpoints:tui");
		const elsewhere = () => {
			const focused = focusedComponent(tui());
			return focused !== undefined && !isPromptEditor(focused);
		};
		let escapeAt = 0;
		offDoubleEscape = ctx.ui.onTerminalInput((data) => {
			if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
			if (!matchesKey(data, "escape")) {
				escapeAt = 0;
				return undefined;
			}
			if (!ctx.isIdle() || ctx.ui.getEditorText() !== "" || tui()?.hasOverlay() || elsewhere()) {
				escapeAt = 0;
				return undefined;
			}
			const now = Date.now();
			if (now - escapeAt < DOUBLE_ESCAPE_MS) {
				escapeAt = 0;
				if (piOwnsDoubleEscape(ctx)) return undefined;
				pi.sendUserMessage("/rewind", { expandPromptTemplates: true });
				return { consume: true };
			}
			escapeAt = now;
			return undefined;
		});
	};

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "user") checkpointUserMessage(ctx, event.message);
	});

	// Looked up per call, because tools register after this factory runs.
	const isReadOnly = (toolName: string): boolean =>
		READ_ONLY_TOOLS.has(toolName) ||
		pi.getAllTools().some((tool) => tool.name === toolName && tool.annotations?.readOnlyHint === true);

	const untrackedBefore = new Map<string, Set<string>>();
	pi.on("tool_call", async (event, ctx) => {
		if (isReadOnly(event.toolName)) return;
		const scan = CREATING_TOOLS.has(event.toolName) ? untrackedFiles(ctx.cwd, pi.exec) : undefined;
		await captureInFlight;
		const before = await scan;
		if (before) untrackedBefore.set(event.toolCallId, before);
	});
	pi.on("tool_result", async (event, ctx) => {
		const before = untrackedBefore.get(event.toolCallId);
		if (!before) return;
		untrackedBefore.delete(event.toolCallId);
		const after = await untrackedFiles(ctx.cwd, pi.exec);
		const created = [...(after ?? [])].filter((path) => !before.has(path));
		if (created.length > 0) pi.appendEntry(CREATED_CUSTOM_TYPE, { paths: created });
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const match = oldestCheckpointForTurn(ctx.sessionManager.getBranch(), event.entryId);
		if (!match) return;
		await restoreWithSafetyNet(
			pi,
			ctx,
			match.sha,
			"(before fork)",
			`Restore code to the checkpoint at this fork point? (${match.subject})`,
		);
	});

	pi.registerCommand("rewind", {
		description: "Restore the working tree to a previous checkpoint (`--prune` to clean up old checkpoint refs)",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "--prune" || trimmed === "prune") {
				const keepShas = new Set(checkpointsNewestFirst(ctx.sessionManager.getBranch()).map((c) => c.sha));
				const removed = await pruneCheckpointRefs(ctx.cwd, pi.exec, ctx.sessionManager.getSessionId(), keepShas);
				ctx.ui.notify(`Pruned ${removed} old checkpoint ref${removed === 1 ? "" : "s"}.`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/rewind requires interactive mode", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const promptIds = new Set(userEntries(branch).map((e) => e.id));
			const checkpointsById = new Map(checkpointsNewestFirst(branch).map((c) => [c.entryId, c]));
			const points: Array<{ prompt?: UserEntry; checkpoint?: Checkpoint; subject: string }> = [];
			for (const entry of branch) {
				if (entry.type === "message" && promptIds.has(entry.id)) {
					const prompt = entry as UserEntry;
					points.push({
						prompt,
						checkpoint: oldestCheckpointForTurn(branch, prompt.id),
						subject: userSubject(prompt),
					});
				}
				const checkpoint = checkpointsById.get(entry.id);
				if (checkpoint && !promptIds.has(checkpoint.turnEntryId))
					points.push({ checkpoint, subject: checkpoint.subject });
			}
			points.reverse();
			if (points.length === 0) {
				ctx.ui.notify("Nothing to rewind to yet.", "info");
				return;
			}

			const currentSha = await captureCheckpoint(ctx.cwd, pi.exec, ctx.sessionManager.getSessionId());
			let newerSha = currentSha;
			const rows = points.map((point) => {
				const { checkpoint } = point;
				const row = { ...point, toSha: newerSha };
				if (checkpoint) newerSha = checkpoint.sha;
				return row;
			});
			const stats = await Promise.all(
				rows.map((row) =>
					row.checkpoint ? diffNumstat(ctx.cwd, pi.exec, row.checkpoint.sha, row.toSha) : undefined,
				),
			);

			const failureNote =
				failedCaptureCount > 0
					? ` (${failedCaptureCount} checkpoint${failedCaptureCount === 1 ? "" : "s"} failed to capture this session — those prompts have no code restore)`
					: "";
			const labels = uniqueLabels(rows.map((row, i) => `${row.subject} · ${rowNote(stats[i])}`));
			const choice = await ctx.ui.select(`Rewind to:${failureNote}`, labels);
			if (!choice) return;
			const index = labels.indexOf(choice);
			const row = rows[index];
			if (!row) return;
			const target = stats[index] ? row.checkpoint : undefined;

			const kept =
				target && currentSha
					? await userAddedFiles(
							ctx.cwd,
							pi.exec,
							target.sha,
							currentSha,
							agentCreatedFiles(ctx.sessionManager.getEntries()),
						)
					: [];
			const effect =
				target && currentSha ? await diffNumstat(ctx.cwd, pi.exec, currentSha, target.sha, kept) : undefined;
			const BOTH = "Restore code and conversation";
			const TALK = "Restore conversation";
			const CODE = "Restore code";
			const scope = await ctx.ui.select(
				[
					row.prompt
						? "Confirm you want to restore to the point before you sent this message:"
						: "Confirm you want to restore the code to this checkpoint:",
					row.subject,
					...(effect ? [restoreEffect(effect)] : []),
				].join("\n\n"),
				!row.prompt ? [CODE, "Never mind"] : target ? [BOTH, TALK, CODE, "Never mind"] : [TALK, "Never mind"],
			);
			if (scope !== BOTH && scope !== TALK && scope !== CODE) return;

			if (scope === TALK || !target) {
				if (row.prompt) await ctx.navigateTree(row.prompt.id);
				return;
			}

			let safety: CheckpointData | undefined;
			if (effect?.files.length === 0) {
				ctx.ui.notify("Working tree already matches this checkpoint.", "info");
				if (scope === CODE) return;
			} else {
				const result = await restoreOverSafetyNet(
					pi,
					ctx,
					target.sha,
					currentSha,
					"(before rewind)",
					`Restore the working tree to the checkpoint "${target.subject}"?`,
				);
				if (!result.restored) return;
				safety = result.safety;
			}
			if (scope === CODE || !row.prompt) return;
			const { cancelled } = await ctx.navigateTree(row.prompt.id);
			if (!cancelled && safety) reappendSafetyNetOnNewBranch(pi, safety);
		},
	});
}

/** pi's own double-Esc window. */
const DOUBLE_ESCAPE_MS = 500;

const checkpointsExtension: InlineExtension = { name: "checkpoints", factory };
export default timed("checkpoints", checkpointsExtension.factory);
