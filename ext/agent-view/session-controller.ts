import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "@earendil-works/pi-coding-agent";
import { reduceViewProjection } from "../../daemon/view-projection.ts";
import type {
	HistoryPage,
	ManagedDraft,
	SessionTarget,
	ViewEvent,
	ViewProjection,
	ViewReady,
	ViewTerminal,
} from "../../daemon/view-types.ts";
import type { InstanceSummary, OrchestratorClient } from "./orchestrator-client.ts";
import type { SessionViewClient, SessionViewHandle } from "./view-client.ts";

const BLANK_DRAFT = "$blank";
const emptyDraft = (): ManagedDraft => ({ text: "", images: [] });
export type ConnectionState = "blank" | "connecting" | "connected" | "disconnected" | "stopped" | "failed";
export type SubmissionResult = "accepted" | "rejected" | "uncertain";
export interface SessionControllerOptions {
	client: Pick<OrchestratorClient, "list" | "spawn" | "history">;
	views: Pick<SessionViewClient, "open">;
	cwd: string;
	model?: { provider: string; id: string };
	onChange: () => void;
}
interface Attachment {
	handle?: SessionViewHandle;
	kind: ConnectionState;
	committed: boolean;
	lost?: Error;
	records: Array<ViewEvent | ViewTerminal>;
	bytes: number;
}
export class SessionController {
	private readonly options: SessionControllerOptions;
	private current?: Attachment;
	private ready?: ViewReady;
	private disposed = false;
	private epoch = 0;
	private selectionAbort?: AbortController;
	private readonly drafts = new Map<string, ManagedDraft>();
	private readonly revisions = new Map<string, number>();
	private readonly notices = new Map<string, string>();
	private readonly forgotten = new Set<string>();
	private readonly submissions = new Map<string, object>();
	private selectionNotice?: string;
	private historyLoaded = false;
	private historyCursor?: string;
	constructor(options: SessionControllerOptions) {
		this.options = options;
	}
	private notify() {
		if (!this.disposed) this.options.onChange();
	}
	private draftKey() {
		return this.ready?.instance.id ?? BLANK_DRAFT;
	}
	selected(): ViewReady | undefined {
		return this.ready;
	}
	projection(): ViewProjection | undefined {
		return this.ready?.projection;
	}
	connectionState(): ConnectionState {
		return this.selectionAbort ? "connecting" : (this.current?.kind ?? "blank");
	}
	notice(): string | undefined {
		return this.selectionNotice ?? this.notices.get(this.draftKey());
	}
	draft(): ManagedDraft {
		return structuredClone(this.drafts.get(this.draftKey()) ?? emptyDraft());
	}
	setDraft(draft: ManagedDraft): void {
		if (this.disposed) return;
		const key = this.draftKey();
		this.drafts.set(key, structuredClone(draft));
		this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
		this.notify();
	}
	cancelSelection(): void {
		this.epoch++;
		this.selectionAbort?.abort();
		this.selectionAbort = undefined;
		this.notify();
	}
	private async resolveTarget(target: SessionTarget): Promise<InstanceSummary> {
		const rows = await this.options.client.list();
		const row =
			"instanceId" in target
				? rows.find((row) => row.id === target.instanceId)
				: rows.find((row) => row.sessionFile === target.sessionFile);
		if (row?.external) throw new Error("Session is still owned by another terminal");
		if (row?.status === "online") return row;
		if ("instanceId" in target && !row) throw new Error("Session is no longer available");
		const file = "sessionFile" in target ? target.sessionFile : row?.sessionFile;
		if (!file) throw new Error("Stopped session has no saved transcript");
		const instance = await this.options.client.spawn({
			cwd: "cwd" in target ? target.cwd : row!.cwd,
			sessionFile: file,
			...("model" in target && target.model ? { model: target.model } : {}),
		});
		if (!instance) throw new Error("Daemon did not return a session");
		return instance;
	}
	select(target: SessionTarget, signal?: AbortSignal): Promise<boolean> {
		return this.changeSelection(() => this.resolveTarget(target), signal);
	}
	private async changeSelection(
		resolveTarget: () => Promise<InstanceSummary>,
		externalSignal?: AbortSignal,
		moveDraftFrom?: string,
	): Promise<boolean> {
		if (this.disposed) return false;
		this.cancelSelection();
		const epoch = this.epoch;
		const abort = new AbortController();
		this.selectionAbort = abort;
		const externalAbort = () => abort.abort();
		externalSignal?.addEventListener("abort", externalAbort, { once: true });
		if (externalSignal?.aborted) abort.abort();
		const signal = abort.signal;
		const candidate: Attachment = { kind: "connected", committed: false, records: [], bytes: 0 };
		this.notify();
		try {
			const instance = await resolveTarget();
			if (signal.aborted || epoch !== this.epoch || this.disposed) return false;
			candidate.handle = await this.options.views.open(instance.id, {
				signal,
				onRecord: (record) => {
					if (this.current === candidate) {
						this.applyRecord(candidate, record);
						return;
					}
					if (candidate.committed || candidate.lost) return;
					candidate.records.push(record);
					candidate.bytes += Buffer.byteLength(JSON.stringify(record));
					if (candidate.bytes > 16 * 1024 * 1024) {
						candidate.lost = new Error("Session attach buffer exceeds 16 MiB");
						candidate.handle?.close();
					}
				},
				onDisconnect: (error) => {
					candidate.lost = error ?? new Error("Session view disconnected");
					candidate.kind = "disconnected";
					if (this.current === candidate) {
						this.selectionNotice = candidate.lost.message;
						this.notify();
					}
				},
			});
			if (
				signal.aborted ||
				epoch !== this.epoch ||
				this.disposed ||
				candidate.lost ||
				this.forgotten.has(instance.id)
			) {
				candidate.committed = true;
				candidate.handle.close();
				if (candidate.lost && epoch === this.epoch && !signal.aborted)
					this.selectionNotice = candidate.lost.message;
				return false;
			}
			const old = this.current;
			candidate.committed = true;
			this.current = candidate;
			this.ready = structuredClone(candidate.handle.ready);
			this.normalizeState();
			this.historyLoaded = false;
			this.historyCursor = undefined;
			this.selectionNotice = undefined;
			if (moveDraftFrom) {
				const draft = this.drafts.get(moveDraftFrom);
				if (draft) this.drafts.set(instance.id, draft);
				this.revisions.set(instance.id, this.revisions.get(moveDraftFrom) ?? 0);
				this.drafts.delete(moveDraftFrom);
				this.revisions.delete(moveDraftFrom);
			}
			if (this.ready.projection.editorText !== undefined && !this.drafts.has(instance.id)) {
				this.drafts.set(instance.id, { text: this.ready.projection.editorText, images: [] });
				this.revisions.set(instance.id, (this.revisions.get(instance.id) ?? 0) + 1);
			}
			old?.handle?.close();
			const records = candidate.records;
			candidate.records = [];
			candidate.bytes = 0;
			for (const record of records) this.applyRecord(candidate, record);
			this.notify();
			return this.current === candidate;
		} catch (error) {
			candidate.committed = true;
			candidate.handle?.close();
			if (epoch === this.epoch && !signal.aborted && !this.disposed) {
				this.selectionNotice = error instanceof Error ? error.message : String(error);
				this.notify();
			}
			return false;
		} finally {
			externalSignal?.removeEventListener("abort", externalAbort);
			if (epoch === this.epoch) {
				this.selectionAbort = undefined;
				this.notify();
			}
		}
	}
	private normalizeState(): void {
		if (!this.ready) return;
		const p = this.ready.projection;
		this.ready = {
			...this.ready,
			state: {
				...this.ready.state,
				isStreaming: p.running,
				isCompacting: p.compacting,
				pendingMessageCount: p.queues.steering.length + p.queues.followUp.length,
			},
		};
	}
	private applyRecord(candidate: Attachment, record: ViewEvent | ViewTerminal): void {
		if (
			this.disposed ||
			candidate.lost ||
			this.current !== candidate ||
			!this.ready ||
			record.generation !== this.ready.generation ||
			record.sequence <= this.ready.sequence
		)
			return;
		if (record.sequence !== this.ready.sequence + 1) {
			candidate.kind = "disconnected";
			candidate.lost = new Error("Session event gap; reconnect to inspect a fresh snapshot");
			candidate.handle?.close();
			this.selectionNotice = candidate.lost.message;
			this.notify();
			return;
		}
		this.ready = { ...this.ready, sequence: record.sequence };
		if (record.type === "view_terminal") {
			if (record.instanceId !== this.ready.instance.id) return;
			if (record.reason === "deleted") {
				this.forget(record.instanceId);
				return;
			}
			candidate.kind = record.reason === "failed" ? "failed" : "stopped";
			this.ready = {
				...this.ready,
				instance: { ...this.ready.instance, status: "stopped" },
				projection: {
					...this.ready.projection,
					running: false,
					compacting: false,
					activity: "idle",
					pendingDialog: undefined,
					tools: {},
					queues: { steering: [], followUp: [] },
				},
			};
			if (record.error) this.selectionNotice = record.error;
		} else {
			const projection = reduceViewProjection(
				this.ready.projection,
				record.event,
				`${record.generation}:${record.sequence}`,
			);
			this.ready = { ...this.ready, projection };
			if (record.event.type === "view_state") this.ready = { ...this.ready, state: record.event.state };
			if (record.event.type === "extension_ui_request" && record.event.method === "set_editor_text") {
				const key = this.ready.instance.id;
				this.drafts.set(key, { ...this.draft(), text: record.event.text });
				this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
			}
		}
		this.normalizeState();
		this.notify();
	}
	async submit(draft: ManagedDraft): Promise<SubmissionResult> {
		if (this.disposed) return "rejected";
		this.setDraft(draft);
		let key = this.draftKey();
		const revision = this.revisions.get(key) ?? 0;
		const submitted = structuredClone(draft);
		this.selectionNotice = undefined;
		if (!submitted.text.trim() && !submitted.images.length) {
			this.notices.set(key, "Enter a message or attach an image");
			this.notify();
			return "rejected";
		}
		if (this.submissions.has(key)) {
			this.notices.set(key, "A submission is still awaiting acknowledgement");
			this.notify();
			return "rejected";
		}
		const token = {};
		this.submissions.set(key, token);
		this.notices.delete(key);
		try {
			if (!this.ready) {
				const accepted = await this.changeSelection(
					async () => {
						const row = await this.options.client.spawn({
							cwd: this.options.cwd,
							...(this.options.model ? { model: this.options.model } : {}),
						});
						if (!row) throw new Error("Daemon did not return a session");
						return row;
					},
					undefined,
					BLANK_DRAFT,
				);
				if (!accepted) return "rejected";
				this.submissions.delete(key);
				key = this.draftKey();
				this.submissions.set(key, token);
			} else if (this.current?.kind !== "connected") {
				const selectedId = this.ready.instance.id;
				if (!(await this.select({ instanceId: selectedId }))) return "rejected";
				if (this.ready?.instance.id !== selectedId) return "rejected";
			}
			const attachment = this.current;
			if (!attachment?.handle || attachment.kind !== "connected" || this.ready?.instance.id !== key)
				return "rejected";
			const busy = this.ready.projection.running || this.ready.projection.compacting;
			let response: RpcResponse;
			try {
				response = await attachment.handle.send({
					type: "prompt",
					message: submitted.text,
					...(submitted.images.length ? { images: submitted.images } : {}),
					...(busy ? { streamingBehavior: "followUp" as const } : {}),
				});
			} catch (error) {
				if (!this.forgotten.has(key))
					this.notices.set(
						key,
						`Submission may have been accepted; reconnect to inspect before sending again. ${error instanceof Error ? error.message : String(error)}`,
					);
				this.notify();
				return "uncertain";
			}
			if (response.success === false) {
				if (!this.forgotten.has(key)) this.notices.set(key, response.error);
				this.notify();
				return "rejected";
			}
			if (this.revisions.get(key) === revision && !this.forgotten.has(key)) {
				this.drafts.set(key, emptyDraft());
				this.revisions.set(key, revision + 1);
			}
			this.notices.delete(key);
			this.notify();
			return "accepted";
		} finally {
			if (this.submissions.get(key) === token) this.submissions.delete(key);
		}
	}
	async send(command: RpcCommand): Promise<RpcResponse> {
		if (this.disposed || this.current?.kind !== "connected" || !this.current.handle)
			throw new Error("Session view is disconnected or stopped; reconnect first");
		return this.current.handle.send(command);
	}
	async answer(response: RpcExtensionUIResponse): Promise<boolean> {
		const current = this.current;
		const key = this.draftKey();
		if (current?.kind !== "connected" || !current.handle || this.ready?.projection.pendingDialog?.id !== response.id)
			return false;
		try {
			return await current.handle.answer(response);
		} catch (error) {
			if (!this.forgotten.has(key))
				this.notices.set(
					key,
					`Answer acknowledgement lost: ${error instanceof Error ? error.message : String(error)}`,
				);
			this.notify();
			return false;
		}
	}
	async history(): Promise<HistoryPage> {
		const current = this.current;
		const id = this.ready?.instance.id;
		const before = this.historyLoaded ? this.historyCursor : this.ready?.projection.historyBefore;
		if (!id || !before) return { messages: [] };
		const page = await this.options.client.history(id, before);
		if (this.current !== current) return { messages: [] };
		this.historyLoaded = true;
		this.historyCursor = page.before;
		return page;
	}
	blank(): void {
		this.cancelSelection();
		const old = this.current;
		this.current = undefined;
		this.ready = undefined;
		this.selectionNotice = undefined;
		this.historyLoaded = false;
		this.historyCursor = undefined;
		old?.handle?.close();
		this.notify();
	}
	reconnect(): Promise<boolean> {
		const instance = this.ready?.instance;
		if (!instance || this.disposed) return Promise.resolve(false);
		return this.changeSelection(async () => instance);
	}
	forget(instanceId: string): void {
		this.forgotten.add(instanceId);
		this.drafts.delete(instanceId);
		this.revisions.delete(instanceId);
		this.notices.delete(instanceId);
		if (this.ready?.instance.id === instanceId) {
			this.blank();
			this.drafts.delete(BLANK_DRAFT);
			this.revisions.delete(BLANK_DRAFT);
			this.notices.delete(BLANK_DRAFT);
		}
		this.notify();
	}
	exportState(): { selectedId?: string; drafts: Record<string, ManagedDraft> } {
		return { selectedId: this.ready?.instance.id, drafts: structuredClone(Object.fromEntries(this.drafts)) };
	}
	restoreDrafts(drafts: Record<string, ManagedDraft>): void {
		this.drafts.clear();
		for (const [key, draft] of Object.entries(drafts)) {
			if (!this.forgotten.has(key)) {
				this.drafts.set(key, structuredClone(draft));
				this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
			}
		}
		this.notify();
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelSelection();
		this.current?.handle?.close();
		this.current = undefined;
		this.ready = undefined;
	}
}
