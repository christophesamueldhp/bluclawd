import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type KeybindingsManager,
	type KeyId,
	matchesKey,
	parseColor,
	SelectList,
	stripTerminalSequences,
	styleText,
	styleTextWithAnsi,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	currentDaemonBuildId,
	type InstanceSummary,
	type OrchestratorClient,
} from "../../daemon/orchestrator-client.ts";
import {
	type AgentRow,
	type Band,
	buildBands,
	collectRuns,
	compactAge,
	countRows,
	livePanesWarning,
	nameScore,
	queryFilter,
	type RowState,
	rowAge,
	STATE_WORDS,
	stateBandOf,
	type ViewMode,
} from "../../daemon/rows.ts";
import { mascotGlyphs, REST, renderMascot } from "../_shared/mascot.ts";
import { PasteTokens, shouldCollapse } from "../_shared/paste-tokens.ts";
import { resolveToCwd } from "../_shared/path-resolve.ts";
import { activeTheme, theme } from "../_shared/theme.ts";
import { wakeupClock } from "../background-bash/wakeups.ts";
import { type AgentClipboard, readAgentClipboard } from "./clipboard.ts";
import { Roster } from "./roster.ts";
import { bandTargets, deletable, type OpenOutcome, type PaneOps, RowActions, stoppable } from "./row-actions.ts";

export type { PaneOps } from "./row-actions.ts";

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
	model?: { provider: string; id: string };
	modelName?: string;
	mode?: string;
	cwd: string;
	home: string;
	self?: () => InstanceSummary | undefined;
	onClose: () => void;
	listModels?: () => Array<{ provider: string; id: string }>;
	isKnownCommand?: (name: string) => boolean;
	onStopSelf?: () => void;
	onRenameSelf?: (name: string) => void;
	panes: PaneOps;
	onSelfReply?: (text: string) => void;
	externalEditor: () => string;
	keybindings?: KeybindingsManager;
	readClipboard?: () => Promise<AgentClipboard>;
	loadPastSessions?: (cwd: string) => Promise<PastSession[]>;
	loadViewMode?: () => ViewMode | undefined;
	saveViewMode?: (mode: ViewMode) => void;
	setTitle?: (title: string | undefined) => void;
	hide?: string;
	onDrawn?: () => void;
	instances?: InstanceSummary[];
}

type Item =
	| { kind: "header"; key: string; band: Band }
	| { kind: "row"; key: string; band: Band; row: AgentRow; run?: true }
	| { kind: "more"; key: string; band: Band; hidden: number }
	| { kind: "runs"; key: string; band: Band; row: AgentRow; count: number };

type Mode = "list" | "peek" | "rename" | "resume" | "help" | "model";

const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER = [...FRAMES, ...[...FRAMES].reverse()];
const ARM_MS = 2000;
const CTRL_C_MS = 800;
const PEEK_LINES = 500;
const FRAME_FLUSH_MS = 30;
const VIEW_COMMANDS: Array<{ name: string; arg?: string; description: string }> = [
	{ name: "cd", arg: "<dir>", description: "Set the directory new sessions start in" },
	{ name: "model", arg: "<name>", description: "Set the model for new sessions" },
	{ name: "resume", description: "Resume a past session" },
	{ name: "exit", description: "Leave agent view; sessions keep running" },
];
type Completion = { value: string; label: string };
const MENU_ROWS = 8;
export const EXIT_WORDS = new Set(["exit", "quit", ":q", ":q!", ":wq", ":wq!"]);

type Color = Parameters<typeof theme.fg>[0];

const CC_DARK: Partial<Record<Color | "userMessageBg", string>> = {
	text: "#ffffff",
	muted: "#999999",
	success: "#4eba65",
	warning: "#ffc107",
	error: "#ff6b80",
	accent: "#00c0e8",
	userMessageBg: "#373737",
};

const lightThemes = new WeakMap<object, boolean>();

function isLightTheme(): boolean {
	const current = activeTheme();
	let light = lightThemes.get(current);
	if (light === undefined) {
		const ansi = current.getBgAnsi("userMessageBg");
		const rgb = /48;2;(\d+);(\d+);(\d+)/.exec(ansi);
		const n = /48;5;(\d+)/.exec(ansi);
		const [r, g, b] = rgb ? rgb.slice(1).map(Number) : n ? xterm256(Number(n[1])) : [0, 0, 0];
		light = 0.299 * r + 0.587 * g + 0.114 * b > 128;
		lightThemes.set(current, light);
	}
	return light;
}

function xterm256(n: number): [number, number, number] {
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return [v, v, v];
	}
	if (n < 16) return n === 7 || n === 15 ? [255, 255, 255] : [0, 0, 0];
	const i = n - 16;
	const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
	return [level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6)];
}

const cc = {
	fg(color: Color, text: string): string {
		const hex = isLightTheme() ? undefined : CC_DARK[color];
		return hex ? styleText(text, { fg: parseColor(hex) }, theme.getColorMode()) : theme.fg(color, text);
	},
	bg(color: "userMessageBg", text: string): string {
		const hex = isLightTheme() ? undefined : CC_DARK[color];
		return hex ? styleText(text, { bg: parseColor(hex) }, theme.getColorMode()) : theme.bg(color, text);
	},
};

const STATE_COLOR: Record<RowState, Color> = {
	working: "accent",
	needs: "warning",
	idle: "muted",
	done: "success",
	failed: "error",
	stopped: "warning",
};

const MASCOT_MIN_COLUMNS = 70;

function faint(text: string): string {
	return styleTextWithAnsi(text, undefined, undefined, { dim: true });
}

function promptLine(input: Input, width: number, placeholder: string): string {
	if (!input.getValue()) {
		const [first = " ", ...rest] = [...placeholder];
		return truncateToWidth(
			`${cc.fg("muted", "❯")} ${styleTextWithAnsi(cc.fg("muted", first), undefined, undefined, { inverse: true })}${cc.fg("muted", rest.join(""))}`,
			width,
		);
	}
	const line = input.render(width)[0] ?? "";
	return line.startsWith("> ") ? `❯ ${line.slice(2)}` : line;
}

export class AgentView implements Component, Focusable {
	focused = false;

	private readonly opts: AgentViewOptions;
	private readonly actions: RowActions;
	private readonly composer = new Input();
	private composerLines: string[] = [];
	private readonly pastes = new PasteTokens();
	private readonly roster: Roster;
	private readonly insertIntoComposer: (text: string) => void;
	private pasting = false;
	private draftVersion = 0;
	private editing = false;
	private readonly reply = new Input();
	private readonly renameInput = new Input();
	private readonly modelSearch = new Input();
	private modelPicker: SelectList | undefined;
	private rows: AgentRow[] = [];
	private allRows: AgentRow[] = [];
	private onboarding = false;
	private items: Item[] = [];
	private selectedKey: string | undefined;
	private mode: Mode = "list";
	private renameFrom: "list" | "peek" = "list";
	private viewMode: ViewMode;
	private readonly collapsed = new Set<string>();
	private readonly expanded = new Set<string>();
	private runs = new Map<string, AgentRow[]>();
	private readonly openRuns = new Set<string>();
	private ownRunShown = false;
	private armed: { key: string; timer: ReturnType<typeof setTimeout> } | undefined;
	private ctrlCArmedAt = 0;
	private notice: { text: string; kind: "hint" | "error" } | undefined;
	private justKilled: string | undefined;
	private readonly replyDrafts = new Map<string, string>();
	private replyError: string | undefined;
	private replying = false;
	private scrollStart = 0;
	private lastIndex = 0;
	private beforeFilter: string | undefined;
	private daemonNotice = "";
	private opening: string | undefined;
	private dispatchModel: { provider: string; id: string } | undefined;
	private dispatchDir: string | undefined;
	private suggestionIndex = 0;
	private argMenu: { text: string; items: Completion[] } | undefined;
	private past: PastSession[] = [];
	private pastIndex = 0;
	private pastLoading = false;
	private pastError = false;
	private frame = 0;
	private spinTimer: ReturnType<typeof setInterval> | undefined;
	private peekOutput: { shell: string; lines: string[] } | undefined;
	private searchedFor: string | undefined;
	private closed = false;
	private loaded = false;
	private drawn = false;
	private leaving = false;
	private lastTitle = "";
	private userMoved = false;

	static show(opts: AgentViewOptions): AgentView {
		const view = new AgentView(opts);
		void view.onShow();
		return view;
	}

	constructor(opts: AgentViewOptions) {
		this.opts = opts;
		this.actions = new RowActions({
			client: opts.client,
			panes: opts.panes,
			cwd: opts.cwd,
			onStopSelf: opts.onStopSelf,
		});
		this.viewMode = opts.loadViewMode?.() ?? "state";
		this.dispatchModel = opts.model;
		const composer = this.composer as unknown as { handlePaste(text: string): void };
		const insert = composer.handlePaste.bind(this.composer);
		this.insertIntoComposer = insert;
		composer.handlePaste = (text) => this.pasteIntoComposer(text, insert);
		this.roster = new Roster({
			client: opts.client,
			shells: {
				list: () => opts.panes.listShells(),
				listAsync: async () => {
					const [shells] = await Promise.all([opts.panes.listShellsAsync().catch(() => []), this.loadPeek()]);
					return shells;
				},
			},
			hide: opts.hide,
			seed: opts.instances,
			changed: () => {
				this.recompute();
				this.render_();
			},
			orderFailed: (error) =>
				this.say(`Couldn't save order — ${error instanceof Error ? error.message : String(error)}`, "error"),
		});
		this.recompute();
	}

	private pasteIntoComposer(pasted: string, insert: (text: string) => void): void {
		const text = pasted.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
		if (this.expandRepeat("text", text)) return;
		if (shouldCollapse(text)) {
			insert(this.pastes.addText(text));
			return;
		}
		this.pastes.forgetRepeatTarget();
		const [first = "", ...rest] = text.split("\n");
		insert(first);
		for (const line of rest) {
			this.composerLines.push(this.composer.getValue());
			this.composer.setValue("");
			insert(line);
		}
	}

	private expandRepeat(kind: "text" | "image", content: string, same?: (a: string, b: string) => boolean): boolean {
		const repeat = this.pastes.repeatOf(kind, content, same);
		const value = this.composer.getValue();
		if (!repeat || !value.endsWith(repeat.token)) return false;
		const lines = [...this.composerLines, value.slice(0, -repeat.token.length) + repeat.content]
			.join("\n")
			.split("\n");
		this.pastes.forgetRepeatTarget();
		const last = lines.pop() ?? "";
		this.composerLines = lines;
		this.composer.setValue(last);
		cursorToEndDuringPaste(this.composer);
		return true;
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
				if (result.restarted) this.roster.daemonRestarted();
				this.daemonNotice = result.restarted
					? ""
					: `background service is an older build — not restarted: ${result.reason ?? "unknown reason"}`;
			}
		}
		await this.refresh();
		if (this.closed) return;
		this.loaded = true;
		this.opts.ui.requestRender();
		this.roster.watch();
	}

	close(): void {
		this.teardown();
		this.opts.onClose();
	}

	private teardown(): void {
		this.closed = true;
		this.opening = undefined;
		this.roster.stop();
		if (this.spinTimer) clearInterval(this.spinTimer);
		if (this.armed) clearTimeout(this.armed.timer);
		this.spinTimer = undefined;
		this.opts.setTitle?.(undefined);
	}

	private composerText(): string {
		return [...this.composerLines, this.composer.getValue()].join("\n");
	}

	private composing(): boolean {
		const text = this.composerText();
		return !!text.trim() && !queryFilter(text);
	}

	private composerCursorAtEnd(): boolean {
		const cursor = (this.composer as unknown as { cursor?: number }).cursor;
		return cursor === undefined || cursor === this.composer.getValue().length;
	}

	private dropTrailingBackslash(): void {
		this.composer.handleInput("\x7f");
	}

	private setComposer(text: string): void {
		const lines = text.split("\n");
		this.composer.setValue(lines.pop() ?? "");
		this.composerLines = lines;
		cursorToEnd(this.composer);
	}

	private clearDraft(): void {
		this.setComposer("");
		this.pastes.clear();
		this.draftVersion++;
	}

	private async pasteClipboard(): Promise<void> {
		if (this.pasting) return;
		this.pasting = true;
		this.render_();
		const version = this.draftVersion;
		try {
			const clipboard = await (this.opts.readClipboard ?? readAgentClipboard)();
			if (this.closed || version !== this.draftVersion) return;
			if (clipboard.image) {
				const [file] = imageFiles([clipboard.image]);
				if (!this.expandRepeat("image", file, sameBytes)) {
					this.insertIntoComposer(this.pastes.addImage(file));
				}
			} else this.say("No image found in clipboard", "error");
		} catch {
			if (!this.closed) this.say("Couldn't read an image from the clipboard", "error");
		} finally {
			this.pasting = false;
			if (!this.closed) {
				this.recompute();
				this.render_();
			}
		}
	}

	private async editExternally(): Promise<void> {
		const command = this.opts.externalEditor();
		const dir = mkdtempSync(join(tmpdir(), "pi-agents-"));
		const file = join(dir, "prompt.md");
		writeFileSync(file, this.composerText(), "utf-8");
		const tui = this.opts.ui;
		this.editing = true;
		tui.stop();
		let failure: string | undefined;
		try {
			const [bin, ...args] = command.split(" ");
			const exit = await new Promise<number | NodeJS.Signals | null>((resolve) => {
				const child = spawn(bin, [...args, file], { stdio: "inherit" });
				child.on("error", () => resolve(null));
				child.on("close", (code, signal) => resolve(code ?? signal));
			});
			if (exit === 0) this.setComposer(readFileSync(file, "utf-8").replace(/\n$/, ""));
			else if (exit === null) failure = `Failed to launch external editor: ${command}`;
			else
				failure = `External editor exited with ${typeof exit === "number" ? `code ${exit}` : exit}; prompt unchanged`;
		} finally {
			rmSync(dir, { recursive: true, force: true });
			this.editing = false;
			tui.start();
			tui.requestRender(true);
		}
		this.recompute();
		if (failure) this.say(failure, "error");
		else this.render_();
	}

	private render_(): void {
		if (!this.closed && !this.editing) this.opts.ui.requestRender();
	}

	private say(text: string, kind: "hint" | "error" = "hint"): void {
		this.notice = { text, kind };
		this.render_();
	}

	refresh(): Promise<void> {
		return this.roster.refresh();
	}

	private async loadPeek(): Promise<void> {
		const peeked = () => (this.mode === "peek" ? this.selectedRow?.shell : undefined);
		const shell = peeked();
		if (!shell) return;
		const lines = await this.captureUnlessGone(shell);
		if (peeked() === shell) this.peekOutput = { shell, lines };
	}

	private async captureUnlessGone(shell: string): Promise<string[]> {
		try {
			return await this.opts.panes.captureAsync(shell, PEEK_LINES);
		} catch {
			return [];
		}
	}

	private refreshPeek(): void {
		if (this.mode === "peek" && this.selectedRow?.shell) void this.loadPeek().then(() => this.render_());
	}

	private recompute(): void {
		const { instances, rows } = this.roster.listed(this.opts.self?.());
		this.allRows = rows;
		this.runs = collectRuns(instances, this.allRows, this.opts.self?.());
		if (!this.ownRunShown)
			for (const [owner, runs] of this.runs)
				if (runs.some((run) => run.self)) {
					this.openRuns.add(owner);
					this.ownRunShown = true;
				}
		const text = this.composerText();
		const filter = queryFilter(text);
		this.rows = filter ? this.allRows.filter(filter) : this.allRows;
		this.onboarding =
			this.viewMode === "state" && !text && this.allRows.every((r) => r.self) && !this.allRows[0]?.pinned;
		const bands = buildBands(this.rows, this.viewMode, (p) => this.shorten(p), {
			launcherCwd: this.opts.cwd,
			onboarding: this.onboarding,
		});
		this.items = this.layoutItems(bands, !!filter);
		const at = this.items.findIndex((item) => item.key === this.selectedKey);
		const searching = !!filter && /^n:\S/i.test(text.trim());
		const searchChanged = searching && text !== this.searchedFor;
		this.searchedFor = searching ? text : undefined;
		if (searchChanged) {
			const best = this.items
				.filter((i): i is Extract<Item, { kind: "row" }> => i.kind === "row")
				.reduce<Extract<Item, { kind: "row" }> | undefined>(
					(top, i) => (!top || nameScore(i.row, text) > nameScore(top.row, text) ? i : top),
					undefined,
				);
			if (best) this.selectedKey = best.key;
		} else if (!this.userMoved && this.items[at]?.kind !== "row") {
			this.selectedKey = this.homeKey();
		} else if (at !== -1) this.lastIndex = at;
		else {
			this.selectedKey = this.items[Math.min(this.lastIndex, this.items.length - 1)]?.key;
		}
		if (at === -1 && (this.mode === "peek" || this.mode === "rename")) {
			this.mode = "list";
			this.say("That session is no longer listed");
		}
		this.syncSpinner();
		this.syncTitle();
	}

	private homeKey(): string | undefined {
		const rows = this.items.filter((item) => item.kind === "row");
		const self = rows.find((item) => item.row.self);
		if (self) return self.key;
		const first = rows[0];
		return (first && first.row.cwd === this.opts.cwd ? first : this.items[0])?.key;
	}

	private layoutBudget(): { compact: boolean; doneCap: number } {
		const live = this.rows.filter((r) => stateBandOf(r) !== "idle" || r.pinned);
		const used =
			live.filter((r) => !this.collapsed.has(r.pinned ? "pinned" : stateBandOf(r))).length +
			Math.max(0, new Set(live.map((r) => (r.pinned ? "pinned" : stateBandOf(r)))).size * 2 - 1);
		const free = (header: number) => this.opts.ui.terminal.rows - 8 - header - used;
		return free(4) >= 3 ? { compact: false, doneCap: free(4) } : { compact: true, doneCap: Math.max(0, free(2)) };
	}

	private layoutItems(bands: Band[], filtering: boolean): Item[] {
		const items: Item[] = [];
		const { doneCap } = this.layoutBudget();
		for (const band of bands) {
			items.push({ kind: "header", key: `band:${band.key}`, band });
			if (!filtering && this.collapsed.has(band.key)) continue;
			const rows = band.rows;
			if (band.key === "idle" && !this.expanded.has(band.key)) {
				const shown = this.foldAt(rows, doneCap);
				if (shown < rows.length) {
					for (const row of rows.slice(0, shown)) this.pushRow(items, band, row);
					items.push({ kind: "more", key: `more:${band.key}`, band, hidden: rows.length - shown });
					continue;
				}
			}
			for (const row of rows) this.pushRow(items, band, row);
		}
		return items;
	}

	private pushRow(items: Item[], band: Band, row: AgentRow): void {
		items.push({ kind: "row", key: row.id, band, row });
		const runs = this.runs.get(row.id);
		if (!runs) return;
		items.push({ kind: "runs", key: `runs:${row.id}`, band, row, count: runs.length });
		if (this.openRuns.has(row.id))
			for (const run of runs) items.push({ kind: "row", key: run.id, band, row: run, run: true });
	}

	private foldAt(rows: AgentRow[], cap: number): number {
		if (rows.length < cap + 3) return rows.length;
		let shown = Math.min(cap, rows.length);
		const ended = (r: AgentRow | undefined) => Date.parse(r?.finishedAt ?? r?.updatedAt ?? "") || 0;
		while (shown > 0 && shown < rows.length && Math.abs(ended(rows[shown - 1]) - ended(rows[shown])) <= 60_000)
			shown++;
		shown = Math.max(shown, cap);
		if (rows.length - shown < 3) return rows.length;
		if (rows.findIndex((r) => r.self) >= shown) return rows.length;
		return shown;
	}

	private syncSpinner(): void {
		const spinning =
			!!this.opening ||
			[...this.rows, ...[...this.runs.values()].flat()].some((row) => row.state === "working" && row.alive);
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
		const needs = countRows(this.allRows).needs;
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

	private dispatchCwd(): string {
		if (this.dispatchDir) return this.dispatchDir;
		if (this.viewMode !== "directory") return this.opts.cwd;
		const item = this.selected;
		if (item?.kind === "row") return item.row.cwd;
		if (item?.band.key.startsWith("dir:")) return item.band.key.slice(4);
		return this.opts.cwd;
	}

	private move(delta: number, opts: { rowsOnly?: boolean; wrap?: boolean } = {}): void {
		const candidates = opts.rowsOnly
			? this.items.filter((i) => i.kind === "row")
			: this.onboarding
				? this.items.filter((i) => i.kind !== "header")
				: this.items;
		if (candidates.length === 0) return;
		const at = candidates.findIndex((i) => i.key === this.selectedKey);
		const from = at === -1 ? 0 : at;
		const next = opts.wrap
			? (from + delta + candidates.length) % candidates.length
			: Math.max(0, Math.min(candidates.length - 1, from + delta));
		this.focus(candidates[next].key);
	}

	private focus(key: string): void {
		if (key !== this.selectedKey) this.disarm();
		this.saveReplyDraft();
		this.selectedKey = key;
		this.refreshPeek();
		this.lastIndex = Math.max(
			0,
			this.items.findIndex((i) => i.key === key),
		);
		this.userMoved = true;
		this.notice = undefined;
		this.reply.setValue(this.replyDrafts.get(key) ?? "");
		cursorToEnd(this.reply);
		this.replyError = undefined;
		this.render_();
	}

	private jumpGroup(delta: number): void {
		const headers = this.items.filter((i) => i.kind === "header");
		if (headers.length === 0) return;
		const at = this.items.findIndex((i) => i.key === this.selectedKey);
		const target =
			delta < 0
				? [...headers].reverse().find((h) => this.items.indexOf(h) < at)
				: headers.find((h) => this.items.indexOf(h) > at);
		if (target) this.focus(target.key);
	}

	private saveReplyDraft(): void {
		const key = this.selectedKey;
		if (!key) return;
		const draft = this.reply.getValue();
		if (draft) this.replyDrafts.set(key, draft);
		else this.replyDrafts.delete(key);
	}

	private async dispatch(open: boolean): Promise<void> {
		if (this.pasting) return;
		const draft = this.composerText();
		const task = this.pastes.expandText(draft).trim();
		const images = this.pastes.imagesIn(draft);
		if (task.length < 4 && images.length === 0) {
			this.say("Too short — describe the task");
			return;
		}
		const cwd = this.dispatchCwd();
		const model = this.dispatchModel;
		await this.startPane(open, draft, task, images, cwd, model);
	}

	private async startPane(
		open: boolean,
		draft: string,
		task: string,
		images: string[],
		cwd: string,
		model: { provider: string; id: string } | undefined,
	): Promise<void> {
		const started = this.actions.start(cwd, task, images, model);
		if (started.kind === "failed") {
			this.setComposer(draft);
			this.say(started.text, "error");
			return;
		}
		this.clearDraft();
		const { pane, claimed } = started;
		if (open) {
			this.leaveFor(pane);
			return;
		}
		this.selectedKey = pane;
		this.userMoved = true;
		await claimed;
		if (!this.closed) await this.refresh();
	}

	private leaveFor(pane: string): void {
		void this.opened(this.actions.switchTo(pane));
	}

	private async opened(outcome: OpenOutcome): Promise<void> {
		switch (outcome.kind) {
			case "left":
				this.close();
				return;
			case "peekOutput":
				this.mode = "peek";
				this.reply.setValue("");
				this.refreshPeek();
				this.render_();
				return;
			case "refused":
				if (outcome.text) this.say(outcome.text);
				return;
			case "failed":
				this.say(outcome.text, "error");
				await this.refresh();
				return;
			case "cancelledInBackground":
			case "done":
				await this.refresh();
		}
	}

	private startShell(command: string): void {
		let name: string;
		try {
			name = this.opts.panes.startShell(this.dispatchCwd(), command);
		} catch (error) {
			this.say(`Couldn't run it — ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		this.clearDraft();
		this.selectedKey = name;
		this.userMoved = true;
		void this.refresh();
	}

	private async open(row: AgentRow): Promise<void> {
		if (this.closed || this.opening) return;
		this.opening = row.id;
		this.render_();
		const outcome = await this.actions.open(row, () => this.closed || this.opening !== row.id);
		if (this.opening === row.id) this.opening = undefined;
		await this.opened(outcome);
	}

	private disarm(): void {
		if (this.armed) clearTimeout(this.armed.timer);
		this.armed = undefined;
		this.justKilled = undefined;
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

	private armedRowGone(): boolean {
		const armed = this.armed?.key;
		return !!armed && !this.items.some((i) => i.key === armed);
	}

	private async stopOrDelete(): Promise<void> {
		if (this.armedRowGone()) {
			this.disarm();
			this.render_();
			return;
		}
		const item = this.selected;
		if (!item || item.kind === "more" || item.kind === "runs") return;
		if (item.kind === "header") {
			const targets = bandTargets(item.band.rows);
			if (targets.length === 0 || this.composing()) return;
			if (this.armed?.key === item.key) {
				this.disarm();
				const gone = await this.actions.deleteAll(targets);
				this.roster.deleted(gone);
				const left = targets.length - gone.length;
				if (left > 0) this.say(`Couldn't delete ${left} of ${targets.length} sessions`, "error");
				await this.refresh();
				return;
			}
			this.arm(item.key);
			return;
		}
		const row = item.row;
		if (!deletable(row)) return;
		if (this.armed?.key === row.id) {
			if (item.run) return;
			this.disarm();
			this.roster.startDelete(row.id);
			const outcome = await this.actions
				.delete(row, {
					leaving: () => {
						this.leaving = true;
						this.say("Deleting…");
					},
					left: () => this.teardown(),
				})
				.finally(() => this.roster.endDelete(row.id));
			if (outcome.kind === "left") return;
			this.leaving = false;
			if (outcome.kind === "failed") this.say(outcome.text, "error");
			else {
				if (this.mode === "peek") this.mode = "list";
				this.roster.deleted([row.id]);
			}
			await this.refresh();
			return;
		}
		this.arm(row.id);
		const outcome = await this.actions.stop(row);
		if (outcome.kind === "refused") return;
		this.justKilled = row.id;
		if (outcome.kind === "failed") this.say(outcome.text, "error");
		await this.refresh();
	}

	private async togglePin(): Promise<void> {
		const row = this.selectedRow;
		if (!row) return;
		const outcome = await this.actions.pin(row);
		if (outcome.kind === "refused") {
			if (outcome.text) this.say(outcome.text);
			return;
		}
		if (outcome.kind === "failed") this.say(outcome.text, "error");
		else this.collapsed.delete("pinned");
		await this.refresh();
	}

	private reorder(delta: number): void {
		const item = this.selected;
		if (item?.kind !== "row") return;
		const shown = orderedRows(item.band);
		const at = shown.findIndex((r) => r.id === item.row.id);
		if (at === -1) return;
		if (!manuallyOrdered(item.band)) {
			this.say("Reorder in directory view (ctrl+s), or pin it");
			return;
		}
		const other = shown[at + delta];
		const band = buildBands(this.allRows, this.viewMode, (p) => p).find((b) => b.key === item.band.key);
		if (!other || !band) return;
		const rows = orderedRows(band);
		const [from, to] = [item.row, other].map((row) => rows.findIndex((r) => r.id === row.id));
		[rows[from], rows[to]] = [rows[to], rows[from]];
		this.roster.reorder(rows.map((r, i) => [r.id, i] as const));
	}

	private startRename(): void {
		const row = this.selectedRow;
		if (!row || row.starting) return;
		if (row.shell) {
			this.say("A shell command can't be renamed");
			return;
		}
		this.renameInput.setValue(row.label);
		cursorToEnd(this.renameInput);
		this.renameFrom = this.mode === "peek" ? "peek" : "list";
		this.mode = "rename";
		this.render_();
	}

	private async commitRename(): Promise<void> {
		const row = this.selectedRow;
		const name = this.renameInput.getValue().trim();
		this.mode = this.renameFrom;
		if (!row || !name) {
			this.render_();
			return;
		}
		if (row.self) {
			this.opts.onRenameSelf?.(name);
			await this.refresh();
			return;
		}
		if (row.pane) {
			await this.opts.client
				.send(row.id, { type: "rename", name })
				.catch(() => this.say("Couldn't rename — the session may have ended.", "error"));
			await this.refresh();
			return;
		}
		await this.opts.client
			.rename(row.id, name)
			.catch(() =>
				this.say("Couldn't rename — the job may have been removed or its state file is unwritable.", "error"),
			);
		await this.refresh();
	}

	private async openResumePicker(): Promise<void> {
		this.mode = "resume";
		this.pastError = false;
		this.pastLoading = true;
		this.pastIndex = 0;
		this.render_();
		try {
			const listed = new Set(this.rows.map((r) => r.sessionFile).filter(Boolean));
			const past = (await this.opts.loadPastSessions?.(this.opts.cwd)) ?? [];
			this.past = past.filter((p) => !listed.has(p.sessionFile));
		} catch {
			this.past = [];
			this.pastError = true;
		}
		this.pastLoading = false;
		this.render_();
	}

	private async resumePast(past: PastSession): Promise<void> {
		if (this.rows.some((r) => r.sessionFile === past.sessionFile)) {
			this.say("This session is already in the list — press enter on its row", "error");
			return;
		}
		this.mode = "list";
		try {
			this.leaveFor(await this.actions.resume(past.cwd, past.sessionFile, [], past.label));
		} catch (error) {
			this.say(`Couldn't resume — ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	private quit(): void {
		this.close();
		this.opts.panes.detach();
	}

	private setModel(arg: string): void {
		if (!arg) {
			this.modelSearch.setValue("");
			this.updateModelPicker();
			const current = this.dispatchModel;
			const index = (this.opts.listModels?.() ?? []).findIndex(
				(m) => m.provider === current?.provider && m.id === current.id,
			);
			this.modelPicker?.setSelectedIndex(Math.max(0, index));
			this.mode = "model";
			return;
		}
		if (arg === "default") {
			this.dispatchModel = this.opts.model;
			this.say("Model reset to default for this session");
			return;
		}
		const models = this.opts.listModels?.() ?? [];
		const name = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
		const want = arg.toLowerCase();
		let model = models.find((m) => name(m).toLowerCase() === want || m.id.toLowerCase() === want);
		if (!model) {
			const prefixed = models.filter(
				(m) => name(m).toLowerCase().startsWith(want) || m.id.toLowerCase().startsWith(want),
			);
			if (prefixed.length === 1) model = prefixed[0];
		}
		if (!model && models.length === 0 && arg.includes("/")) {
			const slash = arg.indexOf("/");
			model = { provider: arg.slice(0, slash), id: arg.slice(slash + 1) };
		}
		if (!model) {
			this.say(`Unknown model '${arg}' — type /model  to see options`);
			return;
		}
		this.dispatchModel = model;
		this.say(`Model set to ${name(model)} (session-scoped, not persisted)`);
	}

	private updateModelPicker(): void {
		const current = this.dispatchModel;
		const items = (this.opts.listModels?.() ?? []).map((m) => ({
			value: `${m.provider}/${m.id}`,
			label: `${m.provider}/${m.id}`,
			description: m.provider === current?.provider && m.id === current.id ? "current" : "",
		}));
		items.push({ value: "default", label: "default", description: "Reset to session model" });
		this.modelPicker = new SelectList(
			fuzzyFilter(items, this.modelSearch.getValue(), (item) => item.value),
			Math.max(1, Math.min(MENU_ROWS, this.opts.ui.terminal.rows - 12)),
			{
				selectedPrefix: (text) => cc.fg("accent", text),
				selectedText: (text) => cc.fg("accent", text),
				description: (text) => cc.fg("muted", text),
				scrollInfo: (text) => cc.fg("muted", text),
				noMatch: (text) => cc.fg("warning", text),
			},
		);
		this.modelPicker.onSelect = (item) => {
			this.mode = "list";
			this.setModel(item.value);
		};
		this.modelPicker.onCancel = () => {
			this.mode = "list";
		};
	}

	private handleModelInput(data: string): void {
		if (this.isEsc(data) || matchesKey(data, "ctrl+c")) this.mode = "list";
		else if (this.isUp(data) || this.isDown(data) || this.isEnter(data)) this.modelPicker?.handleInput(data);
		else {
			this.modelSearch.handleInput(data);
			this.updateModelPicker();
		}
		this.render_();
	}

	private setDir(arg: string): void {
		if (!arg) {
			this.dispatchDir = undefined;
			this.say(`New sessions start in ${this.shorten(this.dispatchCwd())}`);
			return;
		}
		const dir = resolveToCwd(arg, this.dispatchCwd());
		if (!isDirectory(dir)) {
			this.say(`No such directory: ${this.shorten(dir)}`, "error");
			return;
		}
		this.dispatchDir = dir;
		this.say(`New sessions start in ${this.shorten(dir)} (session-scoped)`);
	}

	private suggestions(): typeof VIEW_COMMANDS {
		const text = this.composerText();
		if (this.mode !== "list" || !/^\/\S*$/.test(text)) return [];
		return VIEW_COMMANDS.filter((c) => c.name.startsWith(text.slice(1)));
	}

	private completeSuggestion(enter: boolean): boolean {
		const command = this.suggestions()[this.suggestionIndex];
		if (!command) return false;
		const before = this.composerText();
		if (enter && (!command.arg || before === `/${command.name}`)) {
			this.setComposer(`/${command.name}`);
			return false;
		}
		this.setComposer(`/${command.name}${command.arg ? " " : ""}`);
		this.afterComposerEdit(before);
		return true;
	}

	private argChoices(): Completion[] {
		const menu = this.argMenu;
		return this.mode === "list" && menu?.text === this.composerText() ? menu.items : [];
	}

	private menu(): Array<{ label: string; description?: string }> {
		const args = this.argChoices();
		if (args.length) return args;
		return this.suggestions().map((c) => ({
			label: `/${c.name}${c.arg ? ` ${c.arg}` : ""}`,
			description: c.description,
		}));
	}

	private completeArgument(pick: boolean): boolean {
		const match = /^(\/(cd|model)\s+)(.*)$/.exec(this.composerText());
		if (this.mode !== "list" || !match) return false;
		const [, command, name, arg] = match;
		const listed = this.argChoices();
		if (listed.length) {
			this.fillArgument(`${command}${listed[this.suggestionIndex].value}`);
			return true;
		}
		if (pick) return false;
		const items = name === "cd" ? this.dirCompletions(arg) : this.modelCompletions(arg);
		if (items.length === 0) return true;
		if (items.length === 1) {
			this.fillArgument(`${command}${items[0].value}`);
			return true;
		}
		let shared = items[0].value;
		for (const { value } of items) while (!value.startsWith(shared)) shared = shared.slice(0, -1);
		const completed = `${command}${shared.length > arg.length ? shared : arg}`;
		this.fillArgument(completed);
		this.argMenu = { text: completed, items };
		return true;
	}

	private dirCompletions(arg: string): Completion[] {
		const head = arg.slice(0, arg.lastIndexOf("/") + 1);
		const prefix = arg.slice(head.length);
		const dir = resolveToCwd(head || ".", this.dispatchCwd());
		try {
			return readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.name.startsWith(prefix) && (prefix.startsWith(".") || !e.name.startsWith(".")))
				.filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDirectory(join(dir, e.name))))
				.map((e) => e.name)
				.sort()
				.map((name) => ({ value: `${head}${name}/`, label: `${name}/` }));
		} catch {
			return [];
		}
	}

	private modelCompletions(arg: string): Completion[] {
		const want = arg.toLowerCase();
		const names = (this.opts.listModels?.() ?? [])
			.filter((m) => `${m.provider}/${m.id}`.toLowerCase().startsWith(want) || m.id.toLowerCase().startsWith(want))
			.map((m) => `${m.provider}/${m.id}`);
		if ("default".startsWith(want)) names.push("default");
		return names.map((name) => ({ value: name, label: name }));
	}

	private fillArgument(text: string): void {
		const before = this.composerText();
		this.argMenu = undefined;
		this.setComposer(text);
		this.afterComposerEdit(before);
		this.suggestionIndex = 0;
	}

	private runViewCommand(text: string): boolean {
		const [command, ...rest] = text.slice(1).split(/\s+/);
		const arg = rest.join(" ").trim();
		switch (command) {
			case "exit":
			case "quit":
				this.clearDraft();
				this.quit();
				return true;
			case "resume":
			case "continue":
				if (arg) break;
				this.clearDraft();
				void this.openResumePicker();
				return true;
			case "model":
				this.clearDraft();
				this.setModel(arg);
				return true;
			case "cd":
				this.clearDraft();
				this.setDir(arg);
				return true;
			default:
				if (!this.opts.isKnownCommand?.(command)) return false;
		}
		this.say(`/${command} isn't available in agent view — open a session to run it`);
		return true;
	}

	private async sendReply(row: AgentRow): Promise<void> {
		if (this.replying) return;
		const text = this.reply.getValue().trim();
		this.replying = true;
		const outcome = await this.actions.reply(row, text).finally(() => {
			this.replying = false;
		});
		switch (outcome.kind) {
			case "openInstead":
				void this.open(row);
				return;
			case "sendToSelfOnClose":
				this.teardown();
				this.opts.onSelfReply?.(text);
				this.opts.onClose();
				return;
			case "refused":
				this.replyError = outcome.text;
				this.render_();
				return;
			case "failed":
				this.replyError = outcome.text;
				break;
			case "done":
				this.replyError = undefined;
				this.reply.setValue("");
				this.replyDrafts.delete(row.id);
		}
		await this.refresh();
	}

	private isEnter(data: string): boolean {
		return getKeybindings().matches(data, "tui.input.submit") || data === "\r" || data === "\n";
	}

	private isEsc(data: string): boolean {
		return getKeybindings().matches(data, "tui.select.cancel");
	}

	private isUp(data: string): boolean {
		return getKeybindings().matches(data, "tui.select.up") || matchesKey(data, "ctrl+p");
	}

	private isDown(data: string): boolean {
		return getKeybindings().matches(data, "tui.select.down") || matchesKey(data, "ctrl+n");
	}

	private isEditorKey(data: string): boolean {
		return this.opts.keybindings
			? this.opts.keybindings.matches(data, "app.editor.external")
			: matchesKey(data, "ctrl+g");
	}

	private isNewline(data: string): boolean {
		return (
			getKeybindings().matches(data, "tui.input.newLine") ||
			matchesKey(data, "ctrl+j") ||
			matchesKey(data, "shift+enter") ||
			matchesKey(data, "alt+enter")
		);
	}

	handleInput(data: string): void {
		if (this.leaving) return;
		if (this.mode === "model") {
			this.handleModelInput(data);
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
		if (this.opening) {
			if (!this.isEsc(data) && !matchesKey(data, "ctrl+c") && !this.isUp(data) && !this.isDown(data)) return;
			this.opening = undefined;
			if (this.isEsc(data) || matchesKey(data, "ctrl+c")) {
				this.render_();
				return;
			}
		}
		if (matchesKey(data, "ctrl+c")) {
			this.handleCtrlC();
			return;
		}
		if (this.isEsc(data)) {
			this.handleEsc();
			return;
		}
		if (this.mode === "help") {
			if (matchesKey(data, "?") || matchesKey(data, "shift+?")) {
				this.mode = "list";
				this.render_();
				return;
			}
			if (!this.isUp(data) && !this.isDown(data)) this.mode = "list";
		}
		if (this.handleCommonKey(data)) return;
		if (this.mode === "peek") this.handlePeekInput(data);
		else this.handleListInput(data);
	}

	private handleCtrlC(): void {
		if (this.mode === "help") {
			this.mode = "list";
			this.render_();
			return;
		}
		if (this.mode === "peek") this.closePeek();
		if (this.composerText()) {
			this.clearDraft();
			this.recompute();
		}
		if (Date.now() - this.ctrlCArmedAt < CTRL_C_MS) {
			this.quit();
			return;
		}
		this.ctrlCArmedAt = Date.now();
		setTimeout(() => this.render_(), CTRL_C_MS);
		this.render_();
	}

	private handleEsc(): void {
		if (this.mode === "peek") this.closePeek();
		else if (this.mode === "help") this.mode = "list";
		else if (this.composerText() || this.pasting) {
			this.clearDraft();
			this.restoreFocusAfterFilter();
			this.recompute();
		} else if (this.armed) this.disarm();
		else if (!this.opts.self?.()) {
			this.quit();
			return;
		} else {
			this.close();
			return;
		}
		this.render_();
	}

	private closePeek(): void {
		this.saveReplyDraft();
		this.replyError = undefined;
		this.mode = "list";
	}

	private restoreFocusAfterFilter(): void {
		if (this.beforeFilter) this.selectedKey = this.beforeFilter;
		this.beforeFilter = undefined;
	}

	private handleCommonKey(data: string): boolean {
		const peek = this.mode === "peek";
		const composing = this.composing();
		if (matchesKey(data, "ctrl+s")) {
			this.disarm();
			this.viewMode = this.viewMode === "state" ? "directory" : "state";
			this.opts.saveViewMode?.(this.viewMode);
			this.recompute();
			this.render_();
			return true;
		}
		if (matchesKey(data, "ctrl+t")) {
			void this.togglePin();
			return true;
		}
		if (matchesKey(data, "ctrl+r")) {
			this.startRename();
			return true;
		}
		if (!peek && (matchesKey(data, "shift+up") || matchesKey(data, "shift+down"))) {
			this.reorder(matchesKey(data, "shift+up") ? -1 : 1);
			return true;
		}
		if (
			matchesKey(data, "ctrl+up") ||
			matchesKey(data, "alt+up") ||
			matchesKey(data, "ctrl+down") ||
			matchesKey(data, "alt+down")
		) {
			if (!peek && !composing) {
				this.notice = undefined;
				this.jumpGroup(matchesKey(data, "ctrl+up") || matchesKey(data, "alt+up") ? -1 : 1);
			}
			return true;
		}
		if (!peek && matchesKey(data, "ctrl+f")) {
			this.toggleFind();
			return true;
		}
		if (this.isUp(data) || this.isDown(data)) {
			const delta = this.isUp(data) ? -1 : 1;
			const menu = peek ? [] : this.menu();
			if (menu.length) {
				this.suggestionIndex = (this.suggestionIndex + delta + menu.length) % menu.length;
				this.render_();
			} else if (peek) this.move(delta, { rowsOnly: true, wrap: true });
			else if (composing) this.moveTarget(delta);
			else this.move(delta, { wrap: true });
			return true;
		}
		if (!composing) {
			const page = Math.max(1, this.opts.ui.terminal.rows - 6);
			if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
				this.move(matchesKey(data, "pageUp") ? -page : page);
				return true;
			}
			if (!peek && (matchesKey(data, "home") || matchesKey(data, "end"))) {
				this.move(matchesKey(data, "home") ? -this.items.length : this.items.length);
				return true;
			}
		}
		if (matchesKey(data, "ctrl+x")) {
			void this.stopOrDelete();
			return true;
		}
		return false;
	}

	private moveTarget(delta: number): void {
		if (this.viewMode !== "directory") return;
		const headers = this.items.filter((i) => i.kind === "header" && i.band.key.startsWith("dir:"));
		if (headers.length === 0) return;
		const cwd = this.dispatchCwd();
		const at = headers.findIndex((h) => h.band.key === `dir:${cwd}`);
		const next = headers[(Math.max(0, at) + delta + headers.length) % headers.length];
		this.selectedKey = next.key;
		this.render_();
	}

	private toggleFind(): void {
		const text = this.composerText();
		if (/^s:/i.test(text.trim())) return;
		this.setComposer(/^n:/i.test(text) ? text.slice(2) : `n:${text}`);
		this.afterComposerEdit(text);
	}

	private handleResumeInput(data: string): void {
		if (this.isEsc(data) || matchesKey(data, "ctrl+c") || (data.startsWith("\x1b") && data.length === 2)) {
			this.mode = "list";
		} else if (this.isUp(data)) this.pastIndex = Math.max(0, this.pastIndex - 1);
		else if (this.isDown(data)) this.pastIndex = Math.min(this.past.length - 1, this.pastIndex + 1);
		else if (this.isEnter(data) && this.past[this.pastIndex]) void this.resumePast(this.past[this.pastIndex]);
		this.render_();
	}

	private handleRenameInput(data: string): void {
		if (this.isEsc(data) || matchesKey(data, "ctrl+c")) this.mode = this.renameFrom;
		else if (this.isEnter(data)) void this.commitRename();
		else if (!this.isUp(data) && !this.isDown(data)) this.renameInput.handleInput(data);
		this.render_();
	}

	private handlePeekInput(data: string): void {
		const row = this.selectedRow;
		const empty = this.reply.getValue() === "";
		if (!row || (empty && matchesKey(data, "space"))) {
			this.closePeek();
			this.render_();
			return;
		}
		if (empty && matchesKey(data, "right")) {
			void this.open(row);
			return;
		}
		if (this.isNewline(data)) {
			this.reply.handleInput("\n");
			this.render_();
			return;
		}
		if (this.isEnter(data)) {
			this.saveReplyDraft();
			void this.sendReply(row);
			return;
		}
		if (matchesKey(data, "ctrl+v") || matchesKey(data, "tab")) return;
		if (this.isEditorKey(data)) {
			this.closePeek();
			this.render_();
			return;
		}
		this.reply.handleInput(data);
		this.replyError = undefined;
		this.render_();
	}

	private handleListInput(data: string): void {
		const text = this.composerText();
		const item = this.selected;

		if (matchesKey(data, "ctrl+v")) {
			void this.pasteClipboard();
			return;
		}
		if (this.pasting && (this.isEnter(data) || matchesKey(data, "ctrl+enter"))) return;
		if (this.isNewline(data) || (this.isEnter(data) && this.composer.getValue().endsWith("\\"))) {
			if (!this.isNewline(data)) this.dropTrailingBackslash();
			this.composerLines.push(this.composer.getValue());
			this.composer.setValue("");
			this.afterComposerEdit(text);
			return;
		}
		const value = this.composer.getValue();
		const token = this.pastes.ranges(value).at(-1);
		if (matchesKey(data, "backspace") && token?.end === value.length && this.composerCursorAtEnd()) {
			this.composer.setValue(value.slice(0, token.start));
			cursorToEnd(this.composer);
			this.afterComposerEdit(text);
			return;
		}
		if (matchesKey(data, "backspace") && this.composer.getValue() === "" && this.composerLines.length > 0) {
			this.setComposer(this.composerLines.join("\n"));
			this.afterComposerEdit(text);
			return;
		}
		const ctrlEnter = matchesKey(data, "ctrl+enter");
		if (ctrlEnter || this.isEnter(data)) {
			this.handleEnter(ctrlEnter);
			return;
		}
		if (matchesKey(data, "tab")) {
			if (!this.completeSuggestion(false)) this.completeArgument(false);
			return;
		}
		if (!text && matchesKey(data, "right") && item?.kind === "row") {
			void this.open(item.row);
			return;
		}
		for (let n = 1; n <= 9; n++) {
			if (matchesKey(data, `alt+${n}` as KeyId) || matchesKey(data, `super+${n}` as KeyId)) {
				const cwd =
					item?.kind === "row"
						? item.row.cwd
						: item?.band.key.startsWith("dir:")
							? item.band.key.slice(4)
							: this.opts.cwd;
				const row = this.items.flatMap((i) =>
					i.kind === "row" && i.row.cwd === cwd && !i.row.starting ? [i.row] : [],
				)[n - 1];
				if (row) void this.open(row);
				return;
			}
		}
		if (!text) {
			if (matchesKey(data, "?") || matchesKey(data, "shift+?")) {
				this.mode = "help";
				this.render_();
				return;
			}
			if (matchesKey(data, "space")) {
				if (item?.kind === "row") {
					this.mode = "peek";
					this.reply.setValue(this.replyDrafts.get(item.key) ?? "");
					cursorToEnd(this.reply);
					this.refreshPeek();
					this.render_();
				}
				return;
			}
		}
		if (this.isEditorKey(data)) {
			void this.editExternally();
			this.render_();
			return;
		}
		this.composer.handleInput(data);
		this.afterComposerEdit(text);
	}

	private handleEnter(ctrlEnter: boolean): void {
		if (this.completeSuggestion(true) || this.completeArgument(true)) return;
		const text = this.composerText();
		const trimmed = text.trim();
		if (EXIT_WORDS.has(trimmed.toLowerCase())) {
			this.clearDraft();
			this.quit();
			return;
		}
		if (trimmed.startsWith("/") && this.runViewCommand(trimmed)) {
			this.recompute();
			this.render_();
			return;
		}
		if (trimmed.startsWith("!") && trimmed.slice(1).trim()) {
			this.startShell(this.pastes.expandText(trimmed).slice(1).trim());
			return;
		}
		if (this.composing()) {
			void this.dispatch(ctrlEnter);
			return;
		}
		const item = this.selected;
		if (!item) return;
		if (item.kind === "more") {
			this.expanded.add(item.band.key);
			this.recompute();
		} else if (item.kind === "runs") {
			if (!this.openRuns.delete(item.row.id)) this.openRuns.add(item.row.id);
			this.recompute();
		} else if (item.kind === "header") {
			if (this.onboarding || queryFilter(text)) return;
			if (this.collapsed.has(item.band.key)) this.collapsed.delete(item.band.key);
			else {
				this.collapsed.add(item.band.key);
				this.expanded.delete(item.band.key);
			}
			this.recompute();
		} else void this.open(item.row);
		this.render_();
	}

	private afterComposerEdit(before: string): void {
		const after = this.composerText();
		if (after !== before) {
			this.notice = undefined;
			this.suggestionIndex = 0;
		}
		const wasFilter = !!queryFilter(before);
		const isFilter = !!queryFilter(after);
		if (isFilter && !wasFilter) this.beforeFilter = this.selectedKey;
		this.recompute();
		if (!isFilter && wasFilter) {
			this.restoreFocusAfterFilter();
			this.recompute();
		}
		if (isFilter && !/^n:\S/i.test(after.trim())) {
			this.selectedKey = this.items.find((i) => i.kind === "row")?.key ?? this.selectedKey;
		}
		this.render_();
	}

	invalidate(): void {}

	private modelLabel(): string {
		if (this.dispatchModel === this.opts.model && this.opts.modelName) return this.opts.modelName;
		if (!this.dispatchModel) return "";
		const name = `${this.dispatchModel.provider}/${this.dispatchModel.id}`;
		return this.dispatchModel === this.opts.model ? name : `${name} (session)`;
	}

	private headerLines(width: number): string[] {
		const counts = countRows(this.allRows);
		const summary = cc.fg(
			"muted",
			`${counts.needs} awaiting input · ${counts.working} working · ${counts.idle} idle`,
		);
		if (this.layoutBudget().compact) return [summary];
		const title = `${theme.bold(this.opts.appName)}${this.opts.version ? ` ${cc.fg("muted", `v${this.opts.version}`)}` : ""}`;
		const model = this.modelLabel();
		const cwd = middleEllipsis(
			this.shorten(this.dispatchCwd()),
			Math.max(width - 11 - (model ? visibleWidth(model) + 3 : 0), 10),
		);
		const where = cc.fg("muted", [model, cwd].filter(Boolean).join(" · "));
		const text = [title, where, summary];
		if (width < MASCOT_MIN_COLUMNS) return text;
		return renderMascot(REST, mascotGlyphs()).map((art, i) => `${art} ${text[i] ?? ""}`);
	}

	private icon(row: AgentRow): string {
		if (this.opening === row.id) return SPINNER[this.frame];
		const glyph =
			this.justKilled === row.id || !row.alive ? "∙" : row.state === "working" ? SPINNER[this.frame] : "✻";
		return cc.fg(STATE_COLOR[row.state], glyph);
	}

	private armedFor(row: AgentRow): boolean {
		const key = this.armed?.key;
		return (
			!!key &&
			(key === row.id || this.items.some((i) => i.kind === "header" && i.key === key && i.band.rows.includes(row)))
		);
	}

	private rowDetail(row: AgentRow, run?: true): string {
		if (this.opening === row.id)
			return cc.fg(
				"muted",
				row.state === "working"
					? "opening after its current tool finishes… · esc to cancel"
					: "opening… · esc to cancel",
			);
		if (this.armedFor(row)) {
			if (run) return cc.fg("muted", "closing…");
			return cc.fg(
				"error",
				this.justKilled === row.id ? "stopped · ctrl+x again to delete" : "ctrl+x again to delete",
			);
		}
		const text = row.wakesAt !== undefined ? `wakes ${wakeupClock(row.wakesAt)}` : clean(row.detail);
		const lead = [
			this.viewMode === "directory" ? cc.fg(STATE_COLOR[row.state], STATE_WORDS[row.state]) : "",
			row.livePanes ? cc.fg("warning", livePanesWarning(row.livePanes)) : "",
		]
			.filter(Boolean)
			.join(cc.fg("muted", " · "));
		if (!lead) return cc.fg("muted", text);
		return text ? `${lead}${cc.fg("muted", ` · ${text}`)}` : lead;
	}

	private renderRow(
		row: AgentRow,
		width: number,
		rowLabelWidth: number,
		ageWidth: number,
		focused: boolean,
		run?: true,
	): string {
		const pad = `${width >= 120 ? " " : ""}${run ? "  " : ""}`;
		const labelWidth = run ? Math.max(1, rowLabelWidth - 2) : rowLabelWidth;
		let name = truncateToWidth(clean(row.label), labelWidth, "…");
		if (this.mode === "rename" && focused) {
			const line = (this.renameInput.render(labelWidth + 2)[0] ?? "").replace(/^> /, "");
			name = truncateToWidth(line, labelWidth);
		} else if (row.self) name = theme.bold(focused ? cc.fg("text", name) : name);
		else name = focused ? cc.fg("text", name) : cc.fg("muted", name);
		const age = rowAge(row, Date.now()).padStart(ageWidth);
		const fixed = visibleWidth(pad) + 2 + labelWidth + 2 + 2 + ageWidth;
		const detailWidth = Math.max(0, width - fixed);
		const detail = truncateToWidth(this.rowDetail(row, run), detailWidth, "…");
		const line =
			`${pad}${this.icon(row)} ${name}${" ".repeat(Math.max(0, labelWidth - visibleWidth(name)))}  ` +
			`${detail}${" ".repeat(Math.max(0, detailWidth - visibleWidth(detail)))}  ${cc.fg("muted", age)}`;
		const fitted = truncateToWidth(line, width);
		if (!focused || this.composing()) return fitted;
		return cc.bg("userMessageBg", `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`);
	}

	private targetBandKey(): string {
		return this.viewMode === "directory" ? `dir:${this.dispatchCwd()}` : "working";
	}

	private renderBand(
		item: Extract<Item, { kind: "header" }>,
		width: number,
		focused: boolean,
		bandCount: number,
	): string {
		const band = item.band;
		const collapsed = this.collapsed.has(band.key) && !queryFilter(this.composerText());
		const title =
			this.viewMode === "directory" && band.key.startsWith("dir:")
				? middleEllipsis(band.title, Math.max(width - 10, 10))
				: band.title;
		const count = collapsed ? cc.fg("muted", ` ${band.rows.length}`) : "";
		if (this.composing()) {
			const target = band.key === this.targetBandKey();
			return truncateToWidth(`${target ? theme.bold(cc.fg("text", title)) : cc.fg("muted", title)}${count}`, width);
		}
		if (focused && !this.onboarding) {
			const text = truncateToWidth(`${theme.bold(cc.fg("text", title))}${count}`, width);
			return cc.bg("userMessageBg", `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`);
		}
		const own = this.selected?.kind === "row" && this.selected.band.key === band.key;
		const gray = cc.fg("muted", title);
		return truncateToWidth(`${bandCount > 1 && own ? theme.bold(gray) : gray}${count}`, width);
	}

	private renderList(width: number): { lines: string[]; focusLine: number } {
		const lines: string[] = [];
		let focusLine = 0;
		const labelWidth = Math.min(
			Math.max(40, Math.floor(width / 3)),
			Math.max(12, ...this.rows.map((r) => visibleWidth(clean(r.label)))),
		);
		const ageWidth = Math.max(3, ...this.rows.map((r) => rowAge(r, Date.now()).length));
		if (this.rows.length === 0 && queryFilter(this.composerText())) {
			lines.push(cc.fg("muted", "  no sessions match"));
			return { lines, focusLine };
		}
		const bandCount = this.items.filter((i) => i.kind === "header").length;
		let first = true;
		for (const item of this.items) {
			const focused = item.key === this.selectedKey;
			if (item.kind === "header") {
				if (!first) lines.push("");
				first = false;
				if (focused) focusLine = lines.length;
				lines.push(this.renderBand(item, width, focused, bandCount));
				continue;
			}
			first = false;
			if (focused) focusLine = lines.length;
			if (item.kind === "more" || item.kind === "runs") {
				const text =
					item.kind === "more"
						? `${width >= 120 ? " " : ""}… ${item.hidden} more`
						: `${width >= 120 ? " " : ""}  ${this.openRuns.has(item.row.id) ? "▾" : "▸"} ${item.count} subagent${item.count === 1 ? "" : "s"}`;
				lines.push(
					focused && !this.composing()
						? cc.bg("userMessageBg", cc.fg("text", text.padEnd(width)))
						: cc.fg("muted", text),
				);
			} else lines.push(this.renderRow(item.row, width, labelWidth, ageWidth, focused, item.run));
		}
		return { lines, focusLine };
	}

	private renderBody(width: number): { lines: string[]; focusLine: number } {
		const lines = ["", ...this.headerLines(width), ""];
		if (this.opts.self?.()) {
			lines.push(
				...wrapTextWithAnsi(
					cc.fg(
						"muted",
						"Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits",
					),
					width,
				),
				"",
			);
		}
		const list = this.renderList(width);
		return { lines: [...lines, ...list.lines], focusLine: lines.length + list.focusLine };
	}

	private dimMarkdown(text: string): string {
		return clean(text)
			.split(/(\*\*[^*]+\*\*|\+\+[^+]+\+\+|`[^`]+`)/)
			.map((part, i) =>
				i % 2 === 1
					? theme.bold(cc.fg("muted", part.replace(/^(\*\*|\+\+|`)|(\*\*|\+\+|`)$/g, "")))
					: cc.fg("muted", part),
			)
			.join("");
	}

	private renderPeek(row: AgentRow, width: number): string[] {
		const inner = Math.max(10, width - 4);
		const body: string[] = [];
		const text = row.detail;
		const shown = row.state === "working" ? clean(text) : this.dimMarkdown(text);
		const cap = Math.max(5, this.opts.ui.terminal.rows - 8 - 6);
		if (row.shell) {
			const output = this.peekOutput?.shell === row.shell ? this.peekOutput.lines : [];
			for (const line of output.slice(-cap)) body.push(truncateToWidth(clean(line), inner, "…"));
		} else if (text) body.push(...wrapTextWithAnsi(shown, inner).slice(0, cap));
		const since = row.state === "needs" ? row.finishedAt : undefined;
		if (since) {
			body.push(
				cc.fg(STATE_COLOR[row.state], `  waiting ${compactAge(Date.now() - (Date.parse(since) || Date.now()))}`),
			);
		}
		body.push("");
		body.push(promptLine(this.reply, inner, "reply"));
		if (this.replyError) body.push(truncateToWidth(faint(cc.fg("error", this.replyError)), inner, "…"));
		const border = (l: string, r: string) => faint(`${l}${"─".repeat(Math.max(0, width - 2))}${r}`);
		const boxed = [border("╭", "╮")];
		for (const line of body) {
			const fitted = truncateToWidth(line, inner);
			boxed.push(`${faint("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${faint("│")}`);
		}
		boxed.push(border("╰", "╯"));
		const typed = !!this.reply.getValue();
		const enter = typed ? "send" : this.resumable(row) ? "resume" : "open";
		boxed.push(
			this.hints(width, [
				typed || !row.starting ? `enter to ${enter}` : undefined,
				typed ? "esc to close" : "space to close",
				`ctrl+x to ${this.armedFor(row) ? "confirm" : "delete"}`,
			]),
		);
		return boxed;
	}

	private resumable(row: AgentRow): boolean {
		return !row.shell && !row.alive && (row.state === "failed" || row.state === "stopped");
	}

	private renderResume(width: number): string[] {
		const inner = Math.max(10, width - 4);
		const content: string[] = [theme.bold("Resume a past session")];
		if (this.pastLoading) content.push(cc.fg("muted", "Looking for past sessions…"));
		else if (this.pastError)
			content.push(cc.fg("muted", "Couldn't load past sessions — press esc, then try /resume again"));
		else if (this.past.length === 0) content.push(cc.fg("muted", "No past sessions to resume"));
		else {
			const start = Math.max(0, Math.min(this.pastIndex - 3, this.past.length - 8));
			const shown = this.past.slice(start, start + 8);
			if (start > 0) content.push(cc.fg("muted", `  … ${start} above`));
			const nowMs = Date.now();
			shown.forEach((past, i) => {
				const focused = start + i === this.pastIndex;
				const age = compactAge(nowMs - (Date.parse(past.modifiedAt) || nowMs));
				const title = truncateToWidth(
					`${focused ? "❯" : " "} ${clean(past.label)}`,
					Math.max(4, inner - age.length - 1),
					"…",
				);
				const colored = focused ? cc.fg("accent", title) : cc.fg("muted", title);
				content.push(
					`${colored}${" ".repeat(Math.max(1, inner - visibleWidth(title) - age.length))}${cc.fg("muted", age)}`,
				);
			});
			const below = this.past.length - start - shown.length;
			if (below > 0) content.push(cc.fg("muted", `  … ${below} more`));
		}
		content.push(cc.fg("muted", "↑/↓ to navigate · enter to resume as a background session · esc to close"));
		const border = (l: string, r: string) => `${l}${"─".repeat(Math.max(0, width - 2))}${r}`;
		return [
			border("╭", "╮"),
			...content.map((line) => {
				const fitted = truncateToWidth(line, inner);
				return `│ ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} │`;
			}),
			border("╰", "╯"),
		];
	}

	private renderHelp(width: number): string[] {
		const item = this.selected;
		const row = item?.kind === "row" && !item.row.starting ? item.row : undefined;
		const cwd = item?.kind === "row" ? item.row.cwd : this.opts.cwd;
		const alt = Math.min(
			9,
			this.items.filter((i) => i.kind === "row" && i.row.cwd === cwd && !i.row.starting).length,
		);
		const opt = process.platform === "darwin" ? "opt" : "alt";
		const items = [
			...(row && item?.kind === "row" && manuallyOrdered(item.band) && orderedRows(item.band).includes(row)
				? ["shift+↑↓ to reorder"]
				: []),
			...(row ? ["ctrl+r to rename"] : []),
			"ctrl+f to find",
			`${opt}+↑/↓ to jump groups`,
			"ctrl+s to switch views",
			"ctrl+j for newline",
			...(row ? [`ctrl+t to ${row.pinned ? "unpin" : "pin to top"}`] : []),
			...(alt > 0 ? [`alt+1${alt > 1 ? `-${alt}` : ""} to open`] : []),
			...(row ? [`ctrl+x to ${stoppable(row) ? "stop" : "delete"}`] : []),
			"esc to quit",
			"? to close",
		];
		for (let height = 3; ; height++) {
			const columns: string[][] = [];
			for (let i = 0; i < items.length; i += height) columns.push(items.slice(i, i + height));
			const widths = columns.map((c) => Math.max(...c.map((s) => visibleWidth(s))));
			const total = 4 + widths.reduce((a, b) => a + b, 0) + 4 * (columns.length - 1);
			if (total > width && columns.length > 1) continue;
			return Array.from({ length: Math.min(height, items.length) }, (_, r) => {
				const text = columns
					.map((c, i) => {
						const cell = c[r] ?? "";
						return i === columns.length - 1 ? cell : cell + " ".repeat(widths[i] + 4 - visibleWidth(cell));
					})
					.join("")
					.trimEnd();
				return truncateToWidth(`  ${cc.fg("muted", text)}`, width);
			});
		}
	}

	private hints(width: number, items: Array<string | undefined>, lead?: string): string {
		const line = items.filter((i): i is string => !!i).join(" · ");
		const text = lead ? `${lead}${line ? cc.fg("muted", ` · ${line}`) : ""}` : cc.fg("muted", line);
		return truncateToWidth(`  ${text}`, width, "…");
	}

	private footerSlot(width: number): string {
		if (Date.now() - this.ctrlCArmedAt < CTRL_C_MS) {
			const counts = countRows(this.allRows);
			const running = counts.working + counts.needs;
			const suffix = running > 0 ? ` · ${running} agent${running === 1 ? "" : "s"} will keep running` : "";
			return this.hints(width, [`Press Ctrl-C again to exit${suffix}`]);
		}
		if (this.mode === "rename") return this.hints(width, ["enter to save · esc to cancel"]);
		if (this.armed) return this.hints(width, ["ctrl+x to confirm"]);
		if (this.notice) {
			const text =
				this.notice.kind === "error" ? cc.fg("error", this.notice.text) : cc.fg("muted", this.notice.text);
			return truncateToWidth(`  ${text}`, width, "…");
		}
		const service =
			this.daemonNotice ||
			(this.roster.connectionLost ? "lost connection to the background service — showing the last known list" : "");
		if (service) return truncateToWidth(`  ${cc.fg("warning", service)}`, width, "…");
		return this.listHints(width);
	}

	private listHints(width: number): string {
		const text = this.composerText();
		const item = this.selected;
		const composing = this.composing();
		const row = item?.kind === "row" && !item.row.starting ? item.row : undefined;
		let enter: string | undefined;
		if (composing) enter = "enter to create";
		else if (row) enter = `enter to ${row.self ? "return" : this.resumable(row) ? "resume" : "open"}`;
		return this.hints(
			width,
			[
				enter,
				item?.kind === "header" && !text && !this.onboarding
					? `enter to ${this.collapsed.has(item.band.key) ? "expand" : "collapse"}`
					: undefined,
				item?.kind === "more" && !text ? "enter to show all" : undefined,
				item?.kind === "runs" && !text
					? `enter to ${this.openRuns.has(item.row.id) ? "hide" : "show"} subagents`
					: undefined,
				text ? "esc to clear" : "? for shortcuts",
			],
			this.opts.mode,
		);
	}

	private renderSuggestions(width: number): string[] | undefined {
		const menu = this.menu();
		if (menu.length === 0) return undefined;
		const column = Math.max(...menu.map((c) => c.label.length)) + 4;
		const start = Math.max(0, Math.min(this.suggestionIndex - MENU_ROWS + 1, menu.length - MENU_ROWS));
		return menu
			.slice(start, start + MENU_ROWS)
			.map((c, i) =>
				truncateToWidth(
					cc.fg(
						start + i === this.suggestionIndex ? "accent" : "muted",
						c.description ? `  ${c.label.padEnd(column)}${c.description}` : `  ${c.label}`,
					),
					width,
					"…",
				),
			);
	}

	private composerLinesFor(width: number, dim: boolean): string[] {
		const lines = this.composerLines.map((line, i) => truncateToWidth(i === 0 ? `❯ ${line}` : line, width));
		const current = promptLine(this.composer, width, "");
		lines.push(lines.length ? current.replace(/^❯ /, "") : current);
		if (this.pasting) lines.push(truncateToWidth(cc.fg("muted", "Reading clipboard…"), width));
		return dim ? lines.map((line) => faint(stripTerminalSequences(line))) : lines;
	}

	private reportDrawnAfterFlush(): void {
		if (this.opts.onDrawn) setTimeout(this.opts.onDrawn, FRAME_FLUSH_MS);
	}

	render(width: number): string[] {
		if (this.loaded && !this.drawn) {
			this.drawn = true;
			this.reportDrawnAfterFlush();
		}
		const rows = this.opts.ui.terminal.rows;
		const rule = faint("─".repeat(width));
		let footer: string[];
		if (this.mode === "peek" && this.selectedRow) footer = this.renderPeek(this.selectedRow, width);
		else if (this.mode === "resume") footer = this.renderResume(width);
		else if (this.mode === "model") {
			this.modelSearch.focused = this.focused;
			footer = [
				rule,
				cc.fg("accent", "Select model"),
				promptLine(this.modelSearch, width, "Search models"),
				...(this.modelPicker?.render(width) ?? []),
				this.hints(width, ["↑↓ select · enter confirm · esc cancel"]),
			];
		} else {
			footer = [
				rule,
				...this.composerLinesFor(width, this.mode === "rename"),
				rule,
				...(this.mode === "help"
					? this.renderHelp(width)
					: (this.renderSuggestions(width) ?? [this.footerSlot(width)])),
			];
		}

		const { lines: body, focusLine } = this.renderBody(width);
		const budget = Math.max(1, rows - footer.length);
		const top = this.selected?.kind === "header" ? Math.max(0, focusLine - 1) : focusLine;
		if (this.items[0]?.key === this.selectedKey) this.scrollStart = 0;
		else if (top < this.scrollStart) this.scrollStart = top;
		else if (focusLine >= this.scrollStart + budget) this.scrollStart = focusLine - budget + 1;
		this.scrollStart = Math.max(0, Math.min(this.scrollStart, Math.max(0, body.length - budget)));
		const windowed = body
			.slice(this.scrollStart, this.scrollStart + budget)
			.map((line) => truncateToWidth(line, width));
		return [...windowed, ...Array(Math.max(0, budget - windowed.length)).fill(""), ...footer];
	}
}

function orderedRows(band: Band): AgentRow[] {
	return band.rows.filter((r) => !r.starting && !r.shell && !r.unlisted);
}

function manuallyOrdered(band: Band): boolean {
	return band.key === "pinned" || band.key.startsWith("dir:");
}

function cursorToEnd(input: Input): void {
	input.handleInput("\x05");
}

function cursorToEndDuringPaste(input: Input): void {
	(input as unknown as { cursor: number }).cursor = input.getValue().length;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function clean(text: string): string {
	return text
		.replace(/<(system-reminder|task-notification)>[\s\S]*?(<\/\1>|$)/g, " ")
		.replace(/<\/?[\w-]+>/g, " ")
		.replace(/[\x00-\x1f\x7f\s]+/g, " ")
		.trim();
}

export function middleEllipsis(path: string, max: number): string {
	if (visibleWidth(path) <= max) return path;
	const parts = path.split("/");
	const last = parts.pop() ?? "";
	const first = parts.shift() ?? "";
	let tail = last;
	for (let i = parts.length - 1; i >= 0; i--) {
		const next = `${parts[i]}/${tail}`;
		if (visibleWidth(`${first}/…/${next}`) > max) break;
		tail = next;
	}
	const shaped = `${first}/…/${tail}`;
	if (visibleWidth(shaped) <= max) return shaped;
	if (visibleWidth(`…/${last}`) <= max) return `…/${last}`;
	return truncateToWidth(`…/${last}`, max, "…");
}

function sameBytes(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

function imageFiles(images: ImageContent[]): string[] {
	if (images.length === 0) return [];
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-images-"));
	return images.map((image, i) => {
		const file = join(dir, `image-${i + 1}.${image.mimeType.split("/")[1] ?? "png"}`);
		writeFileSync(file, Buffer.from(image.data, "base64"));
		return file;
	});
}
