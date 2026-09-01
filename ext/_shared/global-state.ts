/**
 * A mutable ref that stays shared across every separately-loaded copy of a
 * module.
 *
 * pi's package loader gives each top-level `pi.extensions` entry its own
 * module graph (`loadExtensionModule`, `moduleCache: false`), so a plain
 * module-level `let` is NOT actually process-wide once two different
 * top-level extensions import the same file — each gets its own instance,
 * initialized independently. Confirmed live: `permissions`'s copy of
 * `sandbox/state.ts` never saw what `sandbox`'s own copy set, and likewise
 * for `hooks`' permission-bridge and `permissions`' active-mode read from the
 * subagent gate (loaded inside `subagents`'s own module graph).
 *
 * `globalThis` is the one thing that IS still a single object regardless of
 * how many times a source file is re-transformed and re-evaluated, so state
 * that must cross that boundary lives there instead, keyed by `Symbol.for`
 * (registry-scoped: the same key string from any loaded copy resolves to the
 * same symbol, and therefore the same property).
 */

export function sharedRef<T>(key: string, initial: T): { get(): T; set(value: T): void } {
	const symbol = Symbol.for(`bluclawd.${key}`);
	const store = globalThis as unknown as Record<symbol, T>;
	if (store[symbol] === undefined) store[symbol] = initial;
	return {
		get: () => store[symbol],
		set: (value: T) => {
			store[symbol] = value;
		},
	};
}
