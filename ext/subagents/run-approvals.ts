/**
 * Approvals a run on pi's RPC needs from the user, asked in its orchestrator (spec §10). A policy in the run's pi asks
 * with {@link askRunApproval} for a call its run may make only once the user allows it: never for one beyond the run's
 * grants or deny rules, which rpc-child.ts refuses before any other extension sees the call. The ask is one of pi's
 * dialogs, which pi's RPC hands the run's host; the host stores it in the run's directory, by generation and by pi's
 * id for the dialog, and gives pi the answer the orchestrator stores beside it. The orchestrator notes that it saw
 * the request: one nobody saw in time has no one to ask, and the host answers it as blocked. A request ends once
 * answered, or withdrawn by the host when its run stops, and nothing answers it after.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionUIContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { writeAtomicPrivateFile } from "./storage.ts";

/** What a run asks to do, and to what. */
export interface RunApprovalAsk {
	action: string;
	target: string;
}

export interface RunApprovalRequest extends RunApprovalAsk {
	/** pi's id for the dialog, which only the dialog's answer carries. */
	id: string;
}

/** The user allowed or refused it; or no one could be asked. */
export type RunApprovalAnswer = "allow" | "deny" | "blocked";

/** The title of an approval's dialog in a run's pi: the request itself, which the host reads back. */
const TITLE_PREFIX = "bluclawd-run-approval:";
const ALLOW = "allow";
const DENY = "deny";

/**
 * Asks the user, through the run's orchestrator, to allow `ask`: undefined once allowed, or why the call is refused.
 * `signal` is the run's work: a stopped run's ask ends with it.
 */
export async function askRunApproval(
	ui: Pick<ExtensionUIContext, "select">,
	ask: RunApprovalAsk,
	signal: AbortSignal | undefined,
): Promise<ToolCallEventResult | undefined> {
	const title = `${TITLE_PREFIX}${JSON.stringify({ action: ask.action, target: ask.target })}`;
	const answer = await ui.select(title, [ALLOW, DENY], { signal });
	if (answer === ALLOW) return undefined;
	if (answer === DENY) return { block: true, reason: `Refused: the user did not allow ${ask.action} ${ask.target}.` };
	return {
		block: true,
		reason: `Blocked: ${ask.action} ${ask.target} needs the user's approval, and the user could not be asked. Do not work around it: tell your orchestrator with subagent_message (kind "blocker"), or name it in your report.`,
	};
}

/** The approval a dialog of the run's pi asks for, from its title; undefined for any other dialog. */
export function runApprovalAsked(title: unknown): RunApprovalAsk | undefined {
	if (typeof title !== "string" || !title.startsWith(TITLE_PREFIX)) return undefined;
	try {
		const { action, target } = JSON.parse(title.slice(TITLE_PREFIX.length));
		return typeof action === "string" && typeof target === "string" ? { action, target } : undefined;
	} catch {
		return undefined;
	}
}

/** What pi's dialog takes as the answer. */
export const dialogAnswer = (answer: RunApprovalAnswer | undefined) =>
	answer === "allow" ? { value: ALLOW } : answer === "deny" ? { value: DENY } : { cancelled: true };

const dir = (runDir: string, generation: number) => join(runDir, "approvals", String(generation));
const file = (runDir: string, generation: number, id: string, ending: string) =>
	join(dir(runDir, generation), `${id}.${ending}`);
/** pi's ids are UUIDs; anything else would not name a file of the folder. */
const validId = (id: string) => /^[\w-]+$/.test(id);

/** The host's: stores the request of a dialog its run's pi opened. */
export function storeRunApprovalRequest(runDir: string, generation: number, request: RunApprovalRequest): boolean {
	if (!validId(request.id)) return false;
	writeAtomicPrivateFile(file(runDir, generation, request.id, "json"), JSON.stringify(request));
	return true;
}

/** The orchestrator's: requests of the generation still open, neither answered nor withdrawn. */
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

/** The orchestrator's: it saw request `id`, and will answer it. */
export const markRunApprovalSeen = (runDir: string, generation: number, id: string) =>
	writeAtomicPrivateFile(file(runDir, generation, id, "seen"), "");

export const runApprovalSeen = (runDir: string, generation: number, id: string) =>
	existsSync(file(runDir, generation, id, "seen"));

/** The orchestrator's answer to request `id`. */
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

/** The host's: request `id` takes no answer any more. */
export const withdrawRunApproval = (runDir: string, generation: number, id: string) =>
	writeAtomicPrivateFile(file(runDir, generation, id, "withdrawn"), "");

export const runApprovalWithdrawn = (runDir: string, generation: number, id: string) =>
	existsSync(file(runDir, generation, id, "withdrawn"));
