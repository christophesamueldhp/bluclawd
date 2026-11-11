import { describe, expect, it } from "vitest";
import { Collaborations, type LiveSession } from "../daemon/collaborations.ts";
import type { SessionMessage } from "../daemon/ipc/protocol.ts";

/** The daemon's collaborations over panes `live`, recording what it queues for each pane. */
function collaborations(live: LiveSession[]) {
	const queued: Array<{ instanceId: string; message: SessionMessage }> = [];
	const held = new Collaborations({
		sessions: () => live,
		deliver: async (instanceId, message) => {
			queued.push({ instanceId, message });
			return true;
		},
	});
	return { held, queued };
}

const pane = (name: string, sessionId = `s-${name}`): LiveSession => ({
	instanceId: `pane-${name}`,
	sessionId,
	label: name,
	pane: `pane-${name}`,
});

describe("the daemon's collaborations", () => {
	it("no longer vouches for a message queued before the user changed the scope", async () => {
		const { held, queued } = collaborations([pane("alpha"), pane("beta")]);
		await held.open({ sessionId: "s-alpha", name: "alpha" }, ["beta"], "Fix the parser");
		await held.send("s-alpha", 1, "beta", "finding", "It drops a token.");
		const sent = queued.at(-1)?.message as Extract<SessionMessage, { kind: "collaborator_message" }>;
		expect(held.current(sent.collaboration, sent.revision, "s-beta")).toBe(true);

		await held.rescope("s-beta", "Review the README only");
		expect(held.current(sent.collaboration, sent.revision, "s-beta")).toBe(false);
		// alpha is told of the change; beta changed it itself.
		expect(queued.at(-1)).toMatchObject({
			instanceId: "pane-alpha",
			message: { kind: "collaboration", to: "s-alpha", collaboration: { revision: 2 } },
		});
	});

	it("opens none when a named session is ambiguous or unknown, and lets a member reach no one else", async () => {
		const { held } = collaborations([pane("alpha"), pane("beta"), pane("twin", "s-1"), pane("twin", "s-2")]);
		await expect(held.open({ sessionId: "s-alpha", name: "alpha" }, ["beta", "twin"], "Work")).rejects.toThrow(
			'"twin" names 2 open sessions',
		);
		await expect(held.open({ sessionId: "s-alpha", name: "alpha" }, ["beta", "nobody"], "Work")).rejects.toThrow(
			'No open session is named "nobody".',
		);
		expect(held.of("s-beta")).toBeUndefined();

		await held.open({ sessionId: "s-alpha", name: "alpha" }, ["beta"], "Work");
		await expect(held.send("s-alpha", 1, "twin", "finding", "Hi.")).rejects.toThrow(
			'no session "twin" is in this collaboration',
		);
		await expect(held.send("s-twin", 1, "alpha", "finding", "Hi.")).rejects.toThrow("is in no collaboration");
	});

	it("reaches a member only in its own session: a pane that moved to another session is not it", async () => {
		const live = [pane("alpha"), pane("beta")];
		const { held } = collaborations(live);
		await held.open({ sessionId: "s-alpha", name: "alpha" }, ["beta"], "Work");
		live[1] = pane("beta", "s-beta-new");
		await expect(held.send("s-alpha", 1, "beta", "finding", "Hi.")).rejects.toThrow(
			'"beta" is not open in any pane now.',
		);
		expect(held.of("s-beta-new")).toBeUndefined();

		await held.end("s-alpha");
		expect(held.of("s-alpha")).toBeUndefined();
		await expect(held.send("s-alpha", 1, "beta", "finding", "Hi.")).rejects.toThrow("is in no collaboration");
	});

	it("keeps the others linked when a member leaves, and ends with the last but one", async () => {
		const { held, queued } = collaborations([pane("alpha"), pane("beta"), pane("gamma")]);
		await held.open({ sessionId: "s-alpha", name: "alpha" }, ["beta", "gamma"], "Work");
		await held.leave("s-gamma");
		expect(held.of("s-gamma")).toBeUndefined();
		expect(held.of("s-alpha")?.members.map((m) => m.name)).toEqual(["alpha", "beta"]);
		await expect(held.send("s-alpha", 1, "gamma", "finding", "Hi.")).rejects.toThrow('no session "gamma"');

		queued.length = 0;
		await held.leave("s-beta");
		expect(held.of("s-alpha")).toBeUndefined();
		expect(queued).toEqual([
			{
				instanceId: "pane-alpha",
				message: { type: "session_message", from: "beta", kind: "collaboration", to: "s-alpha" },
			},
		]);
	});
});
