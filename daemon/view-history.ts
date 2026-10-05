import { readFileSync } from "node:fs";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { type HistoryPage, VIEW_HISTORY_LIMIT, type ViewMessage } from "./view-types.ts";
export function readViewHistory(sessionFile: string, before?: string, limit = VIEW_HISTORY_LIMIT): HistoryPage {
	const content = readFileSync(sessionFile, "utf8");
	const lines = content
		.slice(0, content.lastIndexOf("\n") + 1)
		.split("\n")
		.filter(Boolean);
	const entries = lines.map((line) => JSON.parse(line) as SessionEntry).filter((e) => e.id);
	const index = new Map(entries.map((e) => [e.id, e]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let entry = entries.at(-1);
	while (entry) {
		if (seen.has(entry.id)) throw new Error("Session history cycle");
		seen.add(entry.id);
		branch.push(entry);
		entry = entry.parentId ? index.get(entry.parentId) : undefined;
	}
	branch.reverse();
	const boundary = before ? branch.findIndex((e) => e.id === before) : branch.length;
	if (boundary < 0) throw new Error("Unknown history cursor");
	const size =
		Number.isFinite(limit) && limit > 0 ? Math.min(VIEW_HISTORY_LIMIT, Math.floor(limit)) : VIEW_HISTORY_LIMIT;
	const start = Math.max(0, boundary - size);
	const selected = branch.slice(start, boundary);
	const messages = selected.flatMap((e) =>
		sessionEntryToContextMessages(e)
			.filter((m) => String(m.role) !== "system")
			.map((message, i) => ({ key: i ? e.id + ":" + i : e.id, entryId: e.id, message })),
	);
	return { messages, before: start ? selected[0]?.id : undefined };
}
export function reconcileEntryIds(messages: ViewMessage[], persisted: ViewMessage[]): ViewMessage[] {
	const used = new Set(messages.flatMap((m) => (m.entryId ? [m.entryId] : [])));
	let cursor = 0;
	return messages.map((m) => {
		if (m.entryId) return m;
		for (let i = cursor; i < persisted.length; i++) {
			const p = persisted[i];
			if (p.entryId && used.has(p.entryId)) continue;
			if (p.message.role !== m.message.role || p.message.timestamp !== m.message.timestamp) continue;
			if (
				m.message.role === "toolResult" &&
				p.message.role === "toolResult" &&
				m.message.toolCallId !== p.message.toolCallId
			)
				continue;
			cursor = i + 1;
			if (p.entryId) used.add(p.entryId);
			return { ...m, entryId: p.entryId };
		}
		return m;
	});
}
