/**
 * What passes between a run on pi's RPC and its orchestrator while it works, through the run's directory, a folder per
 * generation. The inbox holds messages for the run's pi: the orchestrator opens it before the run's host starts, and
 * the host seals it once the run's work settled with nothing left to take. A message that landed before the seal is
 * the host's to give its pi, or to name as untaken; one posted after it is refused, never lost. The outbox holds what
 * the run's pi sent out, numbered by the host, its only writer.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicPrivateFile } from "./storage.ts";

export interface RunInboxMessage {
	id: string;
	/** As the run's model reads it, framed with who sent it. */
	text: string;
}

/** What a run's message is: progress wakes nobody; the others reach their recipient while the run works. */
export const RUN_MESSAGE_KINDS = ["progress", "finding", "question", "blocker"] as const;
export type RunMessageKind = (typeof RUN_MESSAGE_KINDS)[number];

export interface RunOutboxMessage {
	seq: number;
	/** "parent", or a sibling run's name or run ID. */
	to: string;
	kind: RunMessageKind;
	content: string;
}

let posted = 0;

const inboxPath = (runDir: string, generation: number) => join(runDir, "inbox", String(generation));
const sealedPath = (runDir: string, generation: number) => `${inboxPath(runDir, generation)}.sealed`;
const outboxPath = (runDir: string, generation: number) => join(runDir, "outbox", String(generation));

export function openRunInbox(runDir: string, generation: number): void {
	mkdirSync(inboxPath(runDir, generation), { recursive: true, mode: 0o700 });
}

/**
 * Posts `text` to the run's generation `generation`: accepted once it landed in the open inbox, refused once the inbox
 * is sealed. A rename lands whole, and fails once the folder it goes to was renamed away by the seal. One that found
 * the folder just before may still land in it just after, so the seal waits for every post whose draft is still there.
 * A post with a `key` the inbox holds already, as one relayed again after a crash, lands once.
 */
export function postToRun(
	runDir: string,
	generation: number,
	text: string,
	key?: string,
): { accepted: true; id: string } | { accepted: false } {
	const keyed = key && `-${key.replaceAll("/", ".")}`;
	if (keyed) {
		const landed = [inboxPath(runDir, generation), sealedPath(runDir, generation)]
			.flatMap((dir) => {
				try {
					return readdirSync(dir);
				} catch {
					return [];
				}
			})
			.find((file) => file.endsWith(`${keyed}.json`));
		if (landed) return { accepted: true, id: landed.slice(0, -".json".length) };
	}
	// Named in the order posted: by time, then by this process's count within the same millisecond.
	const id = `${String(Date.now()).padStart(15, "0")}-${String(++posted).padStart(9, "0")}${keyed || `-${randomUUID()}`}`;
	const draft = join(runDir, `.${process.pid}-${id}.inbox`);
	writeFileSync(draft, JSON.stringify({ id, text } satisfies RunInboxMessage), { mode: 0o600 });
	try {
		renameSync(draft, join(inboxPath(runDir, generation), `${id}.json`));
		return { accepted: true, id };
	} catch (error) {
		rmSync(draft, { force: true });
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accepted: false };
		throw error;
	}
}

function readMessages(dir: string): RunInboxMessage[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	return files.sort().flatMap((file) => {
		try {
			return [JSON.parse(readFileSync(join(dir, file), "utf8")) as RunInboxMessage];
		} catch {
			return [];
		}
	});
}

/** The messages in the open inbox, in the order they landed. */
export const readRunInbox = (runDir: string, generation: number): RunInboxMessage[] =>
	readMessages(inboxPath(runDir, generation));

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const pause = new Int32Array(new SharedArrayBuffer(4));

/** Waits until every post another live process had in flight landed or was refused. */
function settlePosts(runDir: string): void {
	let files: string[];
	try {
		files = readdirSync(runDir);
	} catch {
		return;
	}
	for (const file of files) {
		const pid = Number(/^\.(\d+)-.*\.inbox$/.exec(file)?.[1]);
		// This process posts synchronously, so none of its own is in flight; a dead poster's draft never lands.
		if (!pid || pid === process.pid) continue;
		while (existsSync(join(runDir, file)) && alive(pid)) Atomics.wait(pause, 0, 0, 1);
	}
}

/** Seals the inbox, if still open, so nothing more lands in it; returns every message that did. */
export function sealRunInbox(runDir: string, generation: number): RunInboxMessage[] {
	try {
		renameSync(inboxPath(runDir, generation), sealedPath(runDir, generation));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Listed only after the rename: a post that starts later finds no open inbox.
	settlePosts(runDir);
	return readMessages(sealedPath(runDir, generation));
}

/** Opens a sealed inbox again: what landed just before the seal gave the run more work. */
export function unsealRunInbox(runDir: string, generation: number): void {
	if (existsSync(sealedPath(runDir, generation)))
		renameSync(sealedPath(runDir, generation), inboxPath(runDir, generation));
}

/** Notes that the host gave message `id` to the run's pi, which takes it at its next safe point. */
export function markGiven(runDir: string, generation: number, id: string): void {
	for (const dir of [inboxPath(runDir, generation), sealedPath(runDir, generation)]) {
		try {
			writeFileSync(join(dir, `${id}.given`), "", { mode: 0o600 });
			return;
		} catch {
			// Sealed meanwhile, by the host itself.
		}
	}
}

/** Resolves true once the host gave message `id` to the run's pi; false when `timeoutMs` passed first. */
export async function whenGiven(runDir: string, generation: number, id: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const given = [inboxPath(runDir, generation), sealedPath(runDir, generation)].some((dir) =>
			existsSync(join(dir, `${id}.given`)),
		);
		if (given) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Where the inbox of the run's generation is kept once sealed. */
export const sealedRunInbox = sealedPath;

export function writeRunOutbox(runDir: string, generation: number, message: RunOutboxMessage): void {
	writeAtomicPrivateFile(join(outboxPath(runDir, generation), `${message.seq}.json`), JSON.stringify(message));
}

/** What the run's generation sent after `seq`, in order. */
export function readRunOutbox(runDir: string, generation: number, seq: number): RunOutboxMessage[] {
	let seqs: number[];
	try {
		seqs = readdirSync(outboxPath(runDir, generation)).flatMap((file) => {
			const at = /^(\d+)\.json$/.exec(file);
			return at && Number(at[1]) > seq ? [Number(at[1])] : [];
		});
	} catch {
		return [];
	}
	const read: RunOutboxMessage[] = [];
	for (const next of seqs.sort((a, b) => a - b)) {
		// Numbered in order, so one not readable yet holds back those after it.
		if (next !== seq + read.length + 1) break;
		try {
			read.push(JSON.parse(readFileSync(join(outboxPath(runDir, generation), `${next}.json`), "utf8")));
		} catch {
			break;
		}
	}
	return read;
}

const relayedPath = (runDir: string, generation: number) => `${outboxPath(runDir, generation)}.relayed`;

/**
 * How far what the run's generation sent is held for good by its recipients, as the orchestrator relayed it: the
 * `seq` of the last one, 0 for none.
 */
export function relayedRunOutbox(runDir: string, generation: number): number {
	try {
		return Number(readFileSync(relayedPath(runDir, generation), "utf8")) || 0;
	} catch {
		return 0;
	}
}

/**
 * Stored once message `seq`, and every one before it, is held for good: a crash before then has it relayed again, and
 * its recipient takes it once.
 */
export function markRunOutboxRelayed(runDir: string, generation: number, seq: number): void {
	writeAtomicPrivateFile(relayedPath(runDir, generation), String(seq));
}
