/**
 * Agent activity model for orchestrator-supervised instances.
 *
 * Distinct from InstanceStatus (process lifecycle). Activity describes what the agent
 * inside a live instance is doing right now, derived from its event stream and blocking
 * UI requests. This is a pure module — no process/socket/coding-agent runtime deps — so it
 * is fully unit-testable. See docs/superpowers/specs/2026-07-12-fleetview-phase0-design.md §4.2.
 */

export type AgentActivity = "idle" | "working" | "awaiting_input";

export interface ActivityState {
	activity: AgentActivity;
	/** id of the blocking UI request we're waiting on, when activity === "awaiting_input". */
	pendingUiRequestId?: string;
}

export const INITIAL_ACTIVITY: ActivityState = { activity: "idle" };

/**
 * Blocking dialog methods that pause the agent until the human answers.
 * Verified against the RpcExtensionUIRequest union (coding-agent modes/rpc/rpc-types.ts:230-265):
 * select/confirm/input/editor block; notify/setStatus/setWidget/setTitle/set_editor_text are
 * fire-and-forget and must NOT flip activity.
 */
const BLOCKING_UI_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

export function isBlockingUiMethod(method: string): boolean {
	return BLOCKING_UI_METHODS.has(method);
}

export type ActivitySignal =
	| { kind: "agent_event"; type: string }
	| { kind: "ui_request"; method: string; id: string }
	| { kind: "ui_response"; id: string };

/**
 * Pure reducer: current state + signal -> next state.
 *
 * - agent_start / turn_start -> working
 * - agent_settled -> idle (NOT agent_end: a run can retry after agent_end)
 * - blocking ui_request -> awaiting_input (remembers the request id)
 * - matching ui_response -> working (run resumes)
 * - anything else -> unchanged
 */
export function reduceActivity(state: ActivityState, signal: ActivitySignal): ActivityState {
	switch (signal.kind) {
		case "agent_event":
			if (signal.type === "agent_start" || signal.type === "turn_start") {
				return { activity: "working" };
			}
			if (signal.type === "agent_settled") {
				return { activity: "idle" };
			}
			return state;
		case "ui_request":
			if (isBlockingUiMethod(signal.method)) {
				return { activity: "awaiting_input", pendingUiRequestId: signal.id };
			}
			return state;
		case "ui_response":
			if (state.activity === "awaiting_input" && state.pendingUiRequestId === signal.id) {
				return { activity: "working" };
			}
			return state;
	}
}
