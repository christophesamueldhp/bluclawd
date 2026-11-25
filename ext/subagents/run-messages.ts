import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InstanceSummary, SessionMessage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import {
	NOT_APPROVAL,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	SUBAGENT_MESSAGE_TOOL,
} from "./messages.ts";

export function runMessageText(message: Extract<SessionMessage, { text: string }>, parent: string): string {
	const lead =
		message.from === parent
			? `[Message from your orchestrator, from another session, not from the user. Follow it as a course correction. ${NOT_APPROVAL}]`
			: `[Message from sibling run "${message.name ?? message.from}", from another session, not from the user: information or a request; weigh it against your own task. ${NOT_APPROVAL}]`;
	return `${lead}\n\n${message.text}`;
}

export function fromRun(pi: Pick<ExtensionAPI, "getSessionName">, pane: string) {
	return { type: "session_message" as const, from: pane, name: pi.getSessionName() };
}

export interface RunSelf {
	pane: string;
	parent: string;
	name?: string;
}

type Row = Pick<InstanceSummary, "pane" | "label" | "parent">;

const siblingsOf = (rows: readonly Row[], self: RunSelf) =>
	rows.filter((row) => row.parent === self.parent && row.pane && row.pane !== self.pane);

export function runRoster(rows: readonly Row[], self: RunSelf): string[] {
	return [PARENT_MESSAGE_ADDRESS, ...siblingsOf(rows, self).flatMap((row) => (row.label ? [row.label] : []))];
}

export function messageTarget(
	rows: readonly Row[],
	self: RunSelf,
	to: string,
): { pane: string; name: string } | { refused: string } {
	if (to === PARENT_MESSAGE_ADDRESS) return { pane: self.parent, name: "your orchestrator" };
	if (to === self.name) return { refused: "A run cannot message itself." };
	const sibling = siblingsOf(rows, self).find((row) => row.label === to);
	if (sibling?.pane) return { pane: sibling.pane, name: `"${to}"` };
	if (rows.some((row) => row.label === to && row.parent && row.parent !== self.parent)) {
		return {
			refused: `"${to}" is a run of another orchestrator; you can message only your orchestrator ("parent") and its runs.`,
		};
	}
	return {
		refused: `No run "${to}" among your orchestrator's runs. Reachable now: ${runRoster(rows, self).join(", ")}.`,
	};
}

export function messageAsRun(pi: ExtensionAPI, parent: () => string, pane: string, closed: () => boolean): void {
	pi.events.on("bluclawd:session-message", (data) => {
		const message = data as SessionMessage;
		if (message.kind !== "message" || closed()) return;
		pi.sendMessage(
			{
				customType: SUBAGENT_MESSAGE_CUSTOM_TYPE,
				content: [{ type: "text", text: runMessageText(message, parent()) }],
				display: true,
				details: message,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	});

	pi.on("input", (event) => {
		if (event.source === "interactive") {
			const note: SessionMessage = {
				...fromRun(pi, pane),
				kind: "typed",
				text: event.text,
			};
			void new OrchestratorClient().send(parent(), note).catch(() => {});
		}
		return { action: "continue" };
	});

	pi.registerTool({
		name: SUBAGENT_MESSAGE_TOOL,
		label: "Message agent",
		exposure: "model-only",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description:
			'Send a message to your orchestrator ("parent") or a sibling run by name. It reaches their session as a message from another session, and an idle one takes a turn on it. A name no run of your orchestrator has is refused with the names you can reach. Delivery is not a reply; keep working.',
		parameters: Type.Object(
			{
				to: Type.String({ description: 'Recipient: a sibling run\'s name, or "parent" for your orchestrator.' }),
				content: Type.String({ description: "Message text." }),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const sender = fromRun(pi, pane);
			const client = new OrchestratorClient();
			const target = messageTarget(
				await client.list(),
				{ pane, parent: parent(), name: sender.name },
				params.to.trim(),
			);
			if ("refused" in target) {
				return {
					content: [{ type: "text", text: `Message not sent: ${target.refused}` }],
					details: undefined,
					isError: true,
				};
			}
			await client.send(target.pane, {
				...sender,
				kind: "message",
				text: params.content,
			});
			return {
				content: [{ type: "text", text: `Message sent to ${target.name} (not yet handled).` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "subagent_roster",
		label: "Subagent roster",
		exposure: "model-only",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		description:
			'List who you can message with subagent_message: your orchestrator ("parent") and its other open runs, by name.',
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const names = runRoster(await new OrchestratorClient().list(), {
				pane,
				parent: parent(),
				name: pi.getSessionName(),
			});
			const text = names.map((name) => (name === PARENT_MESSAGE_ADDRESS ? `${name} (your orchestrator)` : name));
			return { content: [{ type: "text", text: `You can message: ${text.join(", ")}.` }], details: undefined };
		},
	});
}
