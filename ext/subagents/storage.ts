import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type ExtensionAPI, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionUsage } from "../../daemon/ipc/protocol.ts";
import { sanitizeDiagnosticText } from "./diagnostics.ts";
import { sanitizeReportText } from "./results.ts";
import { isTerminalSubagentStatus, type RunRuntimeOutcome, type SubagentRunRecord } from "./runs.ts";
import { addSubagentUsage, createEmptySubagentUsage, sessionUsage } from "./usage.ts";

export const SUBAGENT_RUN_CUSTOM_ENTRY = "bluclawd.subagent-run";
export const MAX_AUTHORIZED_REPORT_VIEW_BYTES = 16 * 1024;

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
let atomicWriteSeq = 1;

export interface SubagentRunReferenceEntryData {
	runId: string;
	parentSessionId: string;
	agentName: string;
	status: string;
	deliveryMode: "foreground" | "background";
	originToolCallId: string;
	originEntryId?: string;
	admittedAt: number;
	endedAt?: number;
}

export interface RunUsageLedger {
	parentSessionId: string;
	/** How many runs the usage comes from. */
	runCount: number;
	/** The generations, `<runId>[#<generation>]`, whose usage `usage` holds: runs from before runs were pis of their own. */
	recordedRunIds: string[];
	usage: SessionUsage;
	/** Each run's sessions, by run ID and then session ID: each session's usage so far, as the run last reported it. */
	sessions?: Record<string, Record<string, SessionUsage>>;
	/**
	 * By session ID: what a session from before runs were pis of their own had counted already, in `usage` or the
	 * orchestrator's own totals, when a run resumed it.
	 */
	counted?: Record<string, SessionUsage>;
}

function isSafePathSegment(segment: string): boolean {
	return (
		typeof segment === "string" &&
		SAFE_SEGMENT_RE.test(segment) &&
		segment !== "." &&
		segment !== ".." &&
		!segment.includes("..")
	);
}

export function getSubagentsRootDir(agentDir: string): string {
	return resolve(agentDir, "bluclawd", "subagents");
}

export function subagentReportPath(agentDir: string, parentSessionId: string, runId: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, runId, "report.md");
}

function ensurePrivateDir(dirPath: string): void {
	mkdirSync(dirPath, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		try {
			chmodSync(dirPath, 0o700);
		} catch {
			// Ignore chmod errors on unsupported filesystems
		}
	}
}

export function writeAtomicPrivateFile(filePath: string, content: string): void {
	const parentDir = dirname(filePath);
	ensurePrivateDir(parentDir);
	const tmpPath = `${filePath}.tmp.${process.pid}.${atomicWriteSeq++}`;
	try {
		writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
		if (process.platform !== "win32") {
			try {
				chmodSync(tmpPath, 0o600);
			} catch {
				// Ignore chmod errors
			}
		}
		renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// Ignore cleanup failure
		}
		throw err;
	}
}

/** Creates the parent session's storage directory, where each of its runs keeps a directory of its own. */
export function ensureSessionStorageDir(
	agentDir: string,
	parentSessionId: string,
): { ok: true; sessionDir: string } | { ok: false; error: string } {
	if (!isSafePathSegment(parentSessionId)) {
		return { ok: false, error: `Invalid parentSessionId "${parentSessionId}" for subagent storage` };
	}
	const rootDir = getSubagentsRootDir(agentDir);
	const sessionDir = join(rootDir, parentSessionId);
	try {
		ensurePrivateDir(rootDir);
		ensurePrivateDir(sessionDir);
		return { ok: true, sessionDir };
	} catch (err) {
		return {
			ok: false,
			error: `Failed to initialize subagent storage directory "${sessionDir}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export function ensureRunStorageDir(
	agentDir: string,
	parentSessionId: string,
	runId: string,
): { ok: true; runDir: string } | { ok: false; error: string } {
	if (!isSafePathSegment(runId)) {
		return { ok: false, error: `Invalid runId "${runId}" for subagent storage` };
	}
	const session = ensureSessionStorageDir(agentDir, parentSessionId);
	if (!session.ok) return session;
	const runDir = join(session.sessionDir, runId);
	try {
		ensurePrivateDir(runDir);
		return { ok: true, runDir };
	} catch (err) {
		return {
			ok: false,
			error: `Failed to initialize subagent storage directory "${runDir}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/** The session a run in tmux keeps in its directory: the newest its pi wrote there. */
export function newestRunSession(runDir: string): string | undefined {
	try {
		return readdirSync(runDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(runDir, file))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
	} catch {
		return undefined;
	}
}

/** A Report as its run stored it before sending it, numbered among the run's Reports. */
export interface StoredRunReport {
	seq: number;
	/** What the run says of its work: its own claim. */
	text: string;
	/** How its work settled, as the runtime saw it; absent from a run in tmux, which stores its own Reports. */
	outcome?: RunRuntimeOutcome;
	usage?: SessionUsage;
	sessionId?: string;
	/** The run's generation that stored it; absent from a run in tmux. */
	generation?: number;
}

/** The run's own: the orchestrator rewrites `record.json` and `report.md`, so a run's Reports go in files of their own. */
const runReportsDir = (runDir: string) => join(runDir, "reports");

/**
 * Stores a run's Report before it is sent, as the next of its Reports, on from the earlier generations' in the same
 * run directory. Returns its `seq`.
 */
export function storeRunReport(runDir: string, report: Omit<StoredRunReport, "seq">): number {
	// By the files' names: a torn one keeps its number.
	const seq = Math.max(0, ...storedSeqs(runDir)) + 1;
	// Its text first, readable as it is: a cut Report's pointer names it, and the JSON numbers it.
	writeAtomicPrivateFile(storedRunReportTextPath(runDir, seq), `${sanitizeReportText(report.text)}\n`);
	writeAtomicPrivateFile(join(runReportsDir(runDir), `${seq}.json`), JSON.stringify({ ...report, seq }));
	return seq;
}

/** Where a run keeps the full text of its Report `seq`. */
export const storedRunReportTextPath = (runDir: string, seq: number) => join(runReportsDir(runDir), `${seq}.md`);

/** The numbers of the Reports a run stored, by their files' names. */
function storedSeqs(runDir: string): number[] {
	try {
		return readdirSync(runReportsDir(runDir)).flatMap((file) => {
			const at = /^(\d+)\.json$/.exec(file);
			return at ? [Number(at[1])] : [];
		});
	} catch {
		return [];
	}
}

/** The Reports a run stored after `seq`, in order; a torn one is skipped. */
export function readRunReports(runDir: string, seq: number): StoredRunReport[] {
	return storedSeqs(runDir)
		.filter((stored) => stored > seq)
		.sort((a, b) => a - b)
		.flatMap((stored) => {
			try {
				return [JSON.parse(readFileSync(join(runReportsDir(runDir), `${stored}.json`), "utf8")) as StoredRunReport];
			} catch {
				return [];
			}
		});
}

/** Where a run of the parent session keeps its session, task and Reports. */
export function subagentRunDir(agentDir: string, parentSessionId: string, runId: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, runId);
}

/** The parent session whose run `runDir` is: the one {@link subagentRunDir} kept it under. */
export function runDirParentSessionId(runDir: string): string {
	return basename(dirname(runDir));
}

function sanitizeRecordForStorage(record: Readonly<SubagentRunRecord>): SubagentRunRecord {
	const clone = structuredClone(record) as SubagentRunRecord;
	if (clone.errorMessage) {
		clone.errorMessage = sanitizeDiagnosticText(clone.errorMessage);
	}
	if (clone.stopReason) {
		clone.stopReason = sanitizeDiagnosticText(clone.stopReason);
	}
	if (clone.lastProgressText) {
		clone.lastProgressText = sanitizeReportText(clone.lastProgressText);
	}
	if (clone.summaryText) {
		clone.summaryText = sanitizeReportText(clone.summaryText);
	}
	return clone;
}

export function writePersistedRunRecord(
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
): { ok: true; recordPath: string } | { ok: false; error: string } {
	const dirRes = ensureRunStorageDir(agentDir, record.parentSessionId, record.runId);
	if (!dirRes.ok) return dirRes;
	const recordPath = join(dirRes.runDir, "record.json");
	try {
		const sanitized = sanitizeRecordForStorage(record);
		writeAtomicPrivateFile(recordPath, `${JSON.stringify(sanitized, null, 2)}\n`);
		return { ok: true, recordPath };
	} catch (err) {
		return {
			ok: false,
			error: `Failed to persist subagent run record "${recordPath}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export function readPersistedRunRecord(
	agentDir: string,
	parentSessionId: string,
	runId: string,
): SubagentRunRecord | undefined {
	if (!isSafePathSegment(parentSessionId) || !isSafePathSegment(runId)) {
		return undefined;
	}
	const recordPath = join(getSubagentsRootDir(agentDir), parentSessionId, runId, "record.json");
	if (!existsSync(recordPath)) return undefined;
	try {
		const raw = readFileSync(recordPath, "utf8");
		const parsed = JSON.parse(raw) as SubagentRunRecord;
		if (parsed.parentSessionId !== parentSessionId || parsed.runId !== runId) {
			return undefined;
		}
		decodeLegacyStatus(parsed);
		// Records stored before every generation was numbered lack it on the launch.
		parsed.generation ??= 0;
		return parsed;
	} catch {
		return undefined;
	}
}

/** Every run stored for the parent session. */
export function listPersistedRunRecords(agentDir: string, parentSessionId: string): SubagentRunRecord[] {
	if (!isSafePathSegment(parentSessionId)) return [];
	let runIds: string[];
	try {
		runIds = readdirSync(join(getSubagentsRootDir(agentDir), parentSessionId));
	} catch {
		return [];
	}
	return runIds.flatMap((runId) => readPersistedRunRecord(agentDir, parentSessionId, runId) ?? []);
}

/** Maps statuses and stop sources from before the queue and child quotas were removed, and before runs were pis. */
function decodeLegacyStatus(record: SubagentRunRecord): void {
	const legacy = record as { status: string; stopSource?: string };
	if (legacy.status === "timed_out") record.stopReason ??= "Stopped by a deadline (legacy)";
	if (legacy.status === "budget_exceeded") record.stopReason ??= "Stopped by a budget (legacy)";
	// An in-process run that ended kept its session, as a closed run does: it can be resumed from it.
	if (["completed", "cancelled", "timed_out", "budget_exceeded"].includes(legacy.status)) record.status = "closed";
	// A queued run never started, so reconciliation interrupts it like any other orphan.
	if (legacy.status === "queued") record.status = "starting";
	// A run from before runs were pis of their own, whose last turn had ended: an orphan, if it was never final.
	if (legacy.status === "finishing") record.status = "running";
	if (legacy.stopSource === "deadline" || legacy.stopSource === "budget") delete record.stopSource;
}

export function writeFullSubagentReport(
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
	fullReportText: string,
): { ok: true; reportPath: string } | { ok: false; error: string } {
	const dirRes = ensureRunStorageDir(agentDir, record.parentSessionId, record.runId);
	if (!dirRes.ok) return dirRes;
	const reportPath = join(dirRes.runDir, "report.md");
	try {
		const sanitized = sanitizeReportText(fullReportText);
		writeAtomicPrivateFile(reportPath, `${sanitized}\n`);
		return { ok: true, reportPath };
	} catch (err) {
		return {
			ok: false,
			error: `Failed to write subagent report "${reportPath}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export function readBoundedSubagentReport(
	agentDir: string,
	parentSessionId: string,
	runId: string,
	maxBytes = MAX_AUTHORIZED_REPORT_VIEW_BYTES,
): { ok: true; content: string; truncated: boolean } | { ok: false; error: string } {
	const record = readPersistedRunRecord(agentDir, parentSessionId, runId);
	if (!record) {
		return { ok: false, error: `Subagent run "${runId}" not found for current session.` };
	}
	const reportPath = subagentReportPath(agentDir, parentSessionId, runId);
	let raw = "";
	if (existsSync(reportPath)) {
		try {
			raw = readFileSync(reportPath, "utf8");
		} catch (err) {
			return {
				ok: false,
				error: `Could not read report for "${runId}": ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	} else {
		raw = record.summaryText ?? record.lastProgressText ?? `(Run ${runId} is ${record.status})`;
	}

	const sanitized = sanitizeReportText(raw);
	if (Buffer.byteLength(sanitized, "utf8") <= maxBytes) {
		return { ok: true, content: sanitized, truncated: false };
	}
	let acc = "";
	let bytes = 0;
	for (const ch of sanitized) {
		const b = Buffer.byteLength(ch, "utf8");
		if (bytes + b > maxBytes) break;
		acc += ch;
		bytes += b;
	}
	return {
		ok: true,
		content: `${acc.trimEnd()}\n\n...[Report view truncated at ${maxBytes} bytes]...`,
		truncated: true,
	};
}

export function appendParentRunReference(
	pi: Pick<ExtensionAPI, "appendEntry">,
	record: Readonly<SubagentRunRecord>,
): void {
	const payload: SubagentRunReferenceEntryData = {
		runId: record.runId,
		parentSessionId: record.parentSessionId,
		agentName: record.agentName,
		status: record.status,
		deliveryMode: record.deliveryMode,
		originToolCallId: record.originToolCallId,
		originEntryId: record.originEntryId,
		admittedAt: record.admittedAt,
		endedAt: record.endedAt,
	};
	pi.appendEntry(SUBAGENT_RUN_CUSTOM_ENTRY, payload);
}

export function extractReferencedRunIdsFromBranch(branchEntries: readonly unknown[]): string[] {
	const ids = new Set<string>();
	for (const entry of branchEntries) {
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as { type?: string; customType?: string; data?: { runId?: unknown } };
		if (
			rec.type === "custom" &&
			rec.customType === SUBAGENT_RUN_CUSTOM_ENTRY &&
			typeof rec.data?.runId === "string"
		) {
			ids.add(rec.data.runId);
		}
	}
	return Array.from(ids);
}

/**
 * Settles the session's runs that an earlier instance left open: a run in tmux as closed, any other as interrupted.
 * Those off the active branch too, as tree navigation would have closed them. Returns the records it changed.
 */
export function reconcileInterruptedRuns(
	agentDir: string,
	parentSessionId: string,
	liveRunIds: ReadonlySet<string> = new Set(),
): SubagentRunRecord[] {
	const interrupted: SubagentRunRecord[] = [];

	for (const persisted of listPersistedRunRecords(agentDir, parentSessionId)) {
		if (liveRunIds.has(persisted.runId)) continue;
		if (!isTerminalSubagentStatus(persisted.status)) {
			// A run in tmux its orchestrator lost is closed, its session kept, so it can be resumed. No foreground call
			// waits for it any more: a Report it stored comes as a notice (ADR-0008).
			const runDir = join(getSubagentsRootDir(agentDir), parentSessionId, persisted.runId);
			persisted.status = persisted.pane ? "closed" : "interrupted";
			if (persisted.pane) {
				persisted.transcriptPath ??= newestRunSession(runDir);
				persisted.deliveryMode = "background";
			}
			persisted.endedAt = Date.now();
			persisted.stopReason = "orphaned_on_restart";
			writePersistedRunRecord(agentDir, persisted);
			interrupted.push(persisted);
		}
	}

	return interrupted;
}

/** Appends one line per message attempt (who, to whom, order, outcome) to the session's message record. */
export function appendSubagentMessageRecord(agentDir: string, parentSessionId: string, record: object): void {
	if (!isSafePathSegment(parentSessionId)) return;
	const sessionDir = join(getSubagentsRootDir(agentDir), parentSessionId);
	try {
		ensurePrivateDir(sessionDir);
		appendFileSync(join(sessionDir, "messages.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	} catch {
		// The receipt already reached the sender; a lost audit line must not fail the message.
	}
}

function getRunUsageLedgerPath(agentDir: string, parentSessionId: string): string | undefined {
	if (!isSafePathSegment(parentSessionId)) return undefined;
	return join(getSubagentsRootDir(agentDir), parentSessionId, "background-usage-ledger.json");
}

/** Every run's usage the orchestrator does not count in its own totals: its runs' sessions included. */
export function readRunUsageLedger(agentDir: string, parentSessionId: string): RunUsageLedger {
	const ledger = readLedgerFile(agentDir, parentSessionId);
	const usage = structuredClone(ledger.usage);
	const runs = new Set(ledger.recordedRunIds.map((key) => key.split("#")[0]));
	for (const [runId, sessions] of Object.entries(ledger.sessions ?? {})) {
		runs.add(runId);
		for (const [sessionId, total] of Object.entries(sessions)) {
			addSubagentUsage(usage, beyond(total, ledger.counted?.[sessionId]));
		}
	}
	return { ...ledger, runCount: runs.size, usage };
}

/** What `total` holds beyond what was `counted` already. */
function beyond(total: SessionUsage, counted: SessionUsage | undefined): SessionUsage {
	if (!counted) return total;
	const less = (a: number, b: number) => Math.max(0, a - b);
	return {
		input: less(total.input, counted.input),
		output: less(total.output, counted.output),
		cacheRead: less(total.cacheRead, counted.cacheRead),
		cacheWrite: less(total.cacheWrite, counted.cacheWrite),
		totalTokens: less(total.totalTokens, counted.totalTokens),
		cost: {
			input: less(total.cost.input, counted.cost.input),
			output: less(total.cost.output, counted.cost.output),
			cacheRead: less(total.cost.cacheRead, counted.cost.cacheRead),
			cacheWrite: less(total.cost.cacheWrite, counted.cost.cacheWrite),
			total: less(total.cost.total, counted.cost.total),
		},
		hasUnknownCost: total.hasUnknownCost,
	};
}

function readLedgerFile(agentDir: string, parentSessionId: string): RunUsageLedger {
	const empty: RunUsageLedger = {
		parentSessionId,
		runCount: 0,
		recordedRunIds: [],
		usage: createEmptySubagentUsage(),
	};
	const ledgerPath = getRunUsageLedgerPath(agentDir, parentSessionId);
	if (!ledgerPath || !existsSync(ledgerPath)) return empty;
	try {
		const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as RunUsageLedger;
		if (parsed.parentSessionId !== parentSessionId) return empty;
		return parsed;
	} catch {
		return empty;
	}
}

/**
 * Keeps the usage a run's session reported last. The session's total already holds every earlier turn and
 * generation in it, so it replaces that session's previous one: each token is counted once. A run's other
 * sessions, such as the one it had before a `/new` in it, keep theirs.
 */
export function recordRunSessionUsage(
	agentDir: string,
	record: Pick<SubagentRunRecord, "parentSessionId" | "runId">,
	sessionId: string,
	usage: SessionUsage,
): void {
	const current = readLedgerFile(agentDir, record.parentSessionId);
	current.sessions = {
		...current.sessions,
		[record.runId]: { ...current.sessions?.[record.runId], [sessionId]: usage },
	};
	writeLedgerFile(agentDir, current);
}

/**
 * Notes what a session from before runs were pis of their own had counted already, once, before a run resumes it:
 * the run's Reports carry that session's whole total, earlier turns included.
 */
export function recordCountedSessionUsage(agentDir: string, parentSessionId: string, sessionFile: string): void {
	let entries: ReturnType<typeof parseSessionEntries>;
	try {
		entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
	} catch {
		return;
	}
	const header = entries.find((entry) => entry.type === "session");
	const current = readLedgerFile(agentDir, parentSessionId);
	if (!header || current.counted?.[header.id]) return;
	const counted = sessionUsage(entries.filter((entry): entry is SessionEntry => entry.type !== "session"));
	current.counted = { ...current.counted, [header.id]: counted };
	writeLedgerFile(agentDir, current);
}

function writeLedgerFile(agentDir: string, ledger: RunUsageLedger): void {
	const ledgerPath = getRunUsageLedgerPath(agentDir, ledger.parentSessionId);
	if (!ledgerPath) return;
	try {
		writeAtomicPrivateFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
	} catch {
		// Keep in-memory ledger if disk write fails
	}
}
