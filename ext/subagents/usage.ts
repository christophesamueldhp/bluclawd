import type { Usage } from "@earendil-works/pi-ai";

export interface SubagentUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	hasUnknownCost: boolean;
}

/**
 * How a generation started. The SDK folds nested usage into a launch tool result until that result is
 * emitted; only a foreground result also carries the run's own usage. A resume has no launch result.
 */
export type GenerationKind = "foreground" | "background" | "resume";

/** Where a generation's usage went: pi's own totals through the tool result, or the background ledger. */
export type UsageAttribution = "tool_result" | "ledger";

/** Counts one generation's usage so that each token is attributed exactly once. */
export interface GenerationUsage {
	/** A copy of the usage this generation must attribute. */
	readonly totals: SubagentUsageTotals;
	addTurn(delta: Partial<SubagentUsageTotals>): void;
	/** Usage reported by an orchestrator tool the child ran. */
	addNested(delta: Partial<SubagentUsageTotals>): void;
	launchResultEmitted(): void;
	settle(): UsageAttribution;
}

export function createEmptySubagentUsage(): SubagentUsageTotals {
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

export function addSubagentUsage(target: SubagentUsageTotals, delta: Partial<SubagentUsageTotals>): void {
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

export function createGenerationUsage(options: { kind: GenerationKind }): GenerationUsage {
	const totals = createEmptySubagentUsage();
	let emitted = options.kind === "resume";
	return {
		get totals() {
			return structuredClone(totals);
		},
		addTurn: (delta) => addSubagentUsage(totals, delta),
		addNested: (delta) => {
			if (emitted) addSubagentUsage(totals, delta);
		},
		launchResultEmitted: () => {
			emitted = true;
		},
		settle: () => (options.kind === "foreground" && !emitted ? "tool_result" : "ledger"),
	};
}

export function toPiToolUsage(totals: SubagentUsageTotals): Usage {
	return {
		input: totals.input,
		output: totals.output,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		totalTokens: totals.totalTokens,
		cost: {
			input: totals.cost.input,
			output: totals.cost.output,
			cacheRead: totals.cost.cacheRead,
			cacheWrite: totals.cost.cacheWrite,
			total: totals.cost.total,
		},
	};
}
