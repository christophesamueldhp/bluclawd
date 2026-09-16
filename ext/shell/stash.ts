/**
 * Editor stash: park a half-written prompt, ask something else, bring it back.
 * One active stash per session; every stashed text also goes into a small
 * history on disk that `/stash` can insert from after a restart.
 *
 * Behaviour adapted from pi-powerline-footer's editor stash (MIT, Nico Bailon).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type StashAction = "stash" | "update" | "restore" | "nothing";

const hasText = (text: string) => text.trim().length > 0;

/** What Alt+S does for this editor text and active stash. */
export function stashAction(editorText: string, stashed: string | undefined): StashAction {
	if (hasText(editorText)) return stashed === undefined ? "stash" : "update";
	return stashed === undefined ? "nothing" : "restore";
}

export class StashHistory {
	private readonly path: string;
	private readonly limit: number;
	private readonly list: string[];

	constructor(path: string, limit = 50) {
		this.path = path;
		this.limit = limit;
		this.list = StashHistory.read(path).slice(0, limit);
	}

	/** Newest first. */
	get entries(): readonly string[] {
		return this.list;
	}

	add(text: string): void {
		if (!hasText(text) || this.list[0] === text) return;
		this.list.unshift(text);
		this.list.length = Math.min(this.list.length, this.limit);
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, `${JSON.stringify({ history: this.list })}\n`);
		} catch {
			// The in-memory history still works for this session.
		}
	}

	private static read(path: string): string[] {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { history?: unknown };
			return Array.isArray(parsed.history)
				? parsed.history.filter((entry): entry is string => typeof entry === "string" && hasText(entry))
				: [];
		} catch {
			return [];
		}
	}
}
