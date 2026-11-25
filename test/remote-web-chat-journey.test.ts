import { describe, expect, it } from "vitest";
import {
	applyLatest,
	arrive,
	listed,
	nextGiveUp,
	openChat,
	PROMPT_GIVE_UP_MS,
	promptSent,
	storedPending,
} from "#remote-web/chat.js";
import { PromptDelivery } from "../daemon/remote/delivery.ts";

type Chat = ReturnType<typeof openChat>;
type Pending = ReturnType<typeof promptSent>;

const user = (id: string, text: string) => ({ kind: "user", id, text });
const reply = (id: string, text = "ok") => ({ kind: "assistant", id, text, tools: [] });

const NOW = 1000;
const REPORTING = { models: [], outcomes: [] };
const OLDER = { models: [] };

const send = (chat: Chat, text: string, at = 100, images: Parameters<typeof promptSent>[2] = []) =>
	promptSent(chat, text, images, { text, selections: [] }, at);
const settle = (chat: Chat, outcomes: Extract<Parameters<typeof arrive>[1], { outcomes: unknown }>["outcomes"]) =>
	arrive(chat, { outcomes }, NOW).returned;
const giveUp = (
	chat: Chat,
	entry: Pending,
	state: string | undefined,
	row: { silent?: boolean; starting?: boolean } = {},
) => arrive(chat, { time: { state, ...row } }, entry.giveUpAt as number);
const notDelivered = (entry: Pending) => ({ entry, reason: "not_delivered" });

describe("prompts sent from the chat", () => {
	it("are marked started while the session works", () => {
		const chat = openChat("a");
		const entry = send(chat, "go");
		expect(listed(chat, "idle", "working", 200)).toBe(false);
		expect(entry.sawWorking).toBe(true);
	});

	it("are dropped when the turn ends, unless sent after it", () => {
		const chat = openChat("a");
		send(chat, "early", 100);
		const late = send(chat, "late", 300);
		expect(listed(chat, "working", "idle", 200)).toBe(true);
		applyLatest(chat, { messages: [], more: false });
		expect(chat.pending).toEqual([late]);
		applyLatest(chat, { messages: [], more: false });
		expect(chat.pending).toEqual([late]);
	});

	it("stay past the turn's end once queued by a pane that reports outcomes, which settles them", () => {
		const chat = openChat("a");
		arrive(chat, { status: REPORTING }, NOW);
		const queued = send(chat, "queued");
		send(chat, "sent");
		settle(chat, [{ id: queued.id, outcome: "queued" }]);
		expect(listed(chat, "working", "idle", 200)).toBe(true);
		applyLatest(chat, { messages: [], more: false });
		expect(chat.pending).toEqual([queued]);
		expect(settle(chat, [{ id: queued.id, outcome: "lost", reason: "dequeued" }])).toEqual([
			{ entry: queued, reason: "dequeued" },
		]);
	});

	it("keep waiting while a dialog is up", () => {
		const chat = openChat("a");
		send(chat, "go");
		expect(listed(chat, "working", "needs", 200)).toBe(false);
		expect(chat.dropUnwrittenSentBefore).toBeUndefined();
	});

	it("count the same text sent before them, and stop counting one the daemon did not take, which comes back", () => {
		const chat = openChat("a");
		const first = send(chat, "again", 100);
		const second = send(chat, "again", 200);
		expect(second.sameTextBefore).toBe(1);
		expect(arrive(chat, { notSent: first }, NOW)).toEqual({ returned: [{ entry: first }], ask: [], dropped: false });
		expect(chat.pending).toEqual([second]);
		expect(second.sameTextBefore).toBe(0);
	});

	it("are keyed as the transcript will show them, with their images and what was selected", () => {
		const chat = openChat("a");
		const image = { mimeType: "image/png", data: "", thumb: "" };
		const entry = send(chat, "look", 100, [image]);
		expect(entry.text).toBe("look\n[Image]");
		expect(entry.images).toEqual([image]);
		expect(entry.skillDraft).toEqual({ text: "look", selections: [] });
		expect(chat.sentAt).toBe(100);
	});

	it("are theirs once the daemon has them, under its lifetime", () => {
		const chat = openChat("a");
		const entry = send(chat, "go");
		expect(arrive(chat, { accepted: entry, lifetime: "lifetime-1" }, NOW).returned).toEqual([]);
		expect(entry.lifetime).toBe("lifetime-1");
	});

	it("are all let go when the session they were sent to start never came", () => {
		const chat = openChat("a");
		send(chat, "go");
		send(chat, "and this");
		expect(arrive(chat, { startTimedOut: true }, NOW).returned).toEqual([]);
		expect(chat.pending).toEqual([]);
	});
});

describe("a sent prompt's give-up", () => {
	it("puts it back in the reply box when it never reached the session, and not before its time", () => {
		const chat = openChat("a");
		chat.messages = [reply("1")];
		const entry = send(chat, "go", 100);
		expect(nextGiveUp(chat)).toBe(100 + PROMPT_GIVE_UP_MS);
		expect(arrive(chat, { time: { state: "idle" } }, 99 + PROMPT_GIVE_UP_MS).returned).toEqual([]);
		expect(chat.pending).toEqual([entry]);
		expect(giveUp(chat, entry, "idle").returned).toEqual([notDelivered(entry)]);
		expect(chat.pending).toEqual([]);
		expect(nextGiveUp(chat)).toBeUndefined();
	});

	it("waits on while the session works, and is not looked at again", () => {
		const chat = openChat("a");
		const entry = send(chat, "go");
		expect(giveUp(chat, entry, "working")).toEqual({ returned: [], ask: [], dropped: false });
		expect(chat.pending).toEqual([entry]);
		expect(nextGiveUp(chat)).toBeUndefined();
	});

	it("lets it go quietly when the transcript moved meanwhile", () => {
		const chat = openChat("a");
		chat.messages = [reply("1")];
		const entry = send(chat, "go");
		applyLatest(chat, { messages: [reply("1"), reply("2")], more: false });
		expect(giveUp(chat, entry, "idle")).toEqual({ returned: [], ask: [], dropped: true });
		expect(chat.pending).toEqual([]);
	});

	it("takes each prompt at its own time", () => {
		const chat = openChat("a");
		chat.messages = [reply("1")];
		const first = send(chat, "one", 100);
		const second = send(chat, "two", 5100);
		expect(nextGiveUp(chat)).toBe(100 + PROMPT_GIVE_UP_MS);
		expect(giveUp(chat, first, "idle").returned).toEqual([notDelivered(first)]);
		expect(chat.pending).toEqual([second]);
		expect(nextGiveUp(chat)).toBe(5100 + PROMPT_GIVE_UP_MS);
	});

	it("gives up on none while a session is starting, whose pane takes them or whose own timeout drops them", () => {
		const chat = openChat("a");
		chat.messages = [reply("1")];
		const entry = send(chat, "go");
		expect(giveUp(chat, entry, undefined, { starting: true })).toEqual({ returned: [], ask: [], dropped: false });
		expect(chat.pending).toEqual([entry]);
		expect(nextGiveUp(chat)).toBeUndefined();
	});
});

describe("prompts sent to a pane that reports their outcomes", () => {
	const reporting = () => {
		const chat = openChat("a");
		arrive(chat, { status: REPORTING }, NOW);
		chat.messages = [reply("1")];
		return chat;
	};

	it("each get an id of their own, the same text too", () => {
		const chat = reporting();
		const first = send(chat, "again", 100);
		const second = send(chat, "again", 200);
		expect(first.id).toMatch(/^[\w-]{1,64}$/);
		expect(second.id).not.toBe(first.id);
	});

	it("are settled by their own id, not by the transcript's text", () => {
		const chat = reporting();
		const first = send(chat, "again", 100);
		const second = send(chat, "again", 200);
		applyLatest(chat, { messages: [reply("1"), user("2", "again")], more: false });
		expect(chat.pending).toEqual([first, second]);
		settle(chat, [{ id: second.id, outcome: "queued" }]);
		expect(second.outcome).toBe("queued");
		settle(chat, [
			{ id: first.id, outcome: "taken" },
			{ id: second.id, outcome: "queued" },
		]);
		expect(chat.pending).toEqual([second]);
		expect(giveUp(chat, second, "idle").returned).toEqual([]);
		applyLatest(chat, { messages: [reply("1"), user("2", "again"), reply("3")], more: false });
		expect(chat.pending).toEqual([second]);
		settle(chat, [{ id: second.id, outcome: "taken" }]);
		expect(chat.pending).toEqual([]);
	});

	it("show taken until the transcript has them", () => {
		const chat = reporting();
		const entry = send(chat, "go");
		settle(chat, [{ id: entry.id, outcome: "taken" }]);
		expect(chat.pending).toEqual([entry]);
		expect(entry.outcome).toBe("taken");
		applyLatest(chat, { messages: [reply("1"), user("2", "go")], more: false });
		expect(chat.pending).toEqual([]);
	});

	it("still fail at the give-up when no outcome came", () => {
		const chat = reporting();
		const entry = send(chat, "go");
		expect(settle(chat, [{ id: entry.id, outcome: "sent" }])).toEqual([]);
		expect(giveUp(chat, entry, "idle").returned).toEqual([notDelivered(entry)]);
	});

	it("wait on with no outcome while their row is silent, looked at again each give-up: the daemon says what became of them", () => {
		const chat = reporting();
		const entry = send(chat, "go", 100);
		expect(giveUp(chat, entry, "idle", { silent: true }).returned).toEqual([]);
		expect(entry.giveUpAt).toBe(100 + 2 * PROMPT_GIVE_UP_MS);
		arrive(chat, { status: null }, NOW);
		expect(giveUp(chat, entry, "idle", { silent: true }).returned).toEqual([]);
		expect(chat.pending).toEqual([entry]);
		arrive(chat, { status: REPORTING }, NOW);
		expect(giveUp(chat, entry, "idle").returned).toEqual([notDelivered(entry)]);
	});

	it("still fail at the give-up while the row of a pane from an older build is silent", () => {
		const chat = reporting();
		arrive(chat, { status: OLDER }, NOW);
		const entry = send(chat, "go");
		expect(giveUp(chat, entry, "idle", { silent: true }).returned).toEqual([notDelivered(entry)]);
	});

	it("come back, saying why, when their pane refused them or they were lost", () => {
		const chat = reporting();
		const refused = send(chat, "go", 100);
		const lost = send(chat, "go", 200);
		const kept = send(chat, "go", 300);
		expect(
			settle(chat, [
				{ id: refused.id, outcome: "refused", reason: "compacting" },
				{ id: lost.id, outcome: "lost", reason: "pane_gone" },
			]),
		).toEqual([
			{ entry: refused, reason: "compacting" },
			{ entry: lost, reason: "pane_gone" },
		]);
		expect(chat.pending).toEqual([kept]);
		expect(kept.sameTextBefore).toBe(0);
		expect(settle(chat, [{ id: refused.id, outcome: "refused", reason: "compacting" }])).toEqual([]);
	});

	it("come back once queued when pi dropped them from its queue", () => {
		const chat = reporting();
		const entry = send(chat, "go");
		expect(settle(chat, [{ id: entry.id, outcome: "queued" }])).toEqual([]);
		expect(settle(chat, [{ id: entry.id, outcome: "lost", reason: "dequeued" }])).toEqual([
			{ entry, reason: "dequeued" },
		]);
		expect(chat.pending).toEqual([]);
	});

	it("are done once taken when they are a slash command or a ! line, which the transcript may never show", () => {
		const chat = reporting();
		const command = send(chat, "/compact", 100);
		const shell = send(chat, "!ls", 200);
		const prompt = send(chat, "/tmp/a is gone", 300);
		settle(
			chat,
			[command, shell, prompt].map(({ id }) => ({ id, outcome: "taken" as const })),
		);
		expect(chat.pending).toEqual([prompt]);
	});

	it("ask the daemon about those their pane said nothing of, and come back by its answer: it restarted", () => {
		const chat = reporting();
		const daemon = new PromptDelivery();
		const sent = send(chat, "a", 100);
		const taken = send(chat, "b", 110);
		const queued = send(chat, "c", 120);
		const unaccepted = send(chat, "d", 130);
		for (const entry of [sent, taken, queued]) arrive(chat, { accepted: entry, lifetime: daemon.lifetime }, NOW);
		const { ask } = arrive(
			chat,
			{
				status: {
					models: [],
					outcomes: [
						{ id: taken.id, outcome: "taken" },
						{ id: queued.id, outcome: "queued" },
					],
				},
			},
			NOW,
		);
		expect(ask).toEqual([{ id: sent.id, lifetime: daemon.lifetime }]);
		const restarted = new PromptDelivery();
		expect(arrive(chat, { answer: restarted.answer("a", ask, true) }, NOW)).toEqual({
			returned: [{ entry: sent, reason: "daemon_restarted" }],
			ask: [],
			dropped: false,
		});
		expect(chat.pending).toEqual([taken, queued, unaccepted]);
		expect(arrive(chat, { status: REPORTING }, NOW).ask).toEqual([]);
	});

	it("are asked about after their pane's report and the daemon's replay only: its answer for one on its way never asks again", () => {
		const chat = reporting();
		const daemon = new PromptDelivery();
		const entry = send(chat, "go");
		daemon.queue("a", { type: "prompt", text: "go", id: entry.id });
		arrive(chat, { accepted: entry, lifetime: daemon.lifetime }, NOW);
		const waiting = [{ id: entry.id, lifetime: daemon.lifetime }];
		expect(arrive(chat, { status: REPORTING }, NOW).ask).toEqual(waiting);
		expect(arrive(chat, { replay: daemon.outcomes("a") }, NOW).ask).toEqual(waiting);
		const answer = daemon.answer("a", waiting, true);
		expect(answer).toEqual([{ id: entry.id, outcome: "sent" }]);
		expect(arrive(chat, { answer }, NOW)).toEqual({ returned: [], ask: [], dropped: false });
		expect(arrive(chat, { outcomes: answer }, NOW).ask).toEqual([]);
		expect(chat.pending).toEqual([entry]);
	});
});

describe("prompts pending when the app reloads or the chat is left, kept on the phone", () => {
	const reporting = () => {
		const chat = openChat("a");
		arrive(chat, { status: REPORTING }, NOW);
		chat.messages = [reply("1")];
		return chat;
	};
	const kept = (chat: Chat) => JSON.parse(JSON.stringify(storedPending(chat)));
	const told = (failed: ReturnType<typeof arrive>["returned"]) =>
		failed.map(({ entry, reason }) => [entry.prompt, reason]);
	const shown = (chat: Chat) => chat.pending.map((p) => [p.prompt, p.outcome]);

	it("are settled by id from the daemon's replay when the chat opens again, and put back when refused or lost", () => {
		const before = reporting();
		const refused = send(before, "refused", 100);
		const lost = send(before, "lost", 110);
		const queued = send(before, "queued", 120);
		const sent = send(before, "sent", 130);
		for (const entry of before.pending) arrive(before, { accepted: entry, lifetime: "lifetime-1" }, NOW);

		const chat = openChat("a", kept(before));
		expect(arrive(chat, { status: REPORTING }, NOW)).toEqual({ returned: [], ask: [], dropped: false });
		const next = arrive(
			chat,
			{
				replay: [
					{ id: refused.id, outcome: "refused", reason: "session_changed" },
					{ id: lost.id, outcome: "lost", reason: "pane_gone" },
					{ id: queued.id, outcome: "queued" },
					{ id: sent.id, outcome: "sent" },
				],
			},
			NOW,
		);
		expect(told(next.returned)).toEqual([
			["refused", "session_changed"],
			["lost", "pane_gone"],
		]);
		expect(shown(chat)).toEqual([
			["queued", "queued"],
			["sent", undefined],
		]);
		expect(next.ask).toEqual([{ id: sent.id, lifetime: "lifetime-1" }]);
	});

	it("have their give-up from when they are back in, as the page that sent them is gone", () => {
		const before = reporting();
		send(before, "sent", 100);
		const chat = openChat("a", kept(before));
		arrive(chat, { status: REPORTING }, 50_000);
		expect(nextGiveUp(chat)).toBeUndefined();
		arrive(chat, { replay: [] }, 60_000);
		expect(nextGiveUp(chat)).toBe(60_000 + PROMPT_GIVE_UP_MS);
	});

	it("are back in once both the daemon's replay and the pane's report are in, whichever comes first, and settled by id", () => {
		for (const reportFirst of [false, true]) {
			const before = openChat("a");
			const queued = send(before, "queued", 100);
			const refused = send(before, "refused", 110);
			const replay = [
				{ id: queued.id, outcome: "queued" as const },
				{ id: refused.id, outcome: "refused" as const, reason: "busy" as const },
			];

			const chat = openChat("a", kept(before));
			const first = arrive(chat, reportFirst ? { status: REPORTING } : { replay }, NOW);
			expect(first.returned).toEqual([]);
			expect(chat.pending).toEqual([]);
			const second = arrive(chat, reportFirst ? { replay } : { status: REPORTING }, NOW);
			expect(told(second.returned)).toEqual([["refused", "busy"]]);
			expect(shown(chat)).toEqual([["queued", "queued"]]);
			expect(storedPending(chat).map((p) => p.prompt)).toEqual(["queued"]);
		}
	});

	it("are discarded when the pane's report shows an older build, but those the replay says lost", () => {
		const before = openChat("a");
		const lost = send(before, "lost", 100);
		send(before, "sent", 110);

		const chat = openChat("a", kept(before));
		const typed = send(chat, "typed", 150);
		expect(arrive(chat, { replay: [{ id: lost.id, outcome: "lost", reason: "pane_gone" }] }, NOW).returned).toEqual(
			[],
		);
		expect(storedPending(chat).map((p) => p.prompt)).toEqual(["lost", "sent", "typed"]);
		expect(told(arrive(chat, { status: OLDER }, NOW).returned)).toEqual([["lost", "pane_gone"]]);
		expect(chat.pending).toEqual([typed]);
		expect(storedPending(chat)).toEqual([]);
	});

	it("are back in with no report yet, as before its pane's first one, and settled by id", () => {
		const before = openChat("a");
		const queued = send(before, "queued", 100);
		const refused = send(before, "refused", 110);
		const sent = send(before, "sent", 120);

		const chat = openChat("a", kept(before));
		arrive(chat, { status: null }, NOW);
		const { returned } = arrive(
			chat,
			{
				replay: [
					{ id: queued.id, outcome: "queued" },
					{ id: refused.id, outcome: "refused", reason: "busy" },
					{ id: sent.id, outcome: "sent" },
				],
			},
			NOW,
		);
		expect(told(returned)).toEqual([["refused", "busy"]]);
		expect(shown(chat)).toEqual([
			["queued", "queued"],
			["sent", undefined],
		]);
		expect(storedPending(chat).map((p) => p.prompt)).toEqual(["queued", "sent"]);
		arrive(chat, { status: { models: [], outcomes: [{ id: sent.id, outcome: "taken" }] } }, NOW);
		expect(shown(chat)).toEqual([
			["queued", "queued"],
			["sent", "taken"],
		]);
	});

	describe("for a pane that never reports, as one from an older build", () => {
		const reopened = () => {
			const before = openChat("a");
			arrive(before, { status: null }, NOW);
			before.messages = [reply("1")];
			const taken = send(before, "taken", 100);
			const unanswered = send(before, "unanswered", 110);
			expect(storedPending(before)).toEqual([taken, unanswered]);

			const chat = openChat("a", kept(before));
			arrive(chat, { status: null }, NOW);
			const replay = [taken, unanswered].map(({ id }) => ({ id, outcome: "sent" as const }));
			expect(arrive(chat, { replay }, NOW).returned).toEqual([]);
			applyLatest(chat, { messages: [reply("1")], more: false });
			return chat;
		};

		it("are kept, and matched by the transcript's text after a reload", () => {
			const chat = reopened();
			expect(shown(chat)).toEqual([
				["taken", undefined],
				["unanswered", undefined],
			]);
			applyLatest(chat, { messages: [reply("1"), user("2", "taken")], more: false });
			expect(shown(chat)).toEqual([["unanswered", undefined]]);
		});

		it("come back at their give-up when the transcript has none of them", () => {
			const chat = reopened();
			const next = arrive(chat, { time: { state: "idle" } }, NOW + PROMPT_GIVE_UP_MS);
			expect(told(next.returned)).toEqual([
				["taken", "not_delivered"],
				["unanswered", "not_delivered"],
			]);
			expect(chat.pending).toEqual([]);
		});
	});

	it("are put back when their pane quit, which leaves no report", () => {
		const before = reporting();
		const lost = send(before, "lost", 100);
		const refused = send(before, "refused", 110);

		const chat = openChat("a", kept(before));
		arrive(chat, { status: null }, NOW);
		const replay = [
			{ id: lost.id, outcome: "lost" as const, reason: "pane_gone" as const },
			{ id: refused.id, outcome: "refused" as const, reason: "session_changed" as const },
		];
		expect(told(arrive(chat, { replay }, NOW).returned)).toEqual([
			["lost", "pane_gone"],
			["refused", "session_changed"],
		]);
		expect(chat.pending).toEqual([]);
		expect(storedPending(chat)).toEqual([]);
	});

	it("are kept from the moment they are sent, with those kept before, and none for a pane whose report has no outcomes", () => {
		const before = openChat("a");
		send(before, "earlier", 50);
		const chat = openChat("a", kept(before));
		send(chat, "early", 100);
		expect(storedPending(chat).map((p) => p.prompt)).toEqual(["earlier", "early"]);
		arrive(chat, { status: REPORTING }, NOW);
		expect(storedPending(chat).map((p) => p.prompt)).toEqual(["earlier", "early"]);
		arrive(chat, { status: null }, NOW);
		expect(storedPending(chat).map((p) => p.prompt)).toEqual(["earlier", "early"]);
		arrive(chat, { status: OLDER }, NOW);
		expect(storedPending(chat).map((p) => p.prompt)).toEqual(["earlier"]);
	});
});

describe("prompts sent to a pane from an older build, which reports no outcomes", () => {
	it("are matched by the transcript's text, as before", () => {
		const chat = openChat("a");
		for (const report of [null, OLDER]) {
			arrive(chat, { status: report }, NOW);
			chat.messages = [reply("1")];
			const entry = send(chat, "hi");
			arrive(chat, { outcomes: undefined }, NOW);
			applyLatest(chat, { messages: [reply("1")], more: false });
			expect(chat.pending).toEqual([entry]);
			applyLatest(chat, { messages: [reply("1"), user("2", "hi")], more: false });
			expect(chat.pending).toEqual([]);
		}
	});
});

it.each(["compact", "reload", "new"])("settles /%s on taken even when the draft includes selected skills", (name) => {
	const chat = openChat("a");
	const skillDraft = {
		text: `/${name} [Skill #1: review]`,
		selections: [
			{
				start: name.length + 2,
				marker: "[Skill #1: review]",
				command: {
					name: "skill:review",
					source: "skill" as const,
					skill: {
						id: "a".repeat(64),
						scope: "project",
						path: "/fixture/SKILL.md",
						origin: "local",
						source: "local",
					},
				},
			},
		],
	};
	const entry = promptSent(chat, `/${name} /skill:review`, [], skillDraft, 100);
	arrive(chat, { outcomes: [{ id: entry.id, outcome: "taken" }] }, NOW);
	expect(chat.pending).toEqual([]);
});
