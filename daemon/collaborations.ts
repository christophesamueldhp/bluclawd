/**
 * Collaborations between independent orchestrator sessions (ADR-0010): only the user opens one, naming its sessions
 * and the work it is for, and the daemon holds it, as the one place every session reaches. A session is in one at
 * most. Members exchange findings, questions and blockers through it; no one else is reached, and nothing a member
 * sends adds a member or changes the work. A scope change makes what was sent before it stale. Kept in memory only:
 * a daemon restart ends every collaboration, and the user opens it again.
 */

import { randomUUID } from "node:crypto";
import type { SessionMessage } from "./ipc/protocol.ts";

export type CollaboratorMessageKind = "finding" | "question" | "blocker";

export interface CollaborationMember {
	sessionId: string;
	/** Its name as the user named it when the collaboration opened. */
	name: string;
}

/** A collaboration as its members are told of it. `revision` counts the user's changes of its scope. */
export interface Collaboration {
	id: string;
	revision: number;
	scope: string;
	members: CollaborationMember[];
}

/** A session open in a pane now, as the daemon's rows list it. */
export interface LiveSession {
	instanceId: string;
	sessionId: string;
	label?: string;
	pane?: string;
}

export interface CollaborationsDeps {
	/** The sessions of orchestrators open in panes now: never a run's. */
	sessions(): LiveSession[];
	/** Queues `message` for the pane `instanceId`; false when it is gone. */
	deliver(instanceId: string, message: SessionMessage): Promise<boolean>;
}

const MAX_SCOPE = 2000;
const MAX_TEXT = 32 * 1024;

export class Collaborations {
	private readonly bySession = new Map<string, Collaboration>();
	private readonly deps: CollaborationsDeps;

	constructor(deps: CollaborationsDeps) {
		this.deps = deps;
	}

	/** The collaboration session `sessionId` is in, if any. */
	of(sessionId: string): Collaboration | undefined {
		return this.bySession.get(sessionId);
	}

	/**
	 * Opens a collaboration of session `opener` with the sessions `names` name, each by its name, pane or session id,
	 * for `scope`; throws why it cannot, opening none. Every other member is told.
	 */
	async open(opener: CollaborationMember, names: string[], scope: string): Promise<Collaboration> {
		const work = checkScope(scope);
		if (this.bySession.has(opener.sessionId))
			throw new Error("This session is in a collaboration already: end it first.");
		const live = this.deps.sessions();
		// Named as its row is, which the other members' users see in agent view.
		const self = live.find((s) => s.sessionId === opener.sessionId);
		const members: CollaborationMember[] = [{ sessionId: opener.sessionId, name: self?.label ?? opener.name }];
		for (const name of names) {
			const matches = live.filter((s) => s.label === name || s.pane === name || s.sessionId === name);
			if (matches.length === 0) throw new Error(`No open session is named "${name}".`);
			if (matches.length > 1)
				throw new Error(`"${name}" names ${matches.length} open sessions: name one by its session id.`);
			const [session] = matches;
			if (session.sessionId === opener.sessionId) throw new Error(`"${name}" is this session.`);
			if (members.some((m) => m.sessionId === session.sessionId)) continue;
			if (this.bySession.has(session.sessionId)) throw new Error(`"${name}" is in another collaboration.`);
			members.push({ sessionId: session.sessionId, name: session.label ?? name });
		}
		if (members.length < 2) throw new Error("Name at least one other session.");
		const collaboration: Collaboration = {
			id: `collab_${randomUUID().slice(0, 8)}`,
			revision: 1,
			scope: work,
			members,
		};
		for (const member of members) this.bySession.set(member.sessionId, collaboration);
		await this.tell(collaboration, opener.sessionId, collaboration);
		return collaboration;
	}

	/** The user changes the work of session `sessionId`'s collaboration: what was sent before is stale. */
	async rescope(sessionId: string, scope: string): Promise<Collaboration> {
		const work = checkScope(scope);
		const collaboration = this.bySession.get(sessionId);
		if (!collaboration) throw new Error("This session is in no collaboration.");
		collaboration.scope = work;
		collaboration.revision++;
		await this.tell(collaboration, sessionId, collaboration);
		return collaboration;
	}

	/** The user ends session `sessionId`'s collaboration, for every member. */
	async end(sessionId: string): Promise<Collaboration> {
		const collaboration = this.bySession.get(sessionId);
		if (!collaboration) throw new Error("This session is in no collaboration.");
		for (const member of collaboration.members) this.bySession.delete(member.sessionId);
		await this.tell(collaboration, sessionId, undefined);
		return collaboration;
	}

	/** Session `sessionId` left its collaboration, for another session or by quitting; with one member left, it ends. */
	async leave(sessionId: string): Promise<void> {
		const collaboration = this.bySession.get(sessionId);
		if (!collaboration) return;
		this.bySession.delete(sessionId);
		const left = collaboration.members;
		collaboration.members = left.filter((m) => m.sessionId !== sessionId);
		if (collaboration.members.length > 1) return this.tell(collaboration, sessionId, collaboration, left);
		for (const member of collaboration.members) this.bySession.delete(member.sessionId);
		await this.tell(collaboration, sessionId, undefined, left);
	}

	/**
	 * Sends member `from`'s message to member `to` (a name or session id), as of revision `revision` of their
	 * collaboration; throws why it cannot. The daemon, not the sender, says who sent it and for what.
	 */
	async send(
		from: string,
		revision: number,
		to: string,
		kind: CollaboratorMessageKind,
		text: string,
	): Promise<CollaborationMember> {
		const collaboration = this.bySession.get(from);
		if (!collaboration)
			throw new Error("This session is in no collaboration: only the user opens one, with /collaborate.");
		if (revision !== collaboration.revision) {
			throw new Error(
				`The user changed the collaboration's scope since: it is now "${collaboration.scope}". Reconsider the message under it.`,
			);
		}
		if (text.length > MAX_TEXT) throw new Error(`The message is longer than ${MAX_TEXT} characters.`);
		const sender = collaboration.members.find((m) => m.sessionId === from);
		if (!sender) throw new Error("This session is in no collaboration: only the user opens one, with /collaborate.");
		const recipient = collaboration.members.find(
			(m) => m.sessionId !== from && (m.name === to || m.sessionId === to),
		);
		// The same answer whether or not such a session exists: membership is all a member can learn.
		if (!recipient)
			throw new Error(
				`no session "${to}" is in this collaboration. Only the user adds sessions, with /collaborate.`,
			);
		const delivered = await this.deliverTo(recipient.sessionId, {
			type: "session_message",
			from: sender.name,
			kind: "collaborator_message",
			to: recipient.sessionId,
			collaboration: collaboration.id,
			revision: collaboration.revision,
			scope: collaboration.scope,
			fromSession: sender.sessionId,
			message: kind,
			text,
		});
		if (!delivered) throw new Error(`"${recipient.name}" is not open in any pane now.`);
		return recipient;
	}

	/** Whether a message of `revision` of collaboration `id` to session `sessionId` is still current. */
	current(id: string, revision: number, sessionId: string): boolean {
		const collaboration = this.bySession.get(sessionId);
		return collaboration?.id === id && collaboration.revision === revision;
	}

	/** Tells every member but `actor` what the collaboration is now; `now` undefined once it ended. */
	private async tell(
		collaboration: Collaboration,
		actor: string,
		now: Collaboration | undefined,
		members = collaboration.members,
	): Promise<void> {
		const others = members.filter((m) => m.sessionId !== actor);
		await Promise.all(
			others.map((member) =>
				this.deliverTo(member.sessionId, {
					type: "session_message",
					from: members.find((m) => m.sessionId === actor)?.name ?? actor,
					kind: "collaboration",
					to: member.sessionId,
					...(now ? { collaboration: { ...now, members: now.members.map((m) => ({ ...m })) } } : {}),
				}),
			),
		);
	}

	private async deliverTo(sessionId: string, message: SessionMessage): Promise<boolean> {
		const session = this.deps.sessions().find((s) => s.sessionId === sessionId);
		return session ? this.deps.deliver(session.instanceId, message) : false;
	}
}

function checkScope(scope: string): string {
	const work = scope.trim();
	if (!work) throw new Error("Say what work the collaboration is for.");
	if (work.length > MAX_SCOPE) throw new Error(`The scope is longer than ${MAX_SCOPE} characters.`);
	return work;
}
