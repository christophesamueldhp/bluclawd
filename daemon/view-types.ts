import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcResponse,
	RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import type { ErrorResponse, InstanceSummary } from "./ipc/protocol.ts";
export const VIEW_PROTOCOL_VERSION = 1;
export const VIEW_MESSAGE_LIMIT = 200;
export const VIEW_HISTORY_LIMIT = 200;
export type DisplayMessage = Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"];
export interface ViewMessage {
	key: string;
	entryId?: string;
	message: DisplayMessage;
}
export interface ViewTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult?: unknown;
	parentToolCallId?: string;
}
export interface ViewProjection {
	messages: ViewMessage[];
	partial?: AssistantMessage;
	toolArguments?: Record<number, string>;
	tools: Record<string, ViewTool>;
	activity: "idle" | "working" | "awaiting_input";
	running: boolean;
	compacting: boolean;
	queues: { steering: unknown[]; followUp: unknown[] };
	pendingDialog?: RpcExtensionUIRequest;
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	title?: string;
	editorText?: string;
	historyBefore?: string;
	errors: string[];
}
export type ViewInput =
	| JsonAgentSessionEvent
	| RpcExtensionUIRequest
	| { type: "view_ui_resolved"; requestId: string }
	| { type: "view_error"; message: string };
export interface ViewReady {
	type: "view_ready";
	ok: true;
	viewProtocol: 1;
	instance: InstanceSummary;
	generation: string;
	sequence: number;
	projection: ViewProjection;
	state: RpcSessionState;
}
export interface ViewEvent {
	type: "view_event";
	generation: string;
	sequence: number;
	event: ViewInput;
}
export interface ViewTerminal {
	type: "view_terminal";
	instanceId: string;
	generation: string;
	sequence: number;
	reason: "stopped" | "deleted" | "failed";
	error?: string;
}
export type ViewRecord = ViewReady | ViewEvent | ViewTerminal | RpcResponse | ErrorResponse;
export interface HistoryPage {
	messages: ViewMessage[];
	before?: string;
}
export type SessionTarget =
	| { instanceId: string }
	| { sessionFile: string; cwd: string; model?: { provider: string; id: string } };
export interface ManagedDraft {
	text: string;
	images: ImageContent[];
}
export type ViewCommand = RpcCommand;
