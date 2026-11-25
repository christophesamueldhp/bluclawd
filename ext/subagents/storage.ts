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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionUsage } from "../../daemon/ipc/protocol.ts";
import type { ChainResultDetails } from "./chains.ts";
import { sanitizeDiagnosticText } from "./diagnostics.ts";
import type { ChainStep } from "./invocation.ts";
import { sanitizeReportText } from "./results.ts";
import {
	bestEffort,
	isLegacyRun,
	isTerminalSubagentStatus,
	type PiSettlement,
	type SubagentRunRecord,
} from "./runs.ts";
import { addSubagentUsage, createEmptySubagentUsage } from "./usage.ts";

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
	runCount: number;
	usage: SessionUsage;
}

interface StoredRunUsageLedger extends RunUsageLedger {
	recordedRunIds: string[];
	sessions?: Record<string, Record<string, SessionUsage>>;
	counted?: Record<string, SessionUsage>;
}

const runIdOfInProcessGeneration = (generationKey: string): string => generationKey.split("#")[0];

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
	if (process.platform !== "win32") bestEffort(() => chmodSync(dirPath, 0o700));
}

export function writeAtomicPrivateFile(filePath: string, content: string): void {
	const parentDir = dirname(filePath);
	ensurePrivateDir(parentDir);
	const tmpPath = `${filePath}.tmp.${process.pid}.${atomicWriteSeq++}`;
	try {
		writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
		if (process.platform !== "win32") bestEffort(() => chmodSync(tmpPath, 0o600));
		renameSync(tmpPath, filePath);
	} catch (err) {
		bestEffort(() => rmSync(tmpPath, { force: true }));
		throw err;
	}
}

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

export interface StoredRunReport {
	seq: number;
	text: string;
	outcome?: PiSettlement;
	usage?: SessionUsage;
	sessionId?: string;
	generation?: number;
	untaken?: number;
}

const runReportsDir = (runDir: string) => join(runDir, "reports");

export function storeRunReport(runDir: string, report: Omit<StoredRunReport, "seq">): number {
	const seq = Math.max(0, ...storedSeqs(runDir)) + 1;
	writeAtomicPrivateFile(storedRunReportTextPath(runDir, seq), `${sanitizeReportText(report.text)}\n`);
	writeAtomicPrivateFile(join(runReportsDir(runDir), `${seq}.json`), JSON.stringify({ ...report, seq }));
	return seq;
}

export const storedRunReportTextPath = (runDir: string, seq: number) => join(runReportsDir(runDir), `${seq}.md`);

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

export function subagentRunDir(agentDir: string, parentSessionId: string, runId: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, runId);
}

export function chainResultPath(agentDir: string, parentSessionId: string, chain: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, "chain-results", `${chain}.json`);
}

export interface ChainPlan {
	chain: string;
	steps: ChainStep[];
	toolCallId: string;
	parentTurnId: string;
	writes: boolean;
	ran: ({ runId: string; generation: number } | null)[];
	stopped?: true;
	settled?: true;
}

export function chainPlanPath(agentDir: string, parentSessionId: string, chain: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, "chain-plans", `${chain}.json`);
}

export function readChainPlan(path: string): ChainPlan | undefined {
	try {
		const plan = JSON.parse(readFileSync(path, "utf8")) as ChainPlan;
		return Array.isArray(plan.steps) && Array.isArray(plan.ran) && plan.ran.length === plan.steps.length
			? plan
			: undefined;
	} catch {
		return undefined;
	}
}

export function readChainResult(
	agentDir: string,
	parentSessionId: string,
	chain: string,
): ChainResultDetails | undefined {
	try {
		return JSON.parse(readFileSync(chainResultPath(agentDir, parentSessionId, chain), "utf8"));
	} catch {
		return undefined;
	}
}

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
		parsed.generation ??= 0;
		return parsed;
	} catch {
		return undefined;
	}
}

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

function decodeLegacyStatus(record: SubagentRunRecord): void {
	const legacy = record as { status: string; stopSource?: string };
	if (legacy.status === "timed_out") record.stopReason ??= "Stopped by a deadline (legacy)";
	if (legacy.status === "budget_exceeded") record.stopReason ??= "Stopped by a budget (legacy)";
	const ended = ["completed", "timed_out", "budget_exceeded", ...(isLegacyRun(record) ? ["cancelled"] : [])];
	if (ended.includes(legacy.status)) record.status = "closed";
	if (legacy.status === "queued") record.status = "starting";
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

export function reconcileInterruptedRuns(
	agentDir: string,
	parentSessionId: string,
	liveRunIds: ReadonlySet<string> = new Set(),
): SubagentRunRecord[] {
	const interrupted: SubagentRunRecord[] = [];

	for (const persisted of listPersistedRunRecords(agentDir, parentSessionId)) {
		if (liveRunIds.has(persisted.runId)) continue;
		if (!isTerminalSubagentStatus(persisted.status)) {
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

export function appendSubagentMessageRecord(agentDir: string, parentSessionId: string, record: object): void {
	if (!isSafePathSegment(parentSessionId)) return;
	const sessionDir = join(getSubagentsRootDir(agentDir), parentSessionId);
	bestEffort(() => {
		ensurePrivateDir(sessionDir);
		appendFileSync(join(sessionDir, "messages.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	});
}

function getRunUsageLedgerPath(agentDir: string, parentSessionId: string): string | undefined {
	if (!isSafePathSegment(parentSessionId)) return undefined;
	return join(getSubagentsRootDir(agentDir), parentSessionId, "background-usage-ledger.json");
}

export function readRunUsageLedger(agentDir: string, parentSessionId: string): RunUsageLedger {
	const ledger = readLedgerFile(agentDir, parentSessionId);
	const usage = structuredClone(ledger.usage);
	const runs = new Set(ledger.recordedRunIds.map(runIdOfInProcessGeneration));
	for (const [runId, sessions] of Object.entries(ledger.sessions ?? {})) {
		runs.add(runId);
		for (const [sessionId, total] of Object.entries(sessions)) {
			addSubagentUsage(usage, beyond(total, ledger.counted?.[sessionId]));
		}
	}
	return { parentSessionId, runCount: runs.size, usage };
}

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

function readLedgerFile(agentDir: string, parentSessionId: string): StoredRunUsageLedger {
	const empty: StoredRunUsageLedger = {
		parentSessionId,
		runCount: 0,
		recordedRunIds: [],
		usage: createEmptySubagentUsage(),
	};
	const ledgerPath = getRunUsageLedgerPath(agentDir, parentSessionId);
	if (!ledgerPath || !existsSync(ledgerPath)) return empty;
	try {
		const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as StoredRunUsageLedger;
		if (parsed.parentSessionId !== parentSessionId) return empty;
		return parsed;
	} catch {
		return empty;
	}
}

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

function writeLedgerFile(agentDir: string, ledger: StoredRunUsageLedger): void {
	const ledgerPath = getRunUsageLedgerPath(agentDir, ledger.parentSessionId);
	if (!ledgerPath) return;
	bestEffort(() => writeAtomicPrivateFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`));
}
