import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { commandsRun } from "../ext/subagents/run-evidence.ts";

/** A bash call its pi made at minute `minute`, and its result. */
const ran = (minute: number, command: string): SessionEntry[] => {
	const timestamp = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
	const id = `call-${minute}`;
	return [
		{
			type: "message",
			timestamp,
			message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
		},
		{ type: "message", timestamp, message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: false } },
	] as unknown as SessionEntry[];
};
const minute = (n: number) => Date.UTC(2026, 0, 1, 0, n);

describe("the commands a run's transcript shows it ran", () => {
	const entries = [...ran(5, "first"), ...ran(20, "second"), ...ran(40, "third")];

	it("are those from a time on", () => {
		expect(commandsRun(entries, minute(10)).map(({ command }) => command)).toEqual(["second", "third"]);
	});

	it("are those of one Generation, from its admission until the next one's", () => {
		expect(commandsRun(entries, minute(0), minute(20)).map(({ command }) => command)).toEqual(["first"]);
		expect(commandsRun(entries, minute(20), minute(40)).map(({ command }) => command)).toEqual(["second"]);
	});
});
