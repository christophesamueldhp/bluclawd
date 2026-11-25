import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionUIContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { RUN_PANE_ENV } from "../../daemon/tmux.ts";
import { sharedRef } from "../_shared/global-state.ts";
import { writeAtomicPrivateFile } from "./storage.ts";

export const paneApprovalsUnanswerable = sharedRef<AbortSignal | undefined>("run-pane-unanswerable", undefined);

export interface RunApprovalAsk {
	action: string;
	target: string;
}

export interface RunApprovalRequest extends RunApprovalAsk {
	/** pi's id for the dialog, which only the dialog's answer carries. */
	id: string;
}

export const NETWORK_ACCESS = "network access to";

export type RunApprovalAnswer = "allow" | "deny" | "blocked";

/** The title of an approval's dialog in a run's pi is the request itself, which the host reads back. */
const TITLE_PREFIX = "bluclawd-run-approval:";
const ALLOW = "allow";
const DENY = "deny";

export async function askRunApproval(
	ui: Pick<ExtensionUIContext, "select">,
	ask: RunApprovalAsk,
	signal: AbortSignal | undefined,
): Promise<ToolCallEventResult | undefined> {
	const title = process.env[RUN_PANE_ENV]
		? `Allow this subagent ${ask.action} ${ask.target}?`
		: `${TITLE_PREFIX}${JSON.stringify({ action: ask.action, target: ask.target })}`;
	const unanswerable = process.env[RUN_PANE_ENV] ? paneApprovalsUnanswerable.get() : undefined;
	const ends = [signal, unanswerable].filter((ending): ending is AbortSignal => ending !== undefined);
	const answer = await ui.select(title, [ALLOW, DENY], { signal: ends.length ? AbortSignal.any(ends) : undefined });
	if (answer === ALLOW) return undefined;
	if (answer === DENY) return { block: true, reason: `Refused: the user did not allow ${ask.action} ${ask.target}.` };
	return {
		block: true,
		reason: `Blocked: ${ask.action} ${ask.target} needs the user's approval, and the user could not be asked. Do not work around it: tell your orchestrator with subagent_message (kind "blocker"), or name it in your report.`,
	};
}

export function runApprovalAsked(title: unknown): RunApprovalAsk | undefined {
	if (typeof title !== "string" || !title.startsWith(TITLE_PREFIX)) return undefined;
	try {
		const { action, target } = JSON.parse(title.slice(TITLE_PREFIX.length));
		return typeof action === "string" && typeof target === "string" ? { action, target } : undefined;
	} catch {
		return undefined;
	}
}

export const dialogAnswer = (answer: RunApprovalAnswer | undefined) =>
	answer === "allow" ? { value: ALLOW } : answer === "deny" ? { value: DENY } : { cancelled: true };

const dir = (runDir: string, generation: number) => join(runDir, "approvals", String(generation));
const file = (runDir: string, generation: number, id: string, ending: string) =>
	join(dir(runDir, generation), `${id}.${ending}`);
const isSafeFileName = (id: string) => /^[\w-]+$/.test(id);

export function storeRunApprovalRequest(runDir: string, generation: number, request: RunApprovalRequest): boolean {
	if (!isSafeFileName(request.id)) return false;
	writeAtomicPrivateFile(file(runDir, generation, request.id, "json"), JSON.stringify(request));
	return true;
}

export function openRunApprovalRequests(runDir: string, generation: number): RunApprovalRequest[] {
	let files: string[];
	try {
		files = readdirSync(dir(runDir, generation));
	} catch {
		return [];
	}
	return files.flatMap((name) => {
		const id = name.endsWith(".json") ? name.slice(0, -".json".length) : undefined;
		if (!id || files.includes(`${id}.answer`) || files.includes(`${id}.withdrawn`)) return [];
		try {
			return [JSON.parse(readFileSync(join(dir(runDir, generation), name), "utf8")) as RunApprovalRequest];
		} catch {
			return [];
		}
	});
}

export const markRunApprovalSeen = (runDir: string, generation: number, id: string) =>
	writeAtomicPrivateFile(file(runDir, generation, id, "seen"), "");

export function runApprovalSeenAt(runDir: string, generation: number, id: string): number {
	try {
		return statSync(file(runDir, generation, id, "seen")).mtimeMs;
	} catch {
		return 0;
	}
}

export const answerRunApproval = (runDir: string, generation: number, id: string, answer: RunApprovalAnswer) =>
	writeAtomicPrivateFile(file(runDir, generation, id, "answer"), answer);

export function runApprovalAnswer(runDir: string, generation: number, id: string): RunApprovalAnswer | undefined {
	try {
		const answer = readFileSync(file(runDir, generation, id, "answer"), "utf8");
		return answer === "allow" || answer === "deny" || answer === "blocked" ? answer : undefined;
	} catch {
		return undefined;
	}
}

export const withdrawRunApproval = (runDir: string, generation: number, id: string) =>
	writeAtomicPrivateFile(file(runDir, generation, id, "withdrawn"), "");

export const runApprovalWithdrawn = (runDir: string, generation: number, id: string) =>
	existsSync(file(runDir, generation, id, "withdrawn"));
