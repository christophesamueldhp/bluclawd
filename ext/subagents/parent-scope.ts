import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deliverOrHold } from "../background-bash/notification-hold.ts";
import { PARENT_MESSAGE_ADDRESS, type SubagentMessage, type SubagentMessageBus } from "./messages.ts";

export interface ParentScope {
	readonly parentSessionId: string;
	readonly sessionEpoch: number;
}

export function inParentScope(run: ParentScope, scope: ParentScope): boolean {
	return run.parentSessionId === scope.parentSessionId && run.sessionEpoch === scope.sessionEpoch;
}

export interface ScopedRun extends ParentScope {
	readonly originEntryId?: string;
}

export type ParentInboxItem<N> =
	| { readonly kind: "notice"; readonly run: ScopedRun; readonly notice: N }
	| { readonly kind: "message"; readonly message: SubagentMessage; readonly scope: ParentScope };

export interface ParentScopeChecks {
	current(): ParentScope | undefined;
	inScope(scope: ParentScope): boolean;
	onBranch(entryId: string | undefined): boolean;
}

export interface ParentScopeDeps<N> {
	bus: Pick<SubagentMessageBus, "register" | "unregister">;
	cancelRuns(where: (run: ScopedRun) => boolean, reason: string): void;
	send(items: readonly ParentInboxItem<N>[]): void;
	onChange(): void;
	batchWindowMs: number;
}

function detailsHold(details: unknown, id: string): boolean {
	const given = details as { id?: unknown; messages?: unknown } | undefined;
	return (
		given?.id === id ||
		(Array.isArray(given?.messages) && given.messages.some((message) => (message as { id?: unknown })?.id === id))
	);
}

export function createParentScope<N>(deps: ParentScopeDeps<N>) {
	let ctx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let sessionEpoch = 0;
	let inbox: ParentInboxItem<N>[] = [];
	let batchTimer: ReturnType<typeof setTimeout> | undefined;

	const current = (): ParentScope | undefined =>
		sessionId === undefined ? undefined : { parentSessionId: sessionId, sessionEpoch };

	const inScope = (scope: ParentScope): boolean => {
		if (!ctx || scope.sessionEpoch !== sessionEpoch || scope.parentSessionId !== sessionId) return false;
		try {
			ctx.sessionManager.getSessionId();
			return true;
		} catch {
			// SDK disposal can invalidate the context without emitting session_shutdown.
			return false;
		}
	};

	const onBranch = (entryId: string | undefined): boolean => {
		if (!entryId) return true;
		try {
			return ctx?.sessionManager.getBranch().some((entry) => entry.id === entryId) ?? false;
		} catch {
			return false;
		}
	};

	const runInScope = (run: ScopedRun) => inScope(run) && onBranch(run.originEntryId);

	const isDeliverable = (item: ParentInboxItem<N>) =>
		item.kind === "notice" ? runInScope(item.run) : inScope(item.scope);

	const flush = () => {
		batchTimer = undefined;
		const batch = inbox.splice(0);
		if (batch.length === 0) return;
		deliverOrHold(() => {
			const deliverableAtSend = batch.filter(isDeliverable);
			if (deliverableAtSend.length > 0) deps.send(deliverableAtSend);
		});
	};

	const push = (item: ParentInboxItem<N>) => {
		inbox.push(item);
		if (deps.batchWindowMs <= 0) {
			flush();
		} else if (!batchTimer) {
			batchTimer = setTimeout(flush, deps.batchWindowMs);
			batchTimer.unref?.();
		}
	};

	const registerParentEndpoint = () => {
		const scope = current();
		if (!scope) return;
		deps.bus.register(PARENT_MESSAGE_ADDRESS, {
			scope,
			deliver: async (message) => push({ kind: "message", message, scope }),
		});
	};

	const cancelOutOfScope = (reason: string) => deps.cancelRuns((run) => !runInScope(run), reason);

	const reRegisterForNewEpoch = () => {
		sessionEpoch++;
		registerParentEndpoint();
	};

	const invalidate = (reason: string) => {
		reRegisterForNewEpoch();
		if (batchTimer) {
			clearTimeout(batchTimer);
			batchTimer = undefined;
		}
		inbox = [];
		cancelOutOfScope(reason);
		deps.onChange();
	};

	return {
		current,
		inScope,
		onBranch,
		context: () => ctx,
		enter(next: ExtensionContext, reason: string) {
			if (sessionId !== undefined) invalidate(reason);
			sessionEpoch++;
			ctx = next;
			sessionId = next.sessionManager.getSessionId();
			registerParentEndpoint();
		},
		invalidate,
		navigate(next: ExtensionContext) {
			ctx = next;
			cancelOutOfScope("Originating branch is no longer active after tree navigation");
			deps.onChange();
		},
		shutdown() {
			invalidate("Parent session shutting down");
			deps.bus.unregister(PARENT_MESSAGE_ADDRESS, "has shut down");
		},
		release() {
			if (batchTimer) clearTimeout(batchTimer);
			batchTimer = undefined;
			inbox = [];
			deps.bus.unregister(PARENT_MESSAGE_ADDRESS, "has reloaded");
		},
		detach() {
			ctx = undefined;
		},
		holds(id: string): boolean {
			try {
				return (
					ctx?.sessionManager
						.getEntries()
						.some((entry) => entry.type === "custom_message" && detailsHold(entry.details, id)) ?? false
				);
			} catch {
				return false;
			}
		},
		notify(run: ScopedRun, notice: N) {
			if (runInScope(run)) push({ kind: "notice", run, notice });
		},
	};
}
