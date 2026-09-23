/**
 * Agent view — Claude Code 2.1.280's `claude agents` screen, rebuilt on pi's TUI.
 *
 * Header, then the bands (Needs input / Working / Completed, or one band per directory), one
 * line per session: icon + name │ what it is doing │ age. The composer at the bottom starts a
 * new background session from whatever is typed; space opens the peek panel to read the
 * question or result and reply without leaving the list; enter opens the session in this
 * window (the one here goes to the background daemon).
 *
 * Layout, glyphs, keys and wording follow Claude Code's own; the known differences are listed
 * in the README (no model-written summaries, no pull-request badges, no `!` shell rows).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../_shared/theme.ts";
import { currentDaemonBuildId, type InstanceSummary, type OrchestratorClient } from "./orchestrator-client.ts";
import {
	type AgentRow,
	type Band,
	buildBands,
	collectRows,
	compactAge,
	countRows,
	labelFromTask,
	type RowState,
	rowAge,
	STATE_WORDS,
	stateFilter,
	type ViewMode,
} from "./rows.ts";

export interface PastSession {
	sessionFile: string;
	cwd: string;
	label: string;
	modifiedAt: string;
}

export interface AgentViewOptions {
	ui: TUI;
	client: OrchestratorClient;
	appName: string;
	version?: string;
	/** The model new sessions start with (the foreground's); `/model` overrides it for this view. */
	model?: { provider: string; id: string };
	cwd: string;
	home: string;
	/** This window's own session as a row, rebuilt on every refresh (its activity is live). */
	self?: () => InstanceSummary | undefined;
	onClose: () => void;
	/** Open a session in this window; the one here goes to the background. */
	onOpen: (sessionFile: string, cwd: string) => void;
	/** A peek reply to this window's own session: sent as its next prompt once the view closes. */
	onSelfReply?: (text: string) => void;
	/** ctrl+enter: start a session in this window with `task` as its first prompt. */
	onCreateAndOpen?: (cwd: string, model: { provider: string; id: string } | undefined, task: string) => void;
	/** `/resume`: this repository's past sessions, newest first. */
	loadPastSessions?: (cwd: string) => Promise<PastSession[]>;
	loadViewMode?: () => ViewMode | undefined;
	saveViewMode?: (mode: ViewMode) => void;
	/** The terminal tab title while the view is open; undefined restores the session's own. */
	setTitle?: (title: string | undefined) => void;
	/** Test seam for the "wait for the session file" step of opening a starting session. */
	fileExists?: (path: string) => boolean;
}

type Item =
	| { kind: "header"; key: string; band: Band }
	| { kind: "row"; key: string; band: Band; row: AgentRow }
	| { kind: "more"; key: string; band: Band; hidden: number };

type Mode = "list" | "peek" | "rename" | "resume" | "help";

const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER = [...FRAMES, ...[...FRAMES].reverse()];
const ARM_MS = 2000;
const NOTICE_MS = 3000;

const ICON_COLOR: Record<RowState, Parameters<typeof theme.fg>[0]> = {
	working: "accent",
	needs: "warning",
	idle: "dim",
	done: "success",
	failed: "error",
	stopped: "muted",
};

/** An Input line with Claude Code's `❯` prompt and a dim placeholder when empty. */
function promptLine(input: Input, width: number, placeholder: string): string {
	if (!input.getValue()) {
		return truncateToWidth(`❯ \x1b[7m \x1b[27m${theme.fg("dim", placeholder)}`, width);
	}
	const line = input.render(width)[0] ?? "";
	return line.startsWith("> ") ? `❯ ${line.slice(2)}` : line;
}

function sanitize(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, " ");
}

export class AgentView implements Component, Focusable {
	focused = false;

	private readonly opts: AgentViewOptions;
	private readonly composer = new Input();
	/** Lines above the composer's current one (ctrl+j / shift+enter); Input itself is single-line. */
	private composerLines: string[] = [];
	/** True while ctrl+g's editor owns the terminal. */
	private editing = false;
	private readonly reply = new Input();
	private readonly renameInput = new Input();
	private instances: InstanceSummary[] = [];
	private rows: AgentRow[] = [];
	private pending: AgentRow[] = [];
	private items: Item[] = [];
	private selectedKey: string | undefined;
	private mode: Mode = "list";
	private viewMode: ViewMode;
	private readonly collapsed = new Set<string>();
	private readonly expanded = new Set<string>();
	private armed: { key: string; timer: ReturnType<typeof setTimeout> } | undefined;
	private ctrlCArmedAt = 0;
	private notice: { text: string; color: "warning" | "error" | "dim" } | undefined;
	private noticeTimer: ReturnType<typeof setTimeout> | undefined;
	private daemonNotice = "";
	private connectionLost = false;
	private opening: string | undefined;
	private dispatchModel: { provider: string; id: string } | undefined;
	private past: PastSession[] = [];
	private pastIndex = 0;
	private pastLoading = false;
	private frame = 0;
	private spinTimer: ReturnType<typeof setInterval> | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private refreshing = false;
	private closed = false;
	private lastTitle = "";
	private userMoved = false;

	constructor(opts: AgentViewOptions) {
		this.opts = opts;
		this.viewMode = opts.loadViewMode?.() ?? "state";
		this.dispatchModel = opts.model;
		// This window's own row shows at once, before the daemon (maybe cold-starting) answers.
		this.recompute();
	}

	async onShow(): Promise<void> {
		const ok = await this.opts.client.ensureDaemon();
		if (this.closed) return;
		if (!ok) {
			this.daemonNotice = "background service unavailable — couldn't start `node daemon/cli.ts serve`";
		} else {
			const info = await this.opts.client.getDaemonInfo();
			if (this.closed) return;
			if (info.running && info.buildId !== currentDaemonBuildId()) {
				const result = await this.opts.client.restartDaemon();
				if (this.closed) return;
				this.daemonNotice = result.restarted
					? ""
					: `background service is an older build — not restarted: ${result.reason ?? "unknown reason"}`;
			}
		}
		await this.refresh();
		if (this.closed) return;
		this.pollTimer = setInterval(() => void this.refresh(), 1000);
	}

	private close(): void {
		this.teardown();
		this.opts.onClose();
	}

	/** Every path that abandons the view: close, open, create-and-open. */
	private teardown(): void {
		this.closed = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.spinTimer) clearInterval(this.spinTimer);
		if (this.noticeTimer) clearTimeout(this.noticeTimer);
		if (this.armed) clearTimeout(this.armed.timer);
		this.pollTimer = this.spinTimer = this.noticeTimer = undefined;
		this.opts.setTitle?.(undefined);
	}

	private composerText(): string {
		return [...this.composerLines, this.composer.getValue()].join("\n");
	}

	private setComposer(text: string): void {
		const lines = text.split("\n");
		this.composer.setValue(lines.pop() ?? "");
		this.composerLines = lines;
		this.composer.handleInput("\x05"); // ctrl+e: cursor to the end
	}

	/** ctrl+g: edit the dispatch prompt in $VISUAL / $EDITOR, as pi's own editor does. */
	private async editExternally(): Promise<void> {
		const command = process.env.VISUAL || process.env.EDITOR;
		if (!command) {
			this.say("Set $VISUAL or $EDITOR to write the prompt in an editor");
			this.render_();
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), "pi-agents-"));
		const file = join(dir, "prompt.md");
		writeFileSync(file, this.composerText(), "utf-8");
		const tui = this.opts.ui;
		this.editing = true;
		tui.stop();
		try {
			const [bin, ...args] = command.split(" ");
			const code = await new Promise<number | null>((resolve) => {
				const child = spawn(bin, [...args, file], { stdio: "inherit" });
				child.on("error", () => resolve(null));
				child.on("close", (exit) => resolve(exit));
			});
			if (code === 0) this.setComposer(readFileSync(file, "utf-8").replace(/\n$/, ""));
		} finally {
			rmSync(dir, { recursive: true, force: true });
			this.editing = false;
			tui.start();
			tui.requestRender(true);
		}
		this.recompute();
		this.render_();
	}

	private render_(): void {
		if (!this.closed && !this.editing) this.opts.ui.requestRender();
	}

	private say(text: string, color: "warning" | "error" | "dim" = "warning"): void {
		if (this.noticeTimer) clearTimeout(this.noticeTimer);
		this.notice = { text, color };
		this.noticeTimer = setTimeout(() => {
			this.notice = undefined;
			this.render_();
		}, NOTICE_MS);
		this.render_();
	}

	// ---- data ----------------------------------------------------------------------------

	private async refresh(): Promise<void> {
		if (this.refreshing || this.closed) return;
		this.refreshing = true;
		try {
			this.instances = await this.opts.client.list();
			this.connectionLost = false;
		} catch {
			this.connectionLost = true;
		} finally {
			this.refreshing = false;
		}
		this.recompute();
		this.render_();
	}

	private recompute(): void {
		const all = [...collectRows(this.instances, this.opts.self?.()), ...this.pending];
		const filter = stateFilter(this.composerText());
		this.rows = filter ? all.filter(filter) : all;
		const bands = buildBands(this.rows, this.viewMode, (p) => this.shorten(p));
		this.items = this.layoutItems(bands);
		// Until the user moves, the highlight follows rows as they arrive: this window's own
		// first (as when Claude Code opens with the session you came from selected), else the top.
		const current = this.items.find((item) => item.key === this.selectedKey);
		if (!current || (!this.userMoved && current.kind !== "row")) {
			const rows = this.items.filter((item) => item.kind === "row");
			this.selectedKey = (rows.find((item) => item.row.self) ?? rows[0] ?? this.items[0])?.key;
		}
		this.syncSpinner();
		this.syncTitle();
	}

	/** Bands → selectable items. The Completed band folds into `… N more` when it would push the
	 *  live bands off screen; failures always stay visible. */
	private layoutItems(bands: Band[]): Item[] {
		const items: Item[] = [];
		const visible = bands.filter((band) => band.fixed || band.rows.length > 0);
		const liveLines = visible
			.filter((band) => band.key !== "completed")
			.reduce((sum, band) => sum + 2 + (this.collapsed.has(band.key) ? 0 : band.rows.length), 0);
		const room = Math.max(3, this.bodyBudget() - liveLines - 2);
		for (const band of visible) {
			items.push({ kind: "header", key: `band:${band.key}`, band });
			if (this.collapsed.has(band.key)) continue;
			let rows = band.rows;
			let hidden = 0;
			if (band.key === "completed" && !this.expanded.has(band.key) && rows.length > room) {
				const keep = new Set(rows.slice(0, room - 1).map((r) => r.id));
				for (const row of rows) if (row.state === "failed" || row.self) keep.add(row.id);
				hidden = rows.length - keep.size;
				rows = rows.filter((r) => keep.has(r.id));
			}
			for (const row of rows) items.push({ kind: "row", key: row.id, band, row });
			if (hidden > 0) items.push({ kind: "more", key: `more:${band.key}`, band, hidden });
		}
		return items;
	}

	private bodyBudget(): number {
		return Math.max(6, this.opts.ui.terminal.rows - this.headerLines().length - 5);
	}

	private syncSpinner(): void {
		const spinning = this.rows.some((row) => row.state === "working" && row.alive);
		if (spinning && !this.spinTimer && !this.closed) {
			this.spinTimer = setInterval(() => {
				this.frame = (this.frame + 1) % SPINNER.length;
				this.render_();
			}, 120);
		} else if (!spinning && this.spinTimer) {
			clearInterval(this.spinTimer);
			this.spinTimer = undefined;
		}
	}

	private syncTitle(): void {
		const needs = countRows(this.rows).needs;
		const title = needs > 0 ? `${needs} awaiting input · pi agents` : "pi agents";
		if (title !== this.lastTitle && !this.closed) {
			this.lastTitle = title;
			this.opts.setTitle?.(title);
		}
	}

	private get selected(): Item | undefined {
		return this.items.find((item) => item.key === this.selectedKey);
	}

	private get selectedRow(): AgentRow | undefined {
		const item = this.selected;
		return item?.kind === "row" ? item.row : undefined;
	}

	private shorten(path: string): string {
		const home = this.opts.home;
		return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	}

	/** Where a new session runs: the selected directory when grouped by directory, else here. */
	private dispatchCwd(): string {
		if (this.viewMode !== "directory") return this.opts.cwd;
		const item = this.selected;
		if (item?.kind === "row") return item.row.cwd;
		if (item?.band.key.startsWith("dir:")) return item.band.key.slice(4);
		return this.opts.cwd;
	}

	// ---- actions -------------------------------------------------------------------------

	private move(delta: number, rowsOnly = false): void {
		const candidates = rowsOnly ? this.items.filter((i) => i.kind === "row") : this.items;
		if (candidates.length === 0) return;
		const at = candidates.findIndex((i) => i.key === this.selectedKey);
		const next = Math.max(0, Math.min(candidates.length - 1, (at === -1 ? 0 : at) + delta));
		this.selectedKey = candidates[next].key;
		this.userMoved = true;
		this.disarm();
		this.reply.setValue("");
		this.render_();
	}

	private async dispatch(open: boolean): Promise<void> {
		const task = this.composerText().trim();
		if (task.length < 4) {
			this.say("Too short — describe the task");
			return;
		}
		const cwd = this.dispatchCwd();
		const model = this.dispatchModel;
		this.setComposer("");
		if (open && this.opts.onCreateAndOpen && cwd === this.opts.cwd) {
			this.teardown();
			this.opts.onCreateAndOpen(cwd, model, task);
			return;
		}
		const placeholder: AgentRow = {
			id: `pending:${Date.now()}`,
			label: labelFromTask(task),
			cwd,
			state: "working",
			alive: true,
			detail: "starting…",
			pinned: false,
			self: false,
			elsewhere: false,
			createdAt: new Date().toISOString(),
		};
		this.pending.push(placeholder);
		this.selectedKey = placeholder.id;
		this.recompute();
		this.render_();
		try {
			const instance = await this.opts.client.spawn({ cwd, label: placeholder.label, prompt: task, model });
			if (instance && this.selectedKey === placeholder.id) this.selectedKey = instance.id;
			if (open && instance) {
				this.pending = this.pending.filter((p) => p !== placeholder);
				await this.refresh();
				const row = this.rows.find((r) => r.id === instance.id);
				if (row) void this.open(row);
			}
		} catch (error) {
			this.say(`Couldn't start a new session — ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			this.pending = this.pending.filter((p) => p !== placeholder);
			await this.refresh();
		}
	}

	/** Enter / →: this window switches to the session; the one here keeps running in the background. */
	private async open(row: AgentRow): Promise<void> {
		if (row.self) {
			this.close();
			return;
		}
		if (row.elsewhere) {
			this.say("Can't attach — this session is running in another terminal");
			return;
		}
		if (row.id.startsWith("pending:") || !row.sessionFile) {
			this.say("Still starting — try again in a moment");
			return;
		}
		const exists = this.opts.fileExists ?? existsSync;
		this.opening = row.id;
		this.render_();
		// A fresh child reports its session file before the first turn has written it.
		for (let i = 0; i < 40 && !exists(row.sessionFile) && this.opening === row.id; i++) {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		if (this.opening !== row.id) return; // esc cancelled
		this.opening = undefined;
		if (!exists(row.sessionFile)) {
			this.say("Still starting — try again in a moment");
			return;
		}
		this.teardown();
		if (row.alive) {
			try {
				await this.opts.client.stop(row.id);
			} catch {
				// The file is append-only; opening it is safe either way.
			}
		}
		this.opts.onOpen(row.sessionFile, row.cwd);
	}

	private disarm(): void {
		if (this.armed) clearTimeout(this.armed.timer);
		this.armed = undefined;
	}

	private arm(key: string): void {
		this.disarm();
		this.armed = {
			key,
			timer: setTimeout(() => {
				this.armed = undefined;
				this.render_();
			}, ARM_MS),
		};
		this.render_();
	}

	/** ctrl+x: stop a running session (first press), delete it (second press within 2s). */
	private async stopOrDelete(): Promise<void> {
		const item = this.selected;
		if (!item || item.kind === "more") return;
		if (item.kind === "header") {
			const targets = item.band.rows.filter((r) => !r.self && !r.elsewhere && !r.id.startsWith("pending:"));
			if (targets.length === 0) return;
			if (this.armed?.key === item.key) {
				this.disarm();
				await Promise.all(targets.map((r) => this.opts.client.delete(r.id).catch(() => undefined)));
				await this.refresh();
				return;
			}
			this.arm(item.key);
			this.say(`ctrl+x again to delete all ${targets.length} in ${item.band.title}`, "error");
			return;
		}
		const row = item.row;
		if (row.self) {
			this.say("Can't stop or delete — this is the session you're in (esc returns to it)");
			return;
		}
		if (row.elsewhere) {
			this.say("Can't stop or delete — this session is running in another terminal");
			return;
		}
		if (row.id.startsWith("pending:")) return;
		if (this.armed?.key === row.id) {
			this.disarm();
			try {
				await this.opts.client.delete(row.id);
				if (this.mode === "peek") this.mode = "list";
			} catch (error) {
				this.say(`not deleted · ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			await this.refresh();
			return;
		}
		this.arm(row.id);
		if (row.alive) {
			try {
				await this.opts.client.stop(row.id);
			} catch {
				// The second press deletes regardless; the daemon stops it then.
			}
			await this.refresh();
		}
	}

	private async togglePin(): Promise<void> {
		const row = this.selectedRow;
		if (!row) return;
		if (row.self || row.id.startsWith("pending:")) {
			this.say("Only background sessions can be pinned");
			return;
		}
		await this.opts.client.setMeta(row.id, { pinned: !row.pinned }).catch(() => this.say("Couldn't pin"));
		await this.refresh();
	}

	/** shift+↑/↓ within a band: renumber the band and persist the new order. */
	private async reorder(delta: number): Promise<void> {
		const item = this.selected;
		if (item?.kind !== "row" || item.row.self) return;
		const rows = item.band.rows.filter((r) => !r.self && !r.id.startsWith("pending:"));
		const at = rows.findIndex((r) => r.id === item.row.id);
		const to = at + delta;
		if (at === -1 || to < 0 || to >= rows.length) return;
		[rows[at], rows[to]] = [rows[to], rows[at]];
		try {
			await Promise.all(rows.map((r, i) => this.opts.client.setMeta(r.id, { sortOrder: i })));
		} catch (error) {
			this.say(`Couldn't save order — ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		await this.refresh();
	}

	private startRename(): void {
		const row = this.selectedRow;
		if (!row || row.self || row.id.startsWith("pending:")) {
			this.say(row?.self ? "Rename this session with /name" : "Select a session to rename");
			return;
		}
		this.renameInput.setValue(row.label);
		this.renameInput.handleInput("\x05"); // ctrl+e: cursor to the end, after the current name
		this.mode = "rename";
		this.render_();
	}

	private async commitRename(): Promise<void> {
		const row = this.selectedRow;
		const name = this.renameInput.getValue().trim();
		if (!row || !name) {
			this.mode = "list";
			this.render_();
			return;
		}
		if (this.rows.some((r) => r.id !== row.id && r.label === name)) {
			this.say(`Another session is already named "${name}"`);
			return;
		}
		this.mode = "list";
		await this.opts.client.rename(row.id, name).catch(() => this.say("Couldn't rename"));
		await this.refresh();
	}

	private async openResumePicker(): Promise<void> {
		this.mode = "resume";
		this.pastLoading = true;
		this.pastIndex = 0;
		this.render_();
		try {
			const listed = new Set(this.rows.map((r) => r.sessionFile).filter(Boolean));
			const past = (await this.opts.loadPastSessions?.(this.opts.cwd)) ?? [];
			this.past = past.filter((p) => !listed.has(p.sessionFile));
		} catch {
			this.past = [];
			this.say("Couldn't load past sessions — press esc, then try /resume again", "error");
		}
		this.pastLoading = false;
		this.render_();
	}

	private async resumePast(past: PastSession): Promise<void> {
		this.mode = "list";
		try {
			const instance = await this.opts.client.spawn({
				cwd: past.cwd,
				label: past.label,
				sessionFile: past.sessionFile,
				model: this.dispatchModel,
			});
			if (instance) this.selectedKey = instance.id;
		} catch (error) {
			this.say(`Couldn't resume — ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		await this.refresh();
	}

	/** Slash commands that run in agent view itself; anything else needs a real session. */
	private runViewCommand(text: string): void {
		const [command, ...rest] = text.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		this.setComposer("");
		switch (command) {
			case "exit":
			case "quit":
				this.close();
				return;
			case "resume":
			case "continue":
				void this.openResumePicker();
				return;
			case "model": {
				const slash = arg.indexOf("/");
				if (slash <= 0 || slash === arg.length - 1) {
					this.say("Usage: /model <provider>/<model>");
					return;
				}
				this.dispatchModel = { provider: arg.slice(0, slash), id: arg.slice(slash + 1) };
				this.say(`Model set to ${arg} (session-scoped, not persisted)`, "dim");
				return;
			}
			default:
				this.setComposer(text);
				this.say(`/${command} isn't available in agent view — attach to a session to run it`);
		}
	}

	private async sendReply(row: AgentRow): Promise<void> {
		const text = this.reply.getValue().trim();
		if (!text) {
			void this.open(row);
			return;
		}
		if (row.self) {
			this.teardown();
			this.opts.onSelfReply?.(text);
			this.opts.onClose();
			return;
		}
		const needs = row.needs;
		try {
			if (needs?.method === "select") {
				const options = needs.options ?? [];
				const n = Number.parseInt(text, 10);
				const choice =
					n >= 1 && n <= options.length
						? options[n - 1]
						: options.find((o) => o.toLowerCase() === text.toLowerCase());
				if (!choice) {
					this.say(`press 1-${options.length} to choose, or enter with an empty reply to open it`);
					return;
				}
				await this.opts.client.answer(row.id, needs.requestId, { value: choice });
			} else if (needs?.method === "confirm") {
				const yes = /^(y|yes|1)$/i.test(text);
				const no = /^(n|no|2)$/i.test(text);
				if (!yes && !no) {
					this.say("answer y or n");
					return;
				}
				await this.opts.client.answer(row.id, needs.requestId, { confirmed: yes });
			} else if (needs) {
				await this.opts.client.answer(row.id, needs.requestId, { value: text });
			} else if (row.alive) {
				await this.opts.client.reply(row.id, text, row.state === "working");
			} else {
				// Not running: restart it from its conversation with the reply as the next prompt.
				await this.opts.client.spawn({
					cwd: row.cwd,
					sessionFile: row.sessionFile,
					prompt: text,
					model: this.dispatchModel,
				});
			}
			this.reply.setValue("");
		} catch (error) {
			this.say(`Couldn't send — ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		await this.refresh();
	}

	private async answerOption(row: AgentRow, n: number): Promise<void> {
		const needs = row.needs;
		if (!needs) return;
		try {
			if (needs.method === "select") {
				const choice = needs.options?.[n - 1];
				if (!choice) return;
				await this.opts.client.answer(row.id, needs.requestId, { value: choice });
			} else if (needs.method === "confirm" && (n === 1 || n === 2)) {
				await this.opts.client.answer(row.id, needs.requestId, { confirmed: n === 1 });
			} else return;
		} catch (error) {
			this.say(`Couldn't answer — ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		await this.refresh();
	}

	// ---- input ---------------------------------------------------------------------------

	private isEnter(data: string): boolean {
		return getKeybindings().matches(data, "tui.input.submit") || data === "\r" || data === "\n";
	}

	private isEsc(data: string): boolean {
		return getKeybindings().matches(data, "tui.select.cancel");
	}

	handleInput(data: string): void {
		if (this.mode === "help") {
			if (this.isEsc(data) || matchesKey(data, "?") || matchesKey(data, "shift+?")) {
				this.mode = "list";
				this.render_();
			}
			return;
		}
		if (this.mode === "resume") {
			this.handleResumeInput(data);
			return;
		}
		if (this.mode === "rename") {
			this.handleRenameInput(data);
			return;
		}
		if (this.mode === "peek") {
			this.handlePeekInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleResumeInput(data: string): void {
		const kb = getKeybindings();
		if (this.isEsc(data)) this.mode = "list";
		else if (kb.matches(data, "tui.select.up")) this.pastIndex = Math.max(0, this.pastIndex - 1);
		else if (kb.matches(data, "tui.select.down")) this.pastIndex = Math.min(this.past.length - 1, this.pastIndex + 1);
		else if (this.isEnter(data) && this.past[this.pastIndex]) void this.resumePast(this.past[this.pastIndex]);
		this.render_();
	}

	private handleRenameInput(data: string): void {
		if (this.isEsc(data)) this.mode = "list";
		else if (this.isEnter(data)) void this.commitRename();
		else this.renameInput.handleInput(data);
		this.render_();
	}

	private handlePeekInput(data: string): void {
		const kb = getKeybindings();
		const row = this.selectedRow;
		const empty = this.reply.getValue() === "";
		if (!row || this.isEsc(data) || (empty && matchesKey(data, "space"))) {
			this.mode = "list";
			this.reply.setValue("");
			this.render_();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1, true);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1, true);
			return;
		}
		if (matchesKey(data, "ctrl+x")) {
			void this.stopOrDelete();
			return;
		}
		if (empty && matchesKey(data, "right")) {
			void this.open(row);
			return;
		}
		if (this.isEnter(data)) {
			void this.sendReply(row);
			return;
		}
		if (empty && row.needs && /^[1-9]$/.test(data)) {
			void this.answerOption(row, Number(data));
			return;
		}
		this.reply.handleInput(data);
		this.render_();
	}

	private handleListInput(data: string): void {
		const kb = getKeybindings();
		const text = this.composerText();
		const item = this.selected;

		if (matchesKey(data, "ctrl+c")) {
			if (text) {
				this.setComposer("");
				this.recompute();
			} else if (Date.now() - this.ctrlCArmedAt < ARM_MS) {
				this.close();
				return;
			} else {
				this.ctrlCArmedAt = Date.now();
				const running = this.rows.filter((r) => r.alive && !r.self).length;
				this.say(
					`Press Ctrl-C again to exit · ${running} agent${running === 1 ? "" : "s"} will keep running`,
					"dim",
				);
			}
			this.render_();
			return;
		}
		if (this.isEsc(data)) {
			if (this.opening) this.opening = undefined;
			else if (this.armed) this.disarm();
			else if (text) {
				this.setComposer("");
				this.recompute();
			} else {
				this.close();
				return;
			}
			this.render_();
			return;
		}
		if (kb.matches(data, "tui.input.newLine") || matchesKey(data, "ctrl+j") || matchesKey(data, "shift+enter")) {
			this.composerLines.push(this.composer.getValue());
			this.composer.setValue("");
			this.recompute();
			this.render_();
			return;
		}
		if (matchesKey(data, "backspace") && this.composer.getValue() === "" && this.composerLines.length > 0) {
			this.setComposer(this.composerLines.join("\n"));
			this.recompute();
			this.render_();
			return;
		}
		if (matchesKey(data, "ctrl+g")) {
			void this.editExternally();
			return;
		}
		if (matchesKey(data, "ctrl+enter") || matchesKey(data, "alt+enter")) {
			if (text) void this.dispatch(true);
			return;
		}
		if (this.isEnter(data)) {
			if (text.startsWith("/")) {
				this.runViewCommand(text.trim());
				return;
			}
			if (text && !stateFilter(text)) {
				void this.dispatch(false);
				return;
			}
			if (!item) return;
			if (item.kind === "header") {
				if (this.collapsed.has(item.band.key)) this.collapsed.delete(item.band.key);
				else this.collapsed.add(item.band.key);
				this.recompute();
			} else if (item.kind === "more") {
				this.expanded.add(item.band.key);
				this.recompute();
			} else void this.open(item.row);
			this.render_();
			return;
		}
		if (matchesKey(data, "shift+up")) {
			void this.reorder(-1);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			void this.reorder(1);
			return;
		}
		if (kb.matches(data, "tui.select.up") || matchesKey(data, "ctrl+p")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || matchesKey(data, "ctrl+n")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.move(-10);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.move(10);
			return;
		}
		if (matchesKey(data, "ctrl+x")) {
			void this.stopOrDelete();
			return;
		}
		if (matchesKey(data, "ctrl+t")) {
			void this.togglePin();
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			this.startRename();
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.viewMode = this.viewMode === "state" ? "directory" : "state";
			this.opts.saveViewMode?.(this.viewMode);
			this.recompute();
			this.render_();
			return;
		}
		for (let n = 1; n <= 9; n++) {
			if (matchesKey(data, `alt+${n}` as Parameters<typeof matchesKey>[1])) {
				const cwd = item?.kind === "row" ? item.row.cwd : this.opts.cwd;
				const row = this.items.flatMap((i) =>
					i.kind === "row" && i.row.cwd === cwd && !i.row.id.startsWith("pending:") ? [i.row] : [],
				)[n - 1];
				if (row) void this.open(row);
				return;
			}
		}
		if (!text) {
			if (matchesKey(data, "home")) {
				this.move(-this.items.length);
				return;
			}
			if (matchesKey(data, "end")) {
				this.move(this.items.length);
				return;
			}
			if (matchesKey(data, "right") && item?.kind === "row") {
				void this.open(item.row);
				return;
			}
			if (matchesKey(data, "space") && item?.kind === "row") {
				this.mode = "peek";
				this.reply.setValue("");
				this.render_();
				return;
			}
			if (matchesKey(data, "?") || matchesKey(data, "shift+?")) {
				this.mode = "help";
				this.render_();
				return;
			}
		}
		this.disarm();
		this.composer.handleInput(data);
		this.recompute();
		// A filter being typed selects its first match, not whatever header survived it.
		if (stateFilter(this.composerText())) {
			this.selectedKey = this.items.find((i) => i.kind === "row")?.key ?? this.selectedKey;
		}
		this.render_();
	}

	invalidate(): void {}

	// ---- test seams ----------------------------------------------------------------------

	setInstancesForTest(instances: InstanceSummary[]): void {
		this.instances = instances;
		this.recompute();
	}

	selectedKeyForTest(): string | undefined {
		return this.selectedKey;
	}

	// ---- render --------------------------------------------------------------------------

	private headerLines(): string[] {
		const dot = theme.fg("dim", " · ");
		const counts = countRows(this.rows);
		const summary = theme.fg(
			"dim",
			`${counts.needs} awaiting input · ${counts.working} working · ${counts.completed} completed`,
		);
		if (this.opts.ui.terminal.rows < 20) return [summary];
		const title = `${theme.bold(this.opts.appName)}${this.opts.version ? ` ${theme.fg("dim", `v${this.opts.version}`)}` : ""}`;
		const model = this.dispatchModel ? `${this.dispatchModel.provider}/${this.dispatchModel.id}` : "";
		const target = this.dispatchCwd();
		const cwd =
			target === this.opts.cwd ? theme.fg("dim", this.shorten(target)) : theme.fg("accent", this.shorten(target));
		const where = model ? `${theme.fg("dim", model)}${dot}${cwd}` : cwd;
		return [title, where, summary];
	}

	private statusLine(): string | undefined {
		if (this.notice) return theme.fg(this.notice.color, this.notice.text);
		if (this.daemonNotice) return theme.fg("warning", this.daemonNotice);
		if (this.connectionLost)
			return theme.fg("warning", "lost connection to the background service — showing the last known list");
		return undefined;
	}

	private icon(row: AgentRow): string {
		const glyph = !row.alive ? "∙" : row.state === "working" ? SPINNER[this.frame] : "✻";
		return theme.fg(ICON_COLOR[row.state], glyph);
	}

	private rowDetail(row: AgentRow): string {
		if (this.opening === row.id) return theme.fg("dim", "opening… · esc to cancel");
		if (this.armed?.key === row.id) {
			return row.state === "stopped" || !row.alive
				? theme.fg("error", row.state === "stopped" ? "stopped · ctrl+x again to delete" : "ctrl+x again to delete")
				: theme.fg("error", "ctrl+x again to delete");
		}
		const detail = sanitize(row.detail);
		if (this.viewMode === "directory") {
			return `${theme.fg(ICON_COLOR[row.state], STATE_WORDS[row.state])}${theme.fg("dim", " · ")}${detail}`;
		}
		return row.state === "idle" || row.state === "stopped" ? theme.fg("dim", detail) : detail;
	}

	private renderRow(row: AgentRow, width: number, labelWidth: number, ageWidth: number, focused: boolean): string {
		const pad = width >= 120 ? " " : "";
		const nowMs = Date.now();
		const name = truncateToWidth(sanitize(row.label), labelWidth, "…");
		const label = row.self ? theme.bold(name) : focused ? name : row.alive ? name : theme.fg("muted", name);
		const age = rowAge(row, nowMs).padStart(ageWidth);
		const fixed = visibleWidth(pad) + 2 + labelWidth + 2 + 2 + ageWidth;
		const detailWidth = Math.max(0, width - fixed);
		const detail = truncateToWidth(this.rowDetail(row), detailWidth, "…");
		const line =
			`${pad}${this.icon(row)} ${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(name)))}  ` +
			`${detail}${" ".repeat(Math.max(0, detailWidth - visibleWidth(detail)))}  ${theme.fg("dim", age)}`;
		const fitted = truncateToWidth(line, width);
		if (!focused) return fitted;
		return theme.bg("userMessageBg", `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`);
	}

	private renderBody(width: number): { lines: string[]; focusLine: number } {
		const lines: string[] = [];
		let focusLine = 0;
		const rows = this.items.filter((i): i is Extract<Item, { kind: "row" }> => i.kind === "row").map((i) => i.row);
		const labelWidth = Math.min(
			Math.max(12, ...rows.map((r) => Math.min(visibleWidth(sanitize(r.label)), 40))),
			Math.max(40, Math.floor(width / 3)),
		);
		const ageWidth = Math.max(2, ...rows.map((r) => rowAge(r, Date.now()).length));
		const onlySelf = this.rows.length === 1 && this.rows[0].self;
		if (this.rows.length === 0 && !stateFilter(this.composerText())) {
			lines.push(
				theme.fg("text", "Nothing running in the background."),
				theme.fg(
					"dim",
					"Hand off a task and it keeps working while you do something else — even if you close this terminal.",
				),
				theme.fg("dim", "Start one by describing a task below, or bring a past session back with /resume."),
			);
			return { lines: lines.flatMap((l) => wrapTextWithAnsi(l, width)), focusLine };
		}
		if (onlySelf) {
			lines.push(
				...wrapTextWithAnsi(
					theme.fg(
						"dim",
						"A different way to work: hand off a bigger task than you would chat through, and it is organized in the sections below so you know when it needs you.",
					),
					width,
				),
				"",
			);
		}
		if (this.rows.length === 0) {
			lines.push(theme.fg("dim", "no sessions match"));
			return { lines, focusLine };
		}
		const helper: Record<string, string> = {
			needs: "Sessions that have a question or need your decision land here",
			working: "Sessions actively working — they keep running even if you close the terminal",
			completed: "Finished sessions wait here for you to review",
		};
		let first = true;
		for (const item of this.items) {
			const focused = item.key === this.selectedKey;
			if (focused) focusLine = lines.length;
			if (item.kind === "header") {
				if (!first) lines.push("");
				first = false;
				if (focused) focusLine = lines.length;
				const collapsed = this.collapsed.has(item.band.key);
				const title = focused ? theme.bold(item.band.title) : theme.fg("dim", item.band.title);
				const count = collapsed ? theme.fg("dim", ` ${item.band.rows.length}`) : "";
				const armed = this.armed?.key === item.key ? theme.fg("error", "  ctrl+x again to delete all") : "";
				lines.push(truncateToWidth(`${title}${count}${armed}`, width));
				if (!collapsed && item.band.rows.length === 0 && onlySelf && helper[item.band.key]) {
					lines.push(truncateToWidth(theme.fg("dim", `  ${helper[item.band.key]}`), width));
				}
			} else if (item.kind === "more") {
				const text = `  … ${item.hidden} more`;
				lines.push(focused ? theme.bg("userMessageBg", text.padEnd(width)) : theme.fg("dim", text));
			} else {
				lines.push(this.renderRow(item.row, width, labelWidth, ageWidth, focused));
			}
		}
		return { lines, focusLine };
	}

	private renderPeek(row: AgentRow, width: number): string[] {
		const inner = Math.max(10, width - 4);
		const body: string[] = [];
		const needs = row.needs;
		if (needs) {
			body.push(...wrapTextWithAnsi(theme.bold(sanitize(needs.title)), inner));
			if (needs.message) body.push(...wrapTextWithAnsi(sanitize(needs.message), inner));
			const options =
				needs.method === "select" ? (needs.options ?? []) : needs.method === "confirm" ? ["Yes", "No"] : [];
			options.slice(0, 9).forEach((option, i) => {
				body.push(truncateToWidth(`${theme.fg("dim", `${i + 1}.`)} ${sanitize(option)}`, inner));
			});
			if (options.length > 9) body.push(theme.fg("dim", `+${options.length - 9} more · enter to open`));
		} else {
			const text = row.state === "needs" && row.question ? theme.bold(sanitize(row.question)) : sanitize(row.detail);
			body.push(...wrapTextWithAnsi(text || theme.fg("dim", "(no output yet)"), inner).slice(0, 8));
		}
		body.push(theme.fg("dim", this.shorten(row.cwd)));
		const since = needs?.since ?? (row.state === "needs" ? row.finishedAt : undefined);
		if (since)
			body.push(theme.fg("warning", `waiting ${compactAge(Date.now() - (Date.parse(since) || Date.now()))}`));
		body.push("");
		const options = needs?.method === "select" ? (needs.options?.length ?? 0) : needs?.method === "confirm" ? 2 : 0;
		body.push(
			promptLine(this.reply, inner, options > 0 ? `press 1-${Math.min(options, 9)} or type your answer` : "reply"),
		);
		const border = (l: string, r: string) => theme.fg("dim", `${l}${"─".repeat(Math.max(0, width - 2))}${r}`);
		const boxed = [border("╭", "╮")];
		for (const line of body) {
			const fitted = truncateToWidth(line, inner);
			boxed.push(
				`${theme.fg("dim", "│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${theme.fg("dim", "│")}`,
			);
		}
		boxed.push(border("╰", "╯"));
		const empty = !this.reply.getValue();
		const action = empty ? (row.self ? "return" : row.alive ? "open" : "resume") : "send";
		boxed.push(
			this.hints(width, [
				["enter", action],
				empty ? ["space", "close"] : ["esc", "close"],
				["↑↓", "peek at others"],
				["ctrl+x", this.armed?.key === row.id ? "confirm" : "delete"],
			]),
		);
		return boxed;
	}

	private renderResume(width: number): string[] {
		const out = [theme.bold("Resume a past session"), ""];
		if (this.pastLoading) out.push(theme.fg("dim", "looking for past sessions…"));
		else if (this.past.length === 0) out.push(theme.fg("dim", "No past sessions to resume"));
		const nowMs = Date.now();
		const start = Math.max(0, Math.min(this.pastIndex - 5, this.past.length - 12));
		this.past.slice(start, start + 12).forEach((past, i) => {
			const focused = start + i === this.pastIndex;
			const age = compactAge(nowMs - (Date.parse(past.modifiedAt) || nowMs));
			const text = truncateToWidth(`  ${sanitize(past.label)}`, Math.max(10, width - age.length - 2), "…");
			const line = `${text}${" ".repeat(Math.max(1, width - visibleWidth(text) - age.length))}${theme.fg("dim", age)}`;
			out.push(focused ? theme.bg("userMessageBg", line) : line);
		});
		out.push("", theme.fg("dim", "↑/↓ to navigate · enter to resume as a background session · esc to close"));
		return out;
	}

	private renderHelp(width: number): string[] {
		const items: Array<[string, string]> = [
			["enter", "open"],
			["space", "peek and reply"],
			["ctrl+enter", "start and open"],
			["→", "open"],
			["alt+1-9", "open 1-9 in this directory"],
			["shift+enter", "newline"],
			["ctrl+g", "edit prompt in $EDITOR"],
			["shift+↑↓", "reorder"],
			["ctrl+r", "rename"],
			["ctrl+t", "pin to top"],
			["ctrl+s", "switch views"],
			["ctrl+x", "stop · twice to delete"],
			["s:<state>", "filter"],
			["/resume", "bring a past session back"],
			["/model", "set the model for new sessions"],
			["esc", "go back"],
			["ctrl+c ×2", "quit"],
			["?", "close"],
		];
		const column = Math.max(24, Math.floor(width / 2));
		const out = [theme.bold("Shortcuts"), ""];
		for (let i = 0; i < items.length; i += 2) {
			const cell = ([key, action]: [string, string]) =>
				`${theme.fg("accent", key)} ${theme.fg("dim", `to ${action}`)}`;
			const left = cell(items[i]);
			const right = items[i + 1] ? cell(items[i + 1]) : "";
			out.push(truncateToWidth(`${left}${" ".repeat(Math.max(2, column - visibleWidth(left)))}${right}`, width));
		}
		return out;
	}

	private hints(width: number, items: Array<[string, string] | undefined>): string {
		const parts = items.filter((i): i is [string, string] => !!i).map(([key, action]) => `${key} to ${action}`);
		let line = parts.join(" · ");
		while (parts.length > 1 && visibleWidth(line) > width) {
			parts.splice(parts.length - 2, 1);
			line = parts.join(" · ");
		}
		return truncateToWidth(theme.fg("dim", line), width);
	}

	private listFooter(width: number): string {
		const text = this.composerText();
		const item = this.selected;
		if (text) {
			if (stateFilter(text)) return this.hints(width, [["esc", "clear"]]);
			return this.hints(width, [
				["enter", text.startsWith("/") ? "run" : "create"],
				text.startsWith("/") ? undefined : ["ctrl+enter", "start and open"],
				["esc", "clear"],
			]);
		}
		let enter: [string, string] | undefined;
		if (item?.kind === "header") enter = ["enter", this.collapsed.has(item.band.key) ? "expand" : "collapse"];
		else if (item?.kind === "more") enter = ["enter", "show all"];
		else if (item?.kind === "row") enter = ["enter", item.row.self ? "return" : item.row.alive ? "open" : "resume"];
		const x: [string, string] | undefined =
			!item || width < 80 || item.kind === "more" || (item?.kind === "row" && item.row.self)
				? undefined
				: [
						"ctrl+x",
						item?.kind === "header" ? "delete all" : item?.kind === "row" && item.row.alive ? "stop" : "delete",
					];
		return this.hints(width, [
			enter,
			width >= 55 && item?.kind === "row" ? ["space", "reply"] : undefined,
			x,
			["?", "for shortcuts"],
		]).replace("? to for shortcuts", "? for shortcuts");
	}

	render(width: number): string[] {
		const rows = this.opts.ui.terminal.rows;
		const header = [...this.headerLines()];
		const status = this.statusLine();
		if (status) header.push(truncateToWidth(status, width));
		header.push("");

		let footer: string[];
		if (this.mode === "peek" && this.selectedRow) footer = this.renderPeek(this.selectedRow, width);
		else if (this.mode === "rename") {
			const rule = theme.fg("dim", "─".repeat(width));
			footer = [
				rule,
				`${theme.fg("dim", "rename ")}${promptLine(this.renameInput, width - 7, "")}`,
				rule,
				this.hints(width, [
					["enter", "save"],
					["esc", "cancel"],
				]),
			];
		} else {
			const rule = theme.fg("dim", "─".repeat(width));
			const above = this.composerLines
				.slice(-5)
				.map((line, i, shown) =>
					truncateToWidth(`${i === 0 && shown.length === this.composerLines.length ? "❯" : " "} ${line}`, width),
				);
			const current = promptLine(this.composer, width, above.length ? "" : "describe a task for a new session");
			footer = [rule, ...above, above.length ? current.replace(/^❯/, " ") : current, rule, this.listFooter(width)];
		}

		let body: string[];
		let focusLine = 0;
		if (this.mode === "help") body = this.renderHelp(width);
		else if (this.mode === "resume") body = this.renderResume(width);
		else ({ lines: body, focusLine } = this.renderBody(width));

		const budget = Math.max(1, rows - header.length - footer.length);
		let start = 0;
		if (body.length > budget) start = Math.min(Math.max(0, focusLine - Math.floor(budget / 2)), body.length - budget);
		const windowed = body.slice(start, start + budget).map((line) => truncateToWidth(line, width));
		return [...header, ...windowed, ...Array(Math.max(0, budget - windowed.length)).fill(""), ...footer];
	}
}
