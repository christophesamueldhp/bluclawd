import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionUsage } from "../../daemon/ipc/protocol.ts";

export function createEmptySubagentUsage(): SessionUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
		hasUnknownCost: false,
	};
}

export function addSubagentUsage(target: SessionUsage, delta: Partial<SessionUsage>): void {
	const input = delta.input ?? 0;
	const output = delta.output ?? 0;
	const cacheRead = delta.cacheRead ?? 0;
	const cacheWrite = delta.cacheWrite ?? 0;
	const totalTokens = delta.totalTokens ?? input + output + cacheRead + cacheWrite;

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;

	if (delta.cost) {
		target.cost.input += delta.cost.input ?? 0;
		target.cost.output += delta.cost.output ?? 0;
		target.cost.cacheRead += delta.cost.cacheRead ?? 0;
		target.cost.cacheWrite += delta.cost.cacheWrite ?? 0;
		target.cost.total += delta.cost.total ?? 0;
	}
	if (delta.hasUnknownCost) {
		target.hasUnknownCost = true;
	}
}

/** A session's usage so far, as pi's own totals count it: every entry of the session, not only its branch. */
export function sessionUsage(entries: readonly SessionEntry[]): SessionUsage {
	const totals = createEmptySubagentUsage();
	for (const entry of entries) {
		let counted: Usage | undefined;
		if (entry.type === "usage") counted = entry.usage;
		else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult"))
			counted = entry.message.usage;
		else if (entry.type === "branch_summary" || entry.type === "compaction") counted = entry.usage;
		if (counted) addSubagentUsage(totals, counted);
	}
	return totals;
}
