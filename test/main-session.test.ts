import { describe, expect, it } from "vitest";
import { clearMainSession, mainSession, setMainSession } from "../ext/_shared/main-session.ts";

describe("main session sink (background jobs outlive a session switch)", () => {
	it("sends to the current main session, and holds what arrives between sessions for the next", () => {
		const first: string[] = [];
		const second: string[] = [];
		const sink = (into: string[]) => ({
			sendMessage: (m: { content: string }) => into.push(m.content),
			appendEntry: (type: string) => into.push(`entry:${type}`),
		});
		setMainSession(sink(first) as never);
		mainSession.sendMessage({ content: "a" } as never, { deliverAs: "steer", triggerTurn: true });
		clearMainSession();
		mainSession.sendMessage({ content: "b" } as never, { deliverAs: "steer", triggerTurn: true });
		mainSession.appendEntry("end", {});
		expect(first).toEqual(["a"]);
		setMainSession(sink(second) as never);
		expect(second).toEqual(["b", "entry:end"]);
	});
});
