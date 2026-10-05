import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
export function canonicalSessionKey(path: string): string {
	let candidate = resolve(path);
	const suffix: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(candidate), ...suffix);
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			const parent = dirname(candidate);
			if (parent === candidate) return resolve(path);
			suffix.unshift(basename(candidate));
			candidate = parent;
		}
	}
}
interface Queue {
	tail: Promise<void>;
	revision: number;
	deletes: number;
	stops: number;
}
export class SessionOperations {
	private readonly queues = new Map<string, Queue>();
	isBlocked(key: string): boolean {
		const q = this.queues.get(key);
		return !!q && (q.deletes > 0 || q.stops > 0);
	}
	run<T>(key: string, operation: "start" | "stop" | "delete", work: () => Promise<T>): Promise<T> {
		const q = this.queues.get(key) ?? { tail: Promise.resolve(), revision: 0, deletes: 0, stops: 0 };
		if (operation === "start" && q.deletes) return Promise.reject(new Error("Session is being deleted"));
		this.queues.set(key, q);
		if (operation === "delete") {
			q.deletes++;
			q.revision++;
		}
		if (operation === "stop") q.stops++;
		const revision = q.revision;
		const result = q.tail.then(() => {
			if (operation === "start" && revision !== q.revision) throw new Error("Session deleted while waiting");
			return work();
		});
		const tail = result
			.then(
				() => undefined,
				() => undefined,
			)
			.then(() => {
				if (operation === "delete") q.deletes--;
				if (operation === "stop") q.stops--;
				if (q.tail === tail) this.queues.delete(key);
			});
		q.tail = tail;
		return result;
	}
}
