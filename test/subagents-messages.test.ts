import { describe, expect, it } from "vitest";
import { type SubagentMessage, SubagentMessageBus, type SubagentMessageRecord } from "../ext/subagents/messages.ts";

const scope = { parentSessionId: "sess_1", runtimeGeneration: 1 };

describe("Ticket #13 — Subagent message routing", () => {
	it("gives concurrent senders their bound identities and one ordering", async () => {
		const records: SubagentMessageRecord[] = [];
		const bus = new SubagentMessageBus((record) => records.push(record));
		const received: SubagentMessage[] = [];
		bus.register("parent", { scope, deliver: async (message) => void received.push(message) });

		const receipts = await Promise.all(
			["sub_a", "sub_b", "sub_c", "sub_a"].map((from, i) => bus.send({ address: from, scope }, "parent", `m${i}`)),
		);

		expect(receipts.map((r) => [r.status, r.seq])).toEqual([
			["accepted", 1],
			["accepted", 2],
			["accepted", 3],
			["accepted", 4],
		]);
		expect(received.map((m) => [m.seq, m.from, m.content])).toEqual([
			[1, "sub_a", "m0"],
			[2, "sub_b", "m1"],
			[3, "sub_c", "m2"],
			[4, "sub_a", "m3"],
		]);
		expect(records.map((record) => [record.seq, record.from, record.to, record.status])).toEqual([
			[1, "sub_a", "parent", "accepted"],
			[2, "sub_b", "parent", "accepted"],
			[3, "sub_c", "parent", "accepted"],
			[4, "sub_a", "parent", "accepted"],
		]);
	});

	it("returns explicit outcomes for foreign-scope, invalidated, disposed, finished and unknown recipients", async () => {
		const bus = new SubagentMessageBus();
		const deliver = async () => {};
		bus.register("sub_foreign", { scope: { parentSessionId: "sess_2", runtimeGeneration: 1 }, deliver });
		bus.register("sub_stale", { scope: { parentSessionId: "sess_1", runtimeGeneration: 0 }, deliver });
		bus.register("sub_disposed", {
			scope,
			deliver: async () => {
				throw new Error("session disposed");
			},
		});
		bus.register("sub_done", { scope, deliver });
		bus.unregister("sub_done", "has finished");
		const send = (to: string) => bus.send({ address: "parent", scope }, to, "hello");

		expect(await send("sub_foreign")).toMatchObject({ status: "unavailable", reason: /different parent session/ });
		expect(await send("sub_stale")).toMatchObject({ status: "invalidated", reason: /reloaded or replaced/ });
		expect(await send("sub_disposed")).toMatchObject({ status: "unavailable", reason: /session disposed/ });
		expect(await send("sub_done")).toMatchObject({ status: "unavailable", reason: '"sub_done" has finished.' });
		bus.register("sub_sibling", { scope, deliver });
		expect(await send("sub_unknown")).toMatchObject({
			status: "unavailable",
			reason: /No running agent "sub_unknown" is reachable\. Reachable now: sub_disposed, sub_sibling\./,
		});
		expect(await send("parent")).toMatchObject({ status: "unavailable", reason: /cannot message itself/ });
	});
});
