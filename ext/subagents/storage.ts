import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeReportText } from "./results.ts";
import { sanitizeDiagnosticText } from "./runner.ts";
import {
	addSubagentUsage,
	createEmptySubagentUsage,
	isTerminalSubagentStatus,
	type SubagentRunRecord,
	type SubagentUsageTotals,
} from "./runs.ts";

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

export interface BackgroundUsageLedger {
	parentSessionId: string;
	runCount: number;
	recordedRunIds: string[];
	usage: SubagentUsageTotals;
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

function writeAtomicPrivateFile(filePath: string, content: string): void {
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
): { ok: boolean; sessionDir?: string; error?: string } {
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
): { ok: boolean; runDir?: string; error?: string } {
	if (isSafePathSegment(parentSessionId) && !isSafePathSegment(runId)) {
		return { ok: false, error: `Invalid runId "${runId}" for subagent storage` };
	}
	const session = ensureSessionStorageDir(agentDir, parentSessionId);
	if (!session.ok || !session.sessionDir) return { ok: false, error: session.error };
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
): { ok: boolean; recordPath?: string; error?: string } {
	const dirRes = ensureRunStorageDir(agentDir, record.parentSessionId, record.runId);
	if (!dirRes.ok || !dirRes.runDir) {
		return { ok: false, error: dirRes.error };
	}
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
		return parsed;
	} catch {
		return undefined;
	}
}

export function writeFullSubagentReport(
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
	fullReportText: string,
): { ok: boolean; reportPath?: string; error?: string } {
	const dirRes = ensureRunStorageDir(agentDir, record.parentSessionId, record.runId);
	if (!dirRes.ok || !dirRes.runDir) {
		return { ok: false, error: dirRes.error };
	}
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
): { ok: boolean; content?: string; truncated?: boolean; error?: string } {
	const record = readPersistedRunRecord(agentDir, parentSessionId, runId);
	if (!record) {
		return { ok: false, error: `Subagent run "${runId}" not found for current session.` };
	}
	const reportPath = join(getSubagentsRootDir(agentDir), parentSessionId, runId, "report.md");
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

export function reconcileInterruptedRuns(
	agentDir: string,
	parentSessionId: string,
	activeBranchEntries: readonly unknown[],
	liveRunIds: ReadonlySet<string> = new Set(),
): SubagentRunRecord[] {
	const referencedIds = extractReferencedRunIdsFromBranch(activeBranchEntries);
	const interrupted: SubagentRunRecord[] = [];

	for (const runId of referencedIds) {
		if (liveRunIds.has(runId)) continue;
		const persisted = readPersistedRunRecord(agentDir, parentSessionId, runId);
		if (!persisted) continue;
		if (!isTerminalSubagentStatus(persisted.status)) {
			persisted.status = "interrupted";
			persisted.complete = false;
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

function getBackgroundLedgerPath(agentDir: string, parentSessionId: string): string | undefined {
	if (!isSafePathSegment(parentSessionId)) return undefined;
	return join(getSubagentsRootDir(agentDir), parentSessionId, "background-usage-ledger.json");
}

export function readBackgroundUsageLedger(agentDir: string, parentSessionId: string): BackgroundUsageLedger {
	const empty: BackgroundUsageLedger = {
		parentSessionId,
		runCount: 0,
		recordedRunIds: [],
		usage: createEmptySubagentUsage(),
	};
	const ledgerPath = getBackgroundLedgerPath(agentDir, parentSessionId);
	if (!ledgerPath || !existsSync(ledgerPath)) return empty;
	try {
		const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as BackgroundUsageLedger;
		if (parsed.parentSessionId !== parentSessionId) return empty;
		return parsed;
	} catch {
		return empty;
	}
}

export function recordBackgroundUsageInLedger(
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
): BackgroundUsageLedger {
	const current = readBackgroundUsageLedger(agentDir, record.parentSessionId);
	// Never double-count foreground runs whose usage was already attributed to Pi
	if (record.deliveryMode === "foreground" || record.foregroundUsageAttributed) {
		return current;
	}
	// Each resumed generation of a run carries only its own usage.
	const ledgerKey = record.generation ? `${record.runId}#${record.generation}` : record.runId;
	if (current.recordedRunIds.includes(ledgerKey)) {
		return current;
	}

	current.recordedRunIds.push(ledgerKey);
	current.runCount = current.recordedRunIds.length;
	addSubagentUsage(current.usage, record.usage);

	const ledgerPath = getBackgroundLedgerPath(agentDir, record.parentSessionId);
	if (ledgerPath) {
		try {
			writeAtomicPrivateFile(ledgerPath, `${JSON.stringify(current, null, 2)}\n`);
		} catch {
			// Keep in-memory ledger if disk write fails
		}
	}
	return current;
}
