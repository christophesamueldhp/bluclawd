import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deliverOrHold } from "../background-bash/notification-hold.ts";
import { PARENT_MESSAGE_ADDRESS, type SubagentMessage, type SubagentMessageBus } from "./messages.ts";

/** The orchestrator's session, and its session epoch, that a run or message belongs to. */
export interface ParentScope {
	readonly parentSessionId: string;
	readonly sessionEpoch: number;
}

/** A run as its parent scope sees it. */
export interface ScopedRun extends ParentScope {
	readonly originEntryId?: string;
}

export type ParentInboxItem<N> =
	| { readonly kind: "notice"; readonly run: ScopedRun; readonly notice: N }
	| { readonly kind: "message"; readonly message: SubagentMessage; readonly scope: ParentScope };

export interface ParentScopeChecks {
	/** None before the first session starts. */
	current(): ParentScope | undefined;
	inScope(scope: ParentScope): boolean;
	/** Whether the entry is on the active branch; a run without an originating entry always is. */
	onBranch(entryId: string | undefined): boolean;
}

export interface ParentScopeDeps<N> {
	bus: Pick<SubagentMessageBus, "register" | "unregister">;
	/** Cancels every live run `where` selects. */
	cancelRuns(where: (run: ScopedRun) => boolean, reason: string): void;
	/** Sends the items still in scope, in arrival order, to the orchestrator as one message. */
	send(items: readonly ParentInboxItem<N>[]): void;
	onChange(): void;
	batchWindowMs: number;
}

/** Owns the parent scope and the batched inbox to the orchestrator. */
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
		// A hold can outlast the scope, so what is still deliverable is decided when the batch goes out.
		deliverOrHold(() => {
			const items = batch.filter(isDeliverable);
			if (items.length > 0) deps.send(items);
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

	const invalidate = (reason: string) => {
		sessionEpoch++;
		// Children of the earlier epoch now get "invalidated" when they message the orchestrator.
		registerParentEndpoint();
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
		/** A session started; `reason` says why the one it replaces, if any, is invalidated. */
		enter(next: ExtensionContext, reason: string) {
			if (sessionId !== undefined) invalidate(reason);
			sessionEpoch++;
			ctx = next;
			sessionId = next.sessionManager.getSessionId();
			registerParentEndpoint();
		},
		/** The session is about to be switched or forked. */
		invalidate,
		/** Tree navigation keeps the epoch but stops runs whose originating entry left the branch. */
		navigate(next: ExtensionContext) {
			ctx = next;
			cancelOutOfScope("Originating branch is no longer active after tree navigation");
			deps.onChange();
		},
		shutdown() {
			invalidate("Parent session shutting down");
			deps.bus.unregister(PARENT_MESSAGE_ADDRESS, "has shut down");
		},
		/** Drops the context once the runs stopped by shutdown have settled. */
		detach() {
			ctx = undefined;
		},
		/** Queues a finished run's notice for the orchestrator if the run is still in scope. */
		notify(run: ScopedRun, notice: N) {
			if (runInScope(run)) push({ kind: "notice", run, notice });
		},
	};
}
