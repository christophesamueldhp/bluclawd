/**
 * Agent view's row actions: what open, reply, stop, delete, pin and start do to each kind of row (a
 * band, a `!` command, this window's own session, a starting one, a pane, a stored one), and in
 * which order they call the daemon and tmux. Every row is a pi in private tmux that the view
 * switches to; nothing here waits on a pane over RPC. The view maps keys to these, keeps its arm,
 * guard and cancel flags, and shows what they return.
 */

import type { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { resumePane, startNewPane } from "../../daemon/pane-start.ts";
import { type AgentRow, labelFromTask } from "../../daemon/rows.ts";
import { AGENT_VIEW_COMMAND, HIDE_ENV, OPEN_VIEW_ENV, type ShellInfo, Tmux } from "../../daemon/tmux.ts";

/** What agent view needs from tmux in pane mode. */
export interface PaneOps {
	/** This pi's own tmux session. */
	current: string;
	switchTo(pane: string): void;
	/** Start pi with `args` in a new tmux session; returns its name. */
	start(cwd: string, args: string[], env?: Record<string, string>): string;
	/** Resolves once a pane started to show agent view has drawn it, or after a few seconds; rejects
	 *  if the pane ends first. */
	waitForView(pane: string): Promise<void>;
	/** End a pane's pi as quitting does: it saves its session as a stopped row. */
	end(pane: string): void;
	/** End a pane's pi at once, leaving no row behind. */
	kill(pane: string): void;
	/** Stop listing this pi's session anywhere; resolves once no heartbeat can list it again. */
	unlist(): Promise<void>;
	/** Leave tmux; every session keeps running. */
	detach(): void;
	/** Run a `!` command in a session of its own; returns its name. */
	startShell(cwd: string, command: string): string;
	listShells(): ShellInfo[];
	/** Stop a running `!` command; its row stays, stopped. */
	stopShell(name: string): void;
	/** A session's last `lines` lines of output. */
	capture(name: string, lines: number): string[];
}

/** What row actions need of the daemon. */
export type RowClient = Pick<OrchestratorClient, "start" | "startFailed" | "send" | "delete" | "setMeta">;

export interface RowActionsOptions {
	client: RowClient;
	panes: PaneOps;
	/** Where the pane that takes this terminal over when its own session is deleted starts. */
	cwd: string;
	/** Stop this window's own session's turn. */
	onStopSelf?: () => void;
}

/** What became of an action. */
export type Outcome =
	/** It happened: the view lists the rows again. */
	| { kind: "done" }
	/** It was tried and failed: the view says why and lists the rows again. */
	| { kind: "failed"; text: string }
	/** Nothing was tried: the view says why, if there is a reason to give. */
	| { kind: "refused"; text?: string };

/** This terminal shows another pane, or its own session again: the view closes. */
type Left = { kind: "left" };

export type OpenOutcome =
	| Outcome
	| Left
	/** A `!` command opens on its output. */
	| { kind: "peek" }
	/** The open was called off while its pane started: it runs on in the background. */
	| { kind: "cancelled" };

export type ReplyOutcome =
	| Outcome
	/** Nothing typed: the row opens instead. */
	| { kind: "open" }
	/** To this window's own session: the view sends it as its next prompt once it closes. */
	| { kind: "self" };

/** The view's part in deleting this window's own session. */
export interface HandOff {
	/** The hand-off starts: keys wait for it. */
	leaving(): void;
	/** This terminal shows the new pane: the view goes before this pane ends. */
	left(): void;
}

export class RowActions {
	private readonly opts: RowActionsOptions;

	constructor(opts: RowActionsOptions) {
		this.opts = opts;
	}

	/** Show a row's session in this terminal. A pane is switched to; a session with no pane gets one
	 *  first, unless `cancelled` says the open was called off meanwhile. */
	async open(row: AgentRow, cancelled: () => boolean): Promise<OpenOutcome> {
		if (row.shell) return { kind: "peek" };
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
		if (cancelled()) return { kind: "cancelled" };
		return this.switchTo(pane);
	}

	/** A peek reply: the session's next prompt (queued behind a turn in progress). A session with no
	 *  pane gets one, with the reply as its first prompt. `/stop` stops a working session's turn or a
	 *  running `!` command, which takes no other reply. */
	async reply(row: AgentRow, text: string): Promise<ReplyOutcome> {
		if (row.shell) {
			if (text === "/stop" && row.alive) return this.stop(row);
			return text
				? { kind: "refused", text: "a shell command takes no reply — ctrl+x stops it" }
				: { kind: "refused" };
		}
		if (!text) return { kind: "open" };
		if (text === "/stop" && row.alive && row.state === "working") {
			if (row.self) return this.stop(row);
			return this.tried("stop", () => this.opts.client.send(row.id, { type: "abort" }));
		}
		if (row.self) return { kind: "self" };
		const { pane, sessionFile } = row;
		if (pane) {
			if (row.state === "needs")
				return { kind: "refused", text: "it's waiting on a question — enter opens it to answer" };
			return this.tried("send", () => this.opts.client.send(row.id, { type: "prompt", text }));
		}
		if (sessionFile && !row.alive) return this.tried("send", () => this.resume(row.cwd, sessionFile, ["--", text]));
		return { kind: "refused", text: "enter opens it" };
	}

	/** Pin a row, or unpin it. */
	async pin(row: AgentRow): Promise<Outcome> {
		if (row.starting) return { kind: "refused" };
		if (row.shell) return { kind: "refused", text: "A shell command can't be pinned" };
		if (row.unlisted) return { kind: "refused", text: "It is listed once it has a prompt" };
		return this.tried(row.pinned ? "unpin" : "pin", () => this.opts.client.setMeta(row.id, { pinned: !row.pinned }));
	}

	/** ctrl+x's first press, as bluclawd's: a running session's pi ends and its row stays, stopped;
	 *  a running `!` command stops and keeps its row; this window's own session stops its turn. */
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
		return this.tried("stop", () => this.opts.panes.end(pane));
	}

	/** ctrl+x's second press: the row goes. A pane still running is killed first; this window's own
	 *  session hands this terminal over to a new pane in agent view, calling `handOff.leaving` as it
	 *  starts and `handOff.left` once this terminal shows the new pane. */
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

	/** A band's second ctrl+x: every one of `rows` goes, whatever becomes of the others. Returns
	 *  the ids that went. */
	async deleteAll(rows: AgentRow[]): Promise<string[]> {
		const gone = await Promise.all(
			rows.map(async (r) => {
				try {
					if (r.shell) this.opts.panes.kill(r.shell);
					else {
						// A stopped row's pane may run another pi by now.
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

	/** This terminal moves to a new session, in agent view, and this pane ends. */
	private async deleteOwnPane(row: AgentRow, handOff: HandOff): Promise<Outcome | Left> {
		const { panes, client } = this.opts;
		let next: string | undefined;
		handOff.leaving();
		try {
			// Its first prompt, not its session_start: an extension starting after this one (paste's
			// editor) would take the keyboard from a view opened there.
			next = panes.start(this.opts.cwd, ["--", `/${AGENT_VIEW_COMMAND}`], {
				[OPEN_VIEW_ENV]: "1",
				[HIDE_ENV]: row.id,
			});
			// Switching at once would show the new pi starting up, then its prompt, then its agent view.
			await panes.waitForView(next);
			panes.switchTo(next);
		} catch (error) {
			if (next) {
				try {
					panes.kill(next);
				} catch {
					// it ended already
				}
			}
			return { kind: "failed", text: `Couldn't delete — ${message(error)}` };
		}
		handOff.left();
		await panes.unlist();
		if (!row.unlisted) await client.delete(row.id).catch(() => undefined);
		try {
			panes.kill(panes.current);
		} catch {
			// The daemon ends this pi at its next heartbeat: its row was deleted.
		}
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

	/** Show `pane` in this terminal. */
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

	/** A pi on a stored or past session, in a pane of its own. The daemon claims the session first,
	 *  refusing it while another window's pane starts or runs it, and lists its row as starting until
	 *  the pane registers. */
	async resume(cwd: string, sessionFile: string, args: string[], label?: string): Promise<string> {
		const spec = { cwd, sessionFile, ...(label ? { label } : {}) };
		const { pane } = await resumePane(this.opts.client, spec, () =>
			this.opts.panes.start(cwd, ["--session", sessionFile, ...args]),
		);
		return pane;
	}

	/** A new session: a pi of its own, with the task and images as its first prompt. The daemon lists
	 *  its row as starting under the pane's name once `claimed` settles. */
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

/** bluclawd's ctrl+x stops a session in Working or Needs input first, and deletes the rest. */
export function stoppable(row: AgentRow): boolean {
	return row.alive && (row.state === "working" || row.state === "needs" || row.state === "idle");
}

/** A row ctrl+x arms for: one still starting is left alone. */
export function deletable(row: AgentRow): boolean {
	return !row.starting;
}

/** The rows a band's ctrl+x deletes: all but this window's own and those still starting. */
export function bandTargets(rows: AgentRow[]): AgentRow[] {
	return rows.filter((r) => !r.self && deletable(r));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
