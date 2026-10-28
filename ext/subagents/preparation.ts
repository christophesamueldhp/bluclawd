import { assertPreparationCurrent } from "./workspace.ts";

declare const preparationBrand: unique symbol;
export interface SubagentPreparationContext {
	readonly signal: AbortSignal;
	readonly deadlineAt: number;
	readonly [preparationBrand]: true;
}
interface PreparationOwner {
	parentSessionId: string;
	runtimeGeneration: number;
	signal: AbortSignal;
	isCurrent(): boolean;
}
const contexts = new WeakMap<SubagentPreparationContext, PreparationOwner>();
const groups = new Map<string, { active: number; waiting: Array<{ start(): void }> }>();

async function acquire(key: string, signal: AbortSignal): Promise<() => void> {
	signal.throwIfAborted();
	let group = groups.get(key);
	if (!group) {
		group = { active: 0, waiting: [] };
		groups.set(key, group);
	}
	const release = () => {
		const next = group.waiting.shift();
		if (next) next.start();
		else if (--group.active === 0) groups.delete(key);
	};
	if (group.active < 2) {
		group.active++;
		return release;
	}
	if (group.waiting.length >= 4) throw new Error("Subagent preparation queue is at capacity");
	return new Promise((resolve, reject) => {
		const waiter = {
			start: () => {
				signal.removeEventListener("abort", abort);
				resolve(release);
			},
		};
		const abort = () => {
			const index = group.waiting.indexOf(waiter);
			if (index >= 0) group.waiting.splice(index, 1);
			reject(signal.reason);
		};
		group.waiting.push(waiter);
		signal.addEventListener("abort", abort, { once: true });
	});
}

export function assertSubagentPreparation(
	context: SubagentPreparationContext,
	parentSessionId: string,
	runtimeGeneration: number,
): void {
	const owner = contexts.get(context);
	if (!owner || owner.parentSessionId !== parentSessionId || owner.runtimeGeneration !== runtimeGeneration)
		throw new Error("Invalid or expired subagent preparation context");
	assertPreparationCurrent(context.signal, owner.isCurrent);
	if (Date.now() >= context.deadlineAt) throw new Error("Subagent preparation timed out");
}

export async function withSubagentPreparation<T>(
	input: PreparationOwner,
	operation: (context: SubagentPreparationContext) => Promise<T>,
): Promise<T> {
	const options = Object.freeze({ ...input });
	if (
		typeof options.parentSessionId !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(options.parentSessionId) ||
		!Number.isSafeInteger(options.runtimeGeneration) ||
		options.runtimeGeneration < 0
	)
		throw new Error("Invalid subagent preparation owner");
	const deadlineAt = Date.now() + 30_000;
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("Subagent preparation timed out")), 30_000);
	const signal = AbortSignal.any([options.signal, deadline.signal]);
	const context = Object.freeze({ signal, deadlineAt }) as SubagentPreparationContext;
	let release: (() => void) | undefined;
	try {
		assertPreparationCurrent(signal, options.isCurrent);
		release = await acquire(`${options.parentSessionId}/${options.runtimeGeneration}`, signal);
		contexts.set(context, { ...options, signal });
		assertSubagentPreparation(context, options.parentSessionId, options.runtimeGeneration);
		const result = await operation(context);
		assertSubagentPreparation(context, options.parentSessionId, options.runtimeGeneration);
		return result;
	} finally {
		contexts.delete(context);
		clearTimeout(timer);
		release?.();
	}
}
