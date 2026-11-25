import type { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { resumePane, startNewPane } from "../../daemon/pane-start.ts";
import { type AgentRow, labelFromTask } from "../../daemon/rows.ts";
import { AGENT_VIEW_COMMAND, HIDDEN_ROW_ENV, OPEN_VIEW_ENV, type ShellInfo, Tmux } from "../../daemon/tmux.ts";

export interface PaneOps {
	current: string;
	switchTo(pane: string): void;
	start(cwd: string, args: string[], env?: Record<string, string>): string;
	waitForView(pane: string): Promise<void>;
	end(pane: string): void;
	kill(pane: string): void;
	unlist(): Promise<void>;
	detach(): void;
	startShell(cwd: string, command: string): string;
	listShells(): ShellInfo[];
	listShellsAsync(): Promise<ShellInfo[]>;
	stopShell(name: string): void;
	captureAsync(name: string, lines: number): Promise<string[]>;
}

export type RowClient = Pick<OrchestratorClient, "start" | "startFailed" | "send" | "delete" | "setMeta">;

export interface RowActionsOptions {
	client: RowClient;
	panes: PaneOps;
	cwd: string;
	onStopSelf?: () => void;
}

export type Outcome = { kind: "done" } | { kind: "failed"; text: string } | { kind: "refused"; text?: string };

type Left = { kind: "left" };

export type OpenOutcome = Outcome | Left | { kind: "peekOutput" } | { kind: "cancelledInBackground" };

export type ReplyOutcome = Outcome | { kind: "openInstead" } | { kind: "sendToSelfOnClose" };

export interface HandOff {
	leaving(): void;
	left(): void;
}

export class RowActions {
	private readonly opts: RowActionsOptions;

	constructor(opts: RowActionsOptions) {
		this.opts = opts;
	}

	async open(row: AgentRow, cancelled: () => boolean): Promise<OpenOutcome> {
		if (row.shell) return { kind: "peekOutput" };
		if (row.self) return { kind: "left" };
		if (row.starting || !row.sessionFile) {
			return {
				kind: "refused",
				text:
					!row.alive && !row.sessionFile
						? "No session file recorded — use /resume to reopen its saved conversation"
						: "Still starting — try again in a moment",
			};
		}
		if (row.pane) return this.switchTo(row.pane);
		let pane: string;
		try {
			pane = await this.resume(row.cwd, row.sessionFile, []);
		} catch (error) {
			return { kind: "failed", text: `Couldn't open — ${Tmux.reason(error)}` };
		}
		if (cancelled()) return { kind: "cancelledInBackground" };
		return this.switchTo(pane);
	}

	async reply(row: AgentRow, text: string): Promise<ReplyOutcome> {
		if (row.shell) {
			if (text === "/stop" && row.alive) return this.stop(row);
			return text
				? { kind: "refused", text: "a shell command takes no reply — ctrl+x stops it" }
				: { kind: "refused" };
		}
		if (!text) return { kind: "openInstead" };
		if (text === "/stop" && row.alive && row.state === "working") {
			if (row.self) return this.stop(row);
			return this.tried("stop", () => this.opts.client.send(row.id, { type: "abort" }));
		}
		if (row.self) return { kind: "sendToSelfOnClose" };
		const { pane, sessionFile } = row;
		if (pane) {
			if (row.state === "needs")
				return { kind: "refused", text: "it's waiting on a question — enter opens it to answer" };
			return this.tried("send", () => this.opts.client.send(row.id, { type: "prompt", text }));
		}
		if (sessionFile && !row.alive) return this.tried("send", () => this.resume(row.cwd, sessionFile, ["--", text]));
		return { kind: "refused", text: "enter opens it" };
	}

	async pin(row: AgentRow): Promise<Outcome> {
		if (row.starting) return { kind: "refused" };
		if (row.shell) return { kind: "refused", text: "A shell command can't be pinned" };
		if (row.unlisted) return { kind: "refused", text: "It is listed once it has a prompt" };
		return this.tried(row.pinned ? "unpin" : "pin", () => this.opts.client.setMeta(row.id, { pinned: !row.pinned }));
	}

	async stop(row: AgentRow): Promise<Outcome> {
		const { shell, pane } = row;
		if (shell) {
			if (!row.alive) return { kind: "refused" };
			return this.tried("stop", () => this.opts.panes.stopShell(shell));
		}
		if (row.self) {
			if (!stoppable(row)) return { kind: "refused" };
			this.opts.onStopSelf?.();
			return { kind: "done" };
		}
		if (!pane || !stoppable(row)) return { kind: "refused" };
		return this.tried("stop", () => {
			try {
				this.opts.panes.end(pane);
			} catch (error) {
				if (!Tmux.gone(error)) throw error;
			}
		});
	}

	async delete(row: AgentRow, handOff: HandOff): Promise<Outcome | Left> {
		if (!deletable(row)) return { kind: "refused" };
		if (row.shell) {
			this.opts.panes.kill(row.shell);
			return { kind: "done" };
		}
		if (row.self) return this.deleteOwnPane(row, handOff);
		return this.tried("delete", async () => {
			if (row.pane && row.alive) this.opts.panes.kill(row.pane);
			await this.opts.client.delete(row.id);
		});
	}

	async deleteAll(rows: AgentRow[]): Promise<string[]> {
		const gone = await Promise.all(
			rows.map(async (r) => {
				try {
					if (r.shell) this.opts.panes.kill(r.shell);
					else {
						if (r.pane && r.alive) this.opts.panes.kill(r.pane);
						await this.opts.client.delete(r.id);
					}
					return [r.id];
				} catch {
					return [];
				}
			}),
		);
		return gone.flat();
	}

	private async deleteOwnPane(row: AgentRow, handOff: HandOff): Promise<Outcome | Left> {
		const { panes, client } = this.opts;
		let next: string | undefined;
		handOff.leaving();
		try {
			next = panes.start(this.opts.cwd, openViewAsFirstPrompt(), {
				[OPEN_VIEW_ENV]: "1",
				[HIDDEN_ROW_ENV]: row.id,
			});
			await panes.waitForView(next);
			panes.switchTo(next);
		} catch (error) {
			if (next) killIfStillThere(panes, next);
			return { kind: "failed", text: `Couldn't delete — ${message(error)}` };
		}
		handOff.left();
		await panes.unlist();
		if (!row.unlisted) await client.delete(row.id).catch(() => undefined);
		killIfStillThere(panes, panes.current);
		return { kind: "left" };
	}

	private async tried(verb: string, act: () => unknown): Promise<Outcome> {
		try {
			await act();
		} catch (error) {
			return { kind: "failed", text: `Couldn't ${verb} — ${message(error)}` };
		}
		return { kind: "done" };
	}

	switchTo(pane: string): Left | Outcome {
		try {
			this.opts.panes.switchTo(pane);
		} catch (error) {
			return {
				kind: "failed",
				text: Tmux.gone(error)
					? "Couldn't open — that session's pane is gone"
					: `Couldn't open — ${Tmux.reason(error)}`,
			};
		}
		return { kind: "left" };
	}

	async resume(cwd: string, sessionFile: string, args: string[], label?: string): Promise<string> {
		const spec = { cwd, sessionFile, ...(label ? { label } : {}) };
		const { pane } = await resumePane(this.opts.client, spec, () =>
			this.opts.panes.start(cwd, ["--session", sessionFile, ...args]),
		);
		return pane;
	}

	start(
		cwd: string,
		task: string,
		images: string[],
		model?: { provider: string; id: string },
	): { kind: "started"; pane: string; claimed: Promise<void> } | { kind: "failed"; text: string } {
		try {
			const started = startNewPane(this.opts.client, { cwd, label: labelFromTask(task || "Image task") }, () =>
				this.opts.panes.start(cwd, [
					...(model ? ["--model", `${model.provider}/${model.id}`] : []),
					"--",
					...images.map((file) => `@${file}`),
					...(task ? [task] : []),
				]),
			);
			return { kind: "started", ...started };
		} catch (error) {
			return { kind: "failed", text: `Couldn't start it — ${Tmux.reason(error)}` };
		}
	}
}

export function stoppable(row: AgentRow): boolean {
	if (row.self) return row.state === "working" || row.state === "needs";
	return row.alive;
}

export function deletable(row: AgentRow): boolean {
	return !row.starting;
}

export function bandTargets(rows: AgentRow[]): AgentRow[] {
	return rows.filter((r) => !r.self && deletable(r));
}

function openViewAsFirstPrompt(): string[] {
	return ["--", `/${AGENT_VIEW_COMMAND}`];
}

function killIfStillThere(panes: PaneOps, pane: string): void {
	try {
		panes.kill(pane);
	} catch {}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
