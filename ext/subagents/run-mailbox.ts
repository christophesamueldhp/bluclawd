import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../../daemon/processes.ts";
import { bestEffort } from "./runs.ts";
import { writeAtomicPrivateFile } from "./storage.ts";

export interface RunInboxMessage {
	id: string;
	text: string;
}

export const RUN_MESSAGE_KINDS = ["progress", "finding", "question", "blocker"] as const;
export type RunMessageKind = (typeof RUN_MESSAGE_KINDS)[number];

export interface RunOutboxMessage {
	seq: number;
	to: string;
	kind: RunMessageKind;
	content: string;
}

export interface RunTypedNote {
	seq: number;
	kind: "typed";
	text: string;
}

export type RunOutboxEntry = RunOutboxMessage | RunTypedNote;

let posted = 0;

const inboxPath = (runDir: string, generation: number) => join(runDir, "inbox", String(generation));
export const sealedRunInbox = (runDir: string, generation: number) => `${inboxPath(runDir, generation)}.sealed`;
const outboxPath = (runDir: string, generation: number) => join(runDir, "outbox", String(generation));

const postDraft = {
	name: (id: string) => `.${process.pid}-${id}.inbox`,
	poster: (file: string): number | undefined => Number(/^\.(\d+)-.*\.inbox$/.exec(file)?.[1]) || undefined,
};

function landUnlessSealed(draft: string, inboxFile: string): boolean {
	try {
		renameSync(draft, inboxFile);
		return true;
	} catch (error) {
		rmSync(draft, { force: true });
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function openRunInbox(runDir: string, generation: number): void {
	mkdirSync(inboxPath(runDir, generation), { recursive: true, mode: 0o700 });
}

export function postToRun(
	runDir: string,
	generation: number,
	text: string,
	key?: string,
): { accepted: true; id: string } | { accepted: false } {
	const keyed = key && `-${key.replaceAll("/", ".")}`;
	if (keyed) {
		const landed = [inboxPath(runDir, generation), sealedRunInbox(runDir, generation)]
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
	const id = `${String(Date.now()).padStart(15, "0")}-${String(++posted).padStart(9, "0")}${keyed || `-${randomUUID()}`}`;
	const draft = join(runDir, postDraft.name(id));
	writeFileSync(draft, JSON.stringify({ id, text } satisfies RunInboxMessage), { mode: 0o600 });
	return landUnlessSealed(draft, join(inboxPath(runDir, generation), `${id}.json`))
		? { accepted: true, id }
		: { accepted: false };
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

export const readRunInbox = (runDir: string, generation: number): RunInboxMessage[] =>
	readMessages(inboxPath(runDir, generation));

const pause = new Int32Array(new SharedArrayBuffer(4));

function waitForPostsInFlight(runDir: string): void {
	let files: string[];
	try {
		files = readdirSync(runDir);
	} catch {
		return;
	}
	for (const file of files) {
		const pid = postDraft.poster(file);
		if (!pid || pid === process.pid) continue;
		while (existsSync(join(runDir, file)) && processAlive(pid)) Atomics.wait(pause, 0, 0, 1);
	}
}

export function sealRunInbox(runDir: string, generation: number): RunInboxMessage[] {
	try {
		renameSync(inboxPath(runDir, generation), sealedRunInbox(runDir, generation));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	waitForPostsInFlight(runDir);
	return readMessages(sealedRunInbox(runDir, generation));
}

export function unsealRunInbox(runDir: string, generation: number): void {
	if (existsSync(sealedRunInbox(runDir, generation)))
		renameSync(sealedRunInbox(runDir, generation), inboxPath(runDir, generation));
}

export function markGiven(runDir: string, generation: number, id: string): void {
	for (const dir of [inboxPath(runDir, generation), sealedRunInbox(runDir, generation)]) {
		if (bestEffort(() => writeFileSync(join(dir, `${id}.given`), "", { mode: 0o600 }))) return;
	}
}

export async function whenGiven(runDir: string, generation: number, id: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const given = [inboxPath(runDir, generation), sealedRunInbox(runDir, generation)].some((dir) =>
			existsSync(join(dir, `${id}.given`)),
		);
		if (given) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export function writeRunOutbox(runDir: string, generation: number, message: RunOutboxEntry): void {
	writeAtomicPrivateFile(join(outboxPath(runDir, generation), `${message.seq}.json`), JSON.stringify(message));
}

export function readRunOutbox(runDir: string, generation: number, seq: number): RunOutboxEntry[] {
	let seqs: number[];
	try {
		seqs = readdirSync(outboxPath(runDir, generation)).flatMap((file) => {
			const at = /^(\d+)\.json$/.exec(file);
			return at && Number(at[1]) > seq ? [Number(at[1])] : [];
		});
	} catch {
		return [];
	}
	const read: RunOutboxEntry[] = [];
	for (const next of seqs.sort((a, b) => a - b)) {
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

export function relayedRunOutbox(runDir: string, generation: number): number {
	try {
		return Number(readFileSync(relayedPath(runDir, generation), "utf8")) || 0;
	} catch {
		return 0;
	}
}

export function markRunOutboxRelayed(runDir: string, generation: number, seq: number): void {
	writeAtomicPrivateFile(relayedPath(runDir, generation), String(seq));
}
