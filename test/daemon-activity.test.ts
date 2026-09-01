import { describe, expect, it } from "vitest";
import { type ActivityState, INITIAL_ACTIVITY, isBlockingUiMethod, reduceActivity } from "../daemon/activity.ts";

describe("isBlockingUiMethod", () => {
	it("treats select/confirm/input/editor as blocking", () => {
		for (const method of ["select", "confirm", "input", "editor"]) {
			expect(isBlockingUiMethod(method)).toBe(true);
		}
	});

	it("treats notify/setStatus/setWidget/setTitle/set_editor_text as non-blocking", () => {
		for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
			expect(isBlockingUiMethod(method)).toBe(false);
		}
	});
});

describe("reduceActivity", () => {
	const working: ActivityState = { activity: "working" };

	it("initial state is idle", () => {
		expect(INITIAL_ACTIVITY).toEqual({ activity: "idle" });
	});

	it("agent_start -> working", () => {
		expect(reduceActivity(INITIAL_ACTIVITY, { kind: "agent_event", type: "agent_start" })).toEqual({
			activity: "working",
		});
	});

	it("turn_start -> working", () => {
		expect(reduceActivity(INITIAL_ACTIVITY, { kind: "agent_event", type: "turn_start" })).toEqual({
			activity: "working",
		});
	});

	it("agent_settled -> idle", () => {
		expect(reduceActivity(working, { kind: "agent_event", type: "agent_settled" })).toEqual({ activity: "idle" });
	});

	it("agent_end does NOT go idle (a retry may follow) — stays working", () => {
		expect(reduceActivity(working, { kind: "agent_event", type: "agent_end" })).toEqual({ activity: "working" });
	});

	it("non-activity events leave state unchanged", () => {
		for (const type of ["message_start", "message_update", "message_end", "entry_appended", "turn_end"]) {
			expect(reduceActivity(working, { kind: "agent_event", type })).toEqual(working);
		}
	});

	it("blocking ui_request -> awaiting_input with pending id", () => {
		expect(reduceActivity(working, { kind: "ui_request", method: "confirm", id: "u1" })).toEqual({
			activity: "awaiting_input",
			pendingUiRequestId: "u1",
		});
	});

	it("non-blocking ui_request while working -> unchanged", () => {
		expect(reduceActivity(working, { kind: "ui_request", method: "notify", id: "n1" })).toEqual(working);
	});

	it("matching ui_response clears awaiting_input -> working", () => {
		const waiting: ActivityState = { activity: "awaiting_input", pendingUiRequestId: "u1" };
		expect(reduceActivity(waiting, { kind: "ui_response", id: "u1" })).toEqual({ activity: "working" });
	});

	it("non-matching ui_response leaves awaiting_input unchanged", () => {
		const waiting: ActivityState = { activity: "awaiting_input", pendingUiRequestId: "u1" };
		expect(reduceActivity(waiting, { kind: "ui_response", id: "other" })).toEqual(waiting);
	});

	it("awaiting_input self-clears on next agent_start", () => {
		const waiting: ActivityState = { activity: "awaiting_input", pendingUiRequestId: "u1" };
		expect(reduceActivity(waiting, { kind: "agent_event", type: "agent_start" })).toEqual({ activity: "working" });
	});

	it("realistic run: idle -> working -> (message) -> settled -> idle", () => {
		let state = INITIAL_ACTIVITY;
		state = reduceActivity(state, { kind: "agent_event", type: "agent_start" });
		expect(state.activity).toBe("working");
		state = reduceActivity(state, { kind: "agent_event", type: "message_start" });
		expect(state.activity).toBe("working");
		state = reduceActivity(state, { kind: "agent_event", type: "agent_settled" });
		expect(state.activity).toBe("idle");
	});
});
