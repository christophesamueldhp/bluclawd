import { type AssistantMessage, parseStreamingJson } from "@earendil-works/pi-ai";
import { type HistoryPage, VIEW_MESSAGE_LIMIT, type ViewInput, type ViewProjection } from "./view-types.ts";
export function createViewProjection(history?: HistoryPage): ViewProjection {
	return {
		messages: history?.messages.slice(-VIEW_MESSAGE_LIMIT) ?? [],
		tools: {},
		activity: "idle",
		running: false,
		compacting: false,
		queues: { steering: [], followUp: [] },
		statuses: {},
		widgets: {},
		historyBefore: history?.before,
		errors: [],
	};
}
export function reduceViewProjection(state: ViewProjection, event: ViewInput, key: string): ViewProjection {
	const s = { ...state, tools: { ...state.tools }, statuses: { ...state.statuses }, widgets: { ...state.widgets } };
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			s.running = true;
			break;
		case "agent_settled":
			s.running = false;
			s.pendingDialog = undefined;
			break;
		case "message_start":
			if (event.message.role === "assistant") {
				s.partial = structuredClone(event.message);
				s.toolArguments = {};
			}
			break;
		case "message_update": {
			if (s.partial?.role !== "assistant") break;
			const p = structuredClone(s.partial) as AssistantMessage;
			p.usage = event.usage;
			const e = event.assistantMessageEvent;
			if ("contentIndex" in e) {
				const i = e.contentIndex;
				if (e.type === "text_start" || e.type === "text_delta" || e.type === "text_end") {
					const old = p.content[i];
					const text = old?.type === "text" ? old.text : "";
					p.content[i] = {
						type: "text",
						text: e.type === "text_delta" ? text + e.delta : e.type === "text_end" ? e.content : text,
					};
				} else if (e.type === "thinking_start" || e.type === "thinking_delta" || e.type === "thinking_end") {
					const old = p.content[i];
					const thinking = old?.type === "thinking" ? old.thinking : "";
					p.content[i] = {
						type: "thinking",
						thinking:
							e.type === "thinking_delta"
								? thinking + e.delta
								: e.type === "thinking_end"
									? e.content
									: thinking,
					};
				} else if (e.type === "toolcall_start")
					p.content[i] = { type: "toolCall", id: e.id, name: e.toolName, arguments: {} };
				else if (e.type === "toolcall_delta") {
					const raw = (s.toolArguments?.[i] ?? "") + e.delta;
					s.toolArguments = { ...s.toolArguments, [i]: raw };
					const call = p.content[i];
					if (call?.type === "toolCall") call.arguments = parseStreamingJson(raw);
				} else if (e.type === "toolcall_end") p.content[i] = structuredClone(e.toolCall);
			}
			s.partial = p;
			break;
		}
		case "message_end":
			if (event.message.role === "assistant") {
				s.partial = undefined;
				s.toolArguments = undefined;
			}
			s.messages = [...s.messages, { key, message: structuredClone(event.message) }].slice(-VIEW_MESSAGE_LIMIT);
			if (state.messages.length >= VIEW_MESSAGE_LIMIT) s.historyBefore = s.messages[0].entryId ?? s.historyBefore;
			break;
		case "tool_execution_start":
			s.tools[event.toolCallId] = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: structuredClone(event.args),
				...("parentToolCallId" in event ? { parentToolCallId: event.parentToolCallId as string } : {}),
			};
			break;
		case "tool_execution_update":
			if (s.tools[event.toolCallId])
				s.tools[event.toolCallId] = {
					...s.tools[event.toolCallId],
					partialResult: structuredClone(event.partialResult),
				};
			break;
		case "tool_execution_end":
			delete s.tools[event.toolCallId];
			break;
		case "queue_update":
			s.queues = { steering: [...event.steering], followUp: [...event.followUp] };
			break;
		case "compaction_start":
			s.compacting = true;
			break;
		case "compaction_end":
			s.compacting = false;
			if (event.result && !event.aborted)
				s.messages = [
					...s.messages,
					{
						key,
						message: {
							role: "compactionSummary" as const,
							summary: event.result.summary,
							tokensBefore: event.result.tokensBefore,
							timestamp: Date.now(),
						},
					},
				].slice(-VIEW_MESSAGE_LIMIT);
			break;
		case "view_error":
			s.errors = [...s.errors, event.message].slice(-10);
			break;
		case "view_ui_resolved":
			if (s.pendingDialog?.id === event.requestId) s.pendingDialog = undefined;
			break;
		case "extension_ui_request": {
			switch (event.method) {
				case "select":
				case "confirm":
				case "input":
				case "editor":
					s.pendingDialog = structuredClone(event);
					break;
				case "setStatus":
					if (event.statusText === undefined) delete s.statuses[event.statusKey];
					else s.statuses[event.statusKey] = event.statusText;
					break;
				case "setWidget":
					if (event.widgetLines === undefined) delete s.widgets[event.widgetKey];
					else
						s.widgets[event.widgetKey] = {
							lines: structuredClone(event.widgetLines),
							placement: event.widgetPlacement ?? "aboveEditor",
						};
					break;
				case "setTitle":
					s.title = event.title;
					break;
				case "set_editor_text":
					s.editorText = event.text;
					break;
				case "notify":
					s.errors = [...s.errors, event.message].slice(-10);
					break;
			}
			break;
		}
	}
	s.activity = s.pendingDialog ? "awaiting_input" : s.running || s.compacting ? "working" : "idle";
	return s;
}
