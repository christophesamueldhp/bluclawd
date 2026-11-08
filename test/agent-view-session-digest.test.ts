import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { lastLine, textOf } from "../daemon/session-state.ts";
import { deriveLabel, SessionDigest, turnStartedAt } from "../ext/agent-view/self-registration.ts";

/** What a heartbeat read off its session's entries before the digest, walking them on every beat. */
function derived(sm: SessionManager) {
	const entries = sm.getEntries();
	const messages = entries.filter((e) => e.type === "message") as Array<{
		message: { role?: string; content?: unknown };
	}>;
	const lastAssistant = [...messages].reverse().find((e) => e.message.role === "assistant");
	return {
		name: sm.getSessionName(),
		firstPrompt: deriveLabel(undefined, entries),
		lastAnswer: lastAssistant ? lastLine(textOf(lastAssistant.message.content)) : undefined,
		answered: messages.some((e) => e.message.role === "assistant"),
		lastEntry: entries.at(-1) && { id: entries.at(-1)?.id, timestamp: entries.at(-1)?.timestamp },
		turnStartedAt: turnStartedAt(sm.getBranch()),
	};
}

const prompt = (sm: SessionManager, text: string) =>
	sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const answer = (sm: SessionManager, text: string) =>
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});

/** `sm` with a count of each walk of its entries. */
function counted<T extends object>(sm: T) {
	const walks = { n: 0 };
	const walking = new Set(["getEntries", "getBranch", "getSessionName"]);
	const proxy = new Proxy(sm, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (walking.has(String(key))) walks.n++;
				return value.apply(target, args);
			};
		},
	});
	return { sm: proxy, walks };
}

describe("SessionDigest (what a heartbeat reads off its session)", () => {
	it("reads the same as walking the entries, at every step of a scripted session", () => {
		const dir = mkdtempSync(join(tmpdir(), "bc-digest-"));
		const sm = SessionManager.create(dir, dir);
		const digest = new SessionDigest();
		const step = (what: string) => expect(digest.read(sm), what).toEqual(derived(sm));
		// Each read twice: the second one is the cached one.
		const check = (what: string) => {
			step(what);
			step(`${what}, again`);
		};

		check("blank");
		const first = prompt(sm, "  \n");
		check("a blank prompt");
		prompt(sm, "Fix the build\nthen the tests");
		check("a prompt");
		const a1 = answer(sm, "Looking.\n\n- fixed it");
		check("an answer");
		sm.appendCustomEntry("bluclawd:note", { x: 1 });
		check("a custom entry");
		sm.appendSessionInfo("build fixes");
		check("a name");
		sm.appendLabelChange(a1, "here");
		check("a label");
		const p2 = prompt(sm, "And the docs");
		const a2 = answer(sm, "Done with the docs");
		check("a second turn");
		sm.appendSessionInfo("");
		check("the name cleared");

		sm.branch(a1);
		check("/tree back to the first answer");
		const b1 = prompt(sm, "Instead, the lint");
		check("a prompt on the new branch");
		sm.branch(a2);
		check("/tree back to the branch left, whose leaf is no longer the last entry");
		sm.branch(b1);
		answer(sm, "Lint is clean");
		sm.branch(a2);
		check("an entry added then /tree back to the same leaf");
		sm.branchWithSummary(p2, "tried the docs");
		check("/tree with a summary");
		sm.resetLeaf();
		check("/tree to before the first prompt");
		sm.branch(first);
		sm.appendCompaction("summary", first, 10);
		check("a compaction");

		const file = sm.getSessionFile() as string;
		const reopened = SessionManager.open(file, dir);
		expect(digest.read(reopened), "/reload: the same session, another manager").toEqual(derived(reopened));
		sm.setSessionFile(file);
		check("the same file loaded again");
		sm.createBranchedSession(a2);
		check("/fork");
		sm.newSession();
		check("/new");
		prompt(sm, "A new task");
		check("its first prompt");
	});

	it("walks the entries again only once the session has changed", () => {
		const { sm, walks } = counted(SessionManager.inMemory("/w"));
		const digest = new SessionDigest();
		prompt(sm, "hi");
		digest.read(sm);
		const once = walks.n;
		expect(once).toBeGreaterThan(0);

		digest.read(sm);
		digest.read(sm);
		expect(walks.n, "unchanged").toBe(once);

		answer(sm, "hello");
		digest.read(sm);
		expect(walks.n, "an entry added").toBe(once * 2);
		sm.branch(sm.getEntries()[0].id);
		walks.n = 0;
		digest.read(sm);
		expect(walks.n, "the leaf moved").toBe(once);
	});

	it("walks them every time from a session manager that cannot count its entries", () => {
		const sm = SessionManager.inMemory("/w");
		prompt(sm, "hi");
		const { sm: plain, walks } = counted({
			getLeafId: () => sm.getLeafId(),
			getEntries: () => sm.getEntries(),
			getBranch: () => sm.getBranch(),
			getSessionName: () => sm.getSessionName(),
		});
		const digest = new SessionDigest();
		digest.read(plain);
		const once = walks.n;
		answer(sm, "hello");
		expect(digest.read(plain)).toEqual(derived(sm));
		expect(walks.n).toBe(once * 2);
	});
});
