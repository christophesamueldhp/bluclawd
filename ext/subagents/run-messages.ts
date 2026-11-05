/**
 * Messages between sessions, inside a run (ADR-0006): what its orchestrator or a sibling sends arrives through the
 * daemon as a message from another session, and the run's own subagent_message reaches them the same way. What
 * the user types in the run goes to the orchestrator as a note (ADR-0005).
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InstanceSummary, SessionMessage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import {
	NOT_APPROVAL,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	SUBAGENT_MESSAGE_TOOL,
} from "./messages.ts";

/** A message to the run as its model reads it: from another session, never the user. */
export function runMessageText(message: SessionMessage, parent: string): string {
	const lead =
		message.from === parent
			? `[Message from your orchestrator, from another session, not from the user. Follow it as a course correction. ${NOT_APPROVAL}]`
			: `[Message from sibling run "${message.name ?? message.from}", from another session, not from the user: information or a request; weigh it against your own task. ${NOT_APPROVAL}]`;
	return `${lead}\n\n${message.text}`;
}

/** The run sending, as the daemon lists it. */
export interface RunSelf {
	pane: string;
	/** Its orchestrator's tmux session. */
	parent: string;
	name?: string;
}

/**
 * Where a run's message to `to` goes, from the daemon's rows: its orchestrator ("parent") or a sibling of the same
 * orchestrator by name; otherwise why it is refused.
 */
export function messageTarget(
	rows: readonly Pick<InstanceSummary, "pane" | "label" | "parent">[],
	self: RunSelf,
	to: string,
): { pane: string; name: string } | { refused: string } {
	if (to === PARENT_MESSAGE_ADDRESS) return { pane: self.parent, name: "your orchestrator" };
	if (to === self.name) return { refused: "A run cannot message itself." };
	const siblings = rows.filter((row) => row.parent === self.parent && row.pane && row.pane !== self.pane);
	const sibling = siblings.find((row) => row.label === to);
	if (sibling?.pane) return { pane: sibling.pane, name: `"${to}"` };
	if (rows.some((row) => row.label === to && row.parent && row.parent !== self.parent)) {
		return {
			refused: `"${to}" is a run of another orchestrator; you can message only your orchestrator ("parent") and its runs.`,
		};
	}
	const reachable = [PARENT_MESSAGE_ADDRESS, ...siblings.flatMap((row) => (row.label ? [row.label] : []))];
	return { refused: `No run "${to}" among your orchestrator's runs. Reachable now: ${reachable.join(", ")}.` };
}

/** A run's side of messaging: its subagent_message, what it receives, and the notes of what the user types in it. */
export function messageAsRun(pi: ExtensionAPI, parent: string, pane: string): void {
	pi.events.on("bluclawd:session-message", (data) => {
		const message = data as SessionMessage;
		if (message.kind !== "message") return;
		// An idle run takes a turn on it; a busy one reads it at its next step.
		pi.sendMessage(
			{
				customType: SUBAGENT_MESSAGE_CUSTOM_TYPE,
				content: [{ type: "text", text: runMessageText(message, parent) }],
				display: true,
				details: message,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	});

	pi.on("input", (event) => {
		if (event.source === "interactive") {
			const note: SessionMessage = {
				type: "session_message",
				kind: "typed",
				from: pane,
				name: pi.getSessionName(),
				text: event.text,
			};
			// The orchestrator only reads it; the run's answer reaches it as a Report.
			void new OrchestratorClient().send(parent, note).catch(() => {});
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
			const name = pi.getSessionName();
			const client = new OrchestratorClient();
			const target = messageTarget(await client.list(), { pane, parent, name }, params.to.trim());
			if ("refused" in target) {
				return {
					content: [{ type: "text", text: `Message not sent: ${target.refused}` }],
					details: undefined,
					isError: true,
				};
			}
			await client.send(target.pane, {
				type: "session_message",
				kind: "message",
				from: pane,
				name,
				text: params.content,
			});
			return {
				content: [{ type: "text", text: `Message sent to ${target.name} (not yet handled).` }],
				details: undefined,
			};
		},
	});
}
