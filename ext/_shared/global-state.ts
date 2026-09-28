/**
 * A mutable ref shared across every separately-loaded copy of a module.
 *
 * pi's loader gives each top-level `pi.extensions` entry its own module graph,
 * so a module-level `let` is NOT process-wide once two extensions import the
 * same file: each gets its own instance. `globalThis` stays a single object,
 * so shared state lives there, keyed by `Symbol.for` so every copy resolves
 * the same key to the same property.
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
