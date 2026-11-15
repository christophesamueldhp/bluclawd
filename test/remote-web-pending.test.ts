import { describe, expect, it } from "vitest";
import { arrive, openChat, promptSent } from "#remote-web/chat.js";
import { pendingStore } from "#remote-web/pending.js";

/** A prompt typed and sent at `at`. */
const send = (chat: ReturnType<typeof openChat>, text: string, at: number) =>
	promptSent(chat, text, [], { text, selections: [] }, at);

/** Browser storage, in memory. */
function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		key: (index) => [...items.keys()][index] ?? null,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, String(value)),
		removeItem: (key) => void items.delete(key),
		clear: () => items.clear(),
	};
}

describe("pending prompts kept on the phone", () => {
	it("survive a reload when sent before the pane's first report, and are settled by id", () => {
		const storage = memoryStorage();
		const before = openChat("a");
		const queued = send(before, "queued", 100);
		const refused = send(before, "refused", 110);
		pendingStore(() => storage).save(before);

		const store = pendingStore(() => storage);
		const chat = openChat("a", store.load("a"));
		arrive(chat, { status: { models: [], outcomes: [] } }, 1000);
		const replay = [
			{ id: queued.id, outcome: "queued" as const },
			{ id: refused.id, outcome: "refused" as const, reason: "busy" as const },
		];
		const failed = arrive(chat, { replay }, 1000).returned;
		expect(failed.map(({ entry, reason }) => [entry.prompt, reason])).toEqual([["refused", "busy"]]);
		expect(chat.pending.map((p) => [p.prompt, p.outcome])).toEqual([["queued", "queued"]]);
		store.save(chat);
		expect(store.load("a").map((p) => p.prompt)).toEqual(["queued"]);
	});

	it("are kept per row, and none once a row has none", () => {
		const storage = memoryStorage();
		const store = pendingStore(() => storage);
		const a = openChat("a");
		send(a, "for a", 100);
		store.save(a);
		const b = openChat("b");
		send(b, "for b", 100);
		store.save(b);
		expect(store.load("a").map((p) => p.prompt)).toEqual(["for a"]);
		a.pending = [];
		store.save(a);
		expect(store.load("a")).toEqual([]);
		expect(storage.length).toBe(1);
	});

	it("are let go for the rows the session list no longer has, and kept for those it has, with their drafts", () => {
		const storage = memoryStorage();
		storage.setItem("bluclawd-view-mode", "list");
		const store = pendingStore(() => storage);
		for (const id of ["a", "b", "c"]) {
			const chat = openChat(id);
			send(chat, `for ${id}`, 100);
			store.save(chat);
			store.saveDraft(id, `draft ${id}`);
		}
		store.prune(["b"]);
		expect(["a", "b", "c"].map((id) => store.load(id).length)).toEqual([0, 1, 0]);
		expect(["a", "b", "c"].map((id) => store.draft(id))).toEqual(["", "draft b", ""]);
		expect(storage.getItem("bluclawd-view-mode")).toBe("list");
	});

	it("are none, and nothing throws, when the storage throws", () => {
		const fails = () => {
			throw new Error("SecurityError");
		};
		const throwing: Storage = { ...memoryStorage(), getItem: fails, setItem: fails, removeItem: fails, key: fails };
		for (const storage of [() => throwing, fails]) {
			const store = pendingStore(storage);
			const chat = openChat("a");
			send(chat, "hi", 100);
			expect(() => store.save(chat)).not.toThrow();
			expect(store.load("a")).toEqual([]);
			expect(() => store.saveDraft("a", "hi")).not.toThrow();
			expect(store.draft("a")).toBe("");
			expect(() => store.prune([])).not.toThrow();
		}
	});

	it("are none rather than an older list when the storage is full", () => {
		const storage = memoryStorage();
		const store = pendingStore(() => storage);
		const chat = openChat("a");
		send(chat, "first", 100);
		store.save(chat);
		storage.setItem = () => {
			throw new Error("QuotaExceededError");
		};
		send(chat, "second", 110);
		store.save(chat);
		expect(store.load("a")).toEqual([]);
	});

	it("survive a reload when put back in the reply box, as its unsent draft", () => {
		const storage = memoryStorage();
		pendingStore(() => storage).saveDraft("a", "lost prompt\ntyped since");
		pendingStore(() => storage).saveDraft("b", "other row");
		const store = pendingStore(() => storage);
		expect(store.draft("a")).toBe("lost prompt\ntyped since");
		// Sent, or emptied: none kept.
		store.saveDraft("a", "");
		expect(store.draft("a")).toBe("");
		expect(storage.getItem("bluclawd-draft:a")).toBeNull();
		expect(store.draft("b")).toBe("other row");
	});
});
