/**
 * Agent view, built on pi's TUI.
 *
 * Header, then the bands (Needs input / Working / Idle, or one band per directory), one
 * line per session: icon + name │ what it is doing │ age. The composer at the bottom starts a
 * new background session from whatever is typed; space opens the peek panel to read the
 * question or result and reply without leaving the list; enter opens the session in this
 * window (the one here goes to the background daemon).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	type KeyId,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { stripAnsi } from "../_shared/ansi.ts";
import { PasteTokens, shouldCollapse } from "../_shared/paste-tokens.ts";
import { theme } from "../_shared/theme.ts";
import { mascotGlyphs, REST, renderMascot } from "../branding/mascot.ts";
import { type AgentClipboard, readAgentClipboard } from "./clipboard.ts";
import { currentDaemonBuildId, type InstanceSummary, type OrchestratorClient } from "./orchestrator-client.ts";
import {
	type AgentRow,
	type Band,
	buildBands,
	collectRows,
	compactAge,
	countRows,
	labelFromTask,
	nameScore,
	queryFilter,
	type RowState,
	rowAge,
	rowFromShell,
	STATE_WORDS,
	stateBandOf,
	type ViewMode,
} from "./rows.ts";
import { AGENT_VIEW_COMMAND, HIDE_ENV, OPEN_VIEW_ENV, type ShellInfo } from "./tmux.ts";

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
	/** The model's display name for the header. */
	modelName?: string;
	/** The mode new sessions start in, as a colored badge; it leads the hint line. */
	mode?: string;
	cwd: string;
	home: string;
	/** This window's own session as a row, rebuilt on every refresh (its activity is live). */
	self?: () => InstanceSummary | undefined;
	onClose: () => void;
	/** The models `/model` accepts for new sessions. */
	listModels?: () => Array<{ provider: string; id: string }>;
	/** A slash command that exists but needs a session (`/compact`); any other `/text` is a task. */
	isKnownCommand?: (name: string) => boolean;
	/** ctrl+x on this window's own session: stop its turn. */
	onStopSelf?: () => void;
	/** ctrl+r on this window's own session. */
	onRenameSelf?: (name: string) => void;
	/** Every session is a pi in its own tmux session (see tmux.ts). */
	panes: PaneOps;
	/** A peek reply to this window's own session: sent as its next prompt once the view closes. */
	onSelfReply?: (text: string) => void;
	/** Clipboard IO is separate from the view so asynchronous paste never blocks rendering. */
	readClipboard?: () => Promise<AgentClipboard>;
	/** `/resume`: this repository's past sessions, newest first. */
	loadPastSessions?: (cwd: string) => Promise<PastSession[]>;
	loadViewMode?: () => ViewMode | undefined;
	saveViewMode?: (mode: ViewMode) => void;
	/** The terminal tab title while the view is open; undefined restores the session's own. */
	setTitle?: (title: string | undefined) => void;
	/** A row not to list: the session whose deletion opened this view, until its row is gone. */
	hide?: string;
	/** Called once the loaded roster has drawn. */
	onDrawn?: () => void;
}

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

type Item =
	| { kind: "header"; key: string; band: Band }
	| { kind: "row"; key: string; band: Band; row: AgentRow }
	| { kind: "more"; key: string; band: Band; hidden: number };

type Mode = "list" | "peek" | "rename" | "resume" | "help";

const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER = [...FRAMES, ...[...FRAMES].reverse()];
const ARM_MS = 2000;
/** Claude Code's double ctrl+c window. */
const CTRL_C_MS = 800;
/** Bare words that quit, as in Claude Code. */
export const EXIT_WORDS = new Set(["exit", "quit", ":q", ":q!", ":wq", ":wq!"]);
/** How many times (150ms apart) a delete waits for the row a stopped pi saves. */
const STOP_SAVE_POLLS = 20;
/** How long a new pane's row shows as starting before it should have registered. */
const PANE_START_MS = 15_000;

type Color = Parameters<typeof theme.fg>[0];

/**
 * A fixed dark palette, so agent view reads the same whatever dark theme pi uses. A light theme
 * keeps its own colors, which are chosen for a light terminal.
 */
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

/** Whether the theme's message background is light, read from the escape it emits. */
function isLightTheme(): boolean {
	let light = lightThemes.get(theme);
	if (light === undefined) {
		const ansi = theme.getBgAnsi("userMessageBg");
		const rgb = /48;2;(\d+);(\d+);(\d+)/.exec(ansi);
		const n = /48;5;(\d+)/.exec(ansi);
		const [r, g, b] = rgb ? rgb.slice(1).map(Number) : n ? xterm256(Number(n[1])) : [0, 0, 0];
		light = 0.299 * r + 0.587 * g + 0.114 * b > 128;
		lightThemes.set(theme, light);
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

function sgr(layer: 38 | 48, hex: string): string {
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
	if (theme.getColorMode() === "truecolor") return `\x1b[${layer};2;${r};${g};${b}m`;
	const cube = (x: number) => (x < 48 ? 0 : x < 115 ? 1 : Math.floor((x - 35) / 40));
	return `\x1b[${layer};5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}m`;
}

const cc = {
	fg(color: Color, text: string): string {
		const hex = isLightTheme() ? undefined : CC_DARK[color];
		return hex ? `${sgr(38, hex)}${text}\x1b[39m` : theme.fg(color, text);
	},
	bg(color: "userMessageBg", text: string): string {
		const hex = isLightTheme() ? undefined : CC_DARK[color];
		return hex ? `${sgr(48, hex)}${text}\x1b[49m` : theme.bg(color, text);
	},
};

/** Only a blocking prompt has a color: the rest say just whether a turn is running. */
const ICON_COLOR: Record<RowState, Color> = {
	working: "muted",
	needs: "warning",
	idle: "muted",
	done: "muted",
	failed: "muted",
	stopped: "muted",
};

/** The state word in the directory view; "Working" stays in the plain text color. */
const WORD_COLOR: Record<RowState, Color> = { ...ICON_COLOR, working: "text" };

/** The header shows the mascot only this wide. */
const MASCOT_MIN_COLUMNS = 70;

/** SGR faint, for rules and the peek box. */
function faint(text: string): string {
	return `\x1b[2m${text}\x1b[22m`;
}

/** An Input line with a `❯` prompt; empty, the cursor sits on the placeholder's first letter. */
function promptLine(input: Input, width: number, placeholder: string): string {
	if (!input.getValue()) {
		const [first = " ", ...rest] = [...placeholder];
		return truncateToWidth(
			`${cc.fg("muted", "❯")} \x1b[7m${cc.fg("muted", first)}\x1b[27m${cc.fg("muted", rest.join(""))}`,
			width,
		);
	}
	const line = input.render(width)[0] ?? "";
	return line.startsWith("> ") ? `❯ ${line.slice(2)}` : line;
}

export class AgentView implements Component, Focusable {
	focused = false;

	private readonly opts: AgentViewOptions;
	private readonly composer = new Input();
	/** Lines above the composer's current one (ctrl+j / shift+enter); Input itself is single-line. */
	private composerLines: string[] = [];
	/** The composer's paste tokens, as Claude Code's: `[Pasted text #N +L lines]` and `[Image #N]`. */
	private readonly pastes = new PasteTokens();
	/** The `!` commands the tmux server runs or ran: rows of their own. */
	private shells: ShellInfo[] = [];
	/** The Input's own paste: one line at the cursor. */
	private readonly insertIntoComposer: (text: string) => void;
	private pasting = false;
	private draftVersion = 0;
	/** True while ctrl+g's editor owns the terminal. */
	private editing = false;
	private readonly reply = new Input();
	private readonly renameInput = new Input();
	private instances: InstanceSummary[] = [];
	private rows: AgentRow[] = [];
	/** Every listed session, before the composer's filter: what the counts and title report. */
	private allRows: AgentRow[] = [];
	private onboarding = false;
	private pending: AgentRow[] = [];
	private items: Item[] = [];
	private selectedKey: string | undefined;
	private mode: Mode = "list";
	private renameFrom: "list" | "peek" = "list";
	private viewMode: ViewMode;
	private readonly collapsed = new Set<string>();
	private readonly expanded = new Set<string>();
	private armed: { key: string; timer: ReturnType<typeof setTimeout> } | undefined;
	private ctrlCArmedAt = 0;
	/** Shown in the footer's hint slot until the composer changes or the focus moves, as Claude Code's are. */
	private notice: { text: string; kind: "hint" | "error" } | undefined;
	/** The row a ctrl+x stopped on its first press: it reads "stopped · ctrl+x again to delete". */
	private justKilled: string | undefined;
	/** A row whose pi that ctrl+x ended, shown stopped until the row its pi saves arrives. */
	private stopping: { row: AgentRow; until: number } | undefined;
	/** Peek reply drafts by row, kept across navigation. */
	private readonly replyDrafts = new Map<string, string>();
	/** The peek's own send/answer error, shown inside the box. */
	private replyError: string | undefined;
	/** The first visible body line; moved only as far as keeps the focus on screen. */
	private scrollStart = 0;
	/** The focused item's index, for when that item disappears. */
	private lastIndex = 0;
	/** The focus before a filter was typed, restored when it is cleared. */
	private beforeFilter: string | undefined;
	/** A header reached with the arrows offers "ctrl+x to delete all"; one focused on open does not. */
	private navigated = false;
	private daemonNotice = "";
	private connectionLost = false;
	private opening: string | undefined;
	private dispatchModel: { provider: string; id: string } | undefined;
	private past: PastSession[] = [];
	private pastIndex = 0;
	private pastLoading = false;
	private pastError = false;
	private frame = 0;
	private spinTimer: ReturnType<typeof setInterval> | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private refreshing = false;
	private closed = false;
	/** Set once the first roster is in; the next frame drawn is reported to onDrawn. */
	private loaded = false;
	private drawn = false;
	/** This terminal is moving to another pane: keys wait for it. */
	private leaving = false;
	private lastTitle = "";
	private userMoved = false;

	constructor(opts: AgentViewOptions) {
		this.opts = opts;
		this.viewMode = opts.loadViewMode?.() ?? "state";
		this.dispatchModel = opts.model;
		const composer = this.composer as unknown as { handlePaste(text: string): void };
		const insert = composer.handlePaste.bind(this.composer);
		this.insertIntoComposer = insert;
		composer.handlePaste = (text) => this.pasteIntoComposer(text, insert);
		// This window's own row shows at once, before the daemon (maybe cold-starting) answers.
		this.recompute();
	}

	/**
	 * A paste into the composer, as Claude Code's: a long one is a `[Pasted text #N +L lines]` token,
	 * the same paste again right after shows what the token holds, and a short one goes in as typed.
	 * `insert` is the Input's own paste, which puts one line at the cursor.
	 */
	private pasteIntoComposer(pasted: string, insert: (text: string) => void): void {
		const text = pasted.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
		if (this.expandRepeat("text", text)) return;
		if (shouldCollapse(text)) {
			insert(this.pastes.addText(text));
			return;
		}
		this.pastes.settle();
		const [first = "", ...rest] = text.split("\n");
		insert(first);
		for (const line of rest) {
			this.composerLines.push(this.composer.getValue());
			this.composer.setValue("");
			insert(line);
		}
	}

	/** The same paste again, right after its token: the token gives way to what it holds. */
	private expandRepeat(kind: "text" | "image", content: string, same?: (a: string, b: string) => boolean): boolean {
		const repeat = this.pastes.repeatOf(kind, content, same);
		const value = this.composer.getValue();
		if (!repeat || !value.endsWith(repeat.token)) return false;
		const lines = [...this.composerLines, value.slice(0, -repeat.token.length) + repeat.content]
			.join("\n")
			.split("\n");
		this.pastes.settle();
		// Not setComposer: it types ctrl+e into the Input, which is still in the middle of this paste.
		const last = lines.pop() ?? "";
		this.composerLines = lines;
		this.composer.setValue(last);
		(this.composer as unknown as { cursor: number }).cursor = last.length;
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
				this.daemonNotice = result.restarted
					? ""
					: `background service is an older build — not restarted: ${result.reason ?? "unknown reason"}`;
			}
		}
		await this.refresh();
		if (this.closed) return;
		this.loaded = true;
		this.opts.ui.requestRender();
		this.pollTimer = setInterval(() => void this.refresh(), 1000);
	}

	/** Leave the view (also used when another terminal takes this session over). */
	close(): void {
		this.teardown();
		this.opts.onClose();
	}

	/** Every path that abandons the view: close, open, create-and-open. */
	private teardown(): void {
		this.closed = true;
		this.opening = undefined;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.spinTimer) clearInterval(this.spinTimer);
		if (this.armed) clearTimeout(this.armed.timer);
		this.pollTimer = this.spinTimer = undefined;
		this.opts.setTitle?.(undefined);
	}

	private composerText(): string {
		return [...this.composerLines, this.composer.getValue()].join("\n");
	}

	/** A task (or slash command) is typed, as opposed to nothing or a filter. */
	private composing(): boolean {
		const text = this.composerText();
		return !!text.trim() && !queryFilter(text);
	}

	private composerCursorAtEnd(): boolean {
		const cursor = (this.composer as unknown as { cursor?: number }).cursor;
		return cursor === undefined || cursor === this.composer.getValue().length;
	}

	private setComposer(text: string): void {
		const lines = text.split("\n");
		this.composer.setValue(lines.pop() ?? "");
		this.composerLines = lines;
		this.composer.handleInput("\x05"); // ctrl+e: cursor to the end
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
			// ctrl+v attaches an image as an [Image #N] token, as in Claude Code; the same image again
			// shows its file. Text arrives by the terminal's own paste.
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

	private say(text: string, kind: "hint" | "error" = "hint"): void {
		this.notice = { text, kind };
		this.render_();
	}

	// ---- data ----------------------------------------------------------------------------

	private async refresh(): Promise<void> {
		if (this.refreshing || this.closed) return;
		this.refreshing = true;
		try {
			this.instances = (await this.opts.client.list()).filter((inst) => inst.id !== this.opts.hide);
			this.connectionLost = false;
		} catch {
			this.connectionLost = true;
		} finally {
			try {
				this.shells = this.opts.panes.listShells();
			} catch {
				this.shells = [];
			}
			this.refreshing = false;
		}
		if (this.closed) return; // Its self callback may already belong to a disposed session.
		this.recompute();
		this.render_();
	}

	private recompute(): void {
		this.allRows = [...collectRows(this.instances, this.opts.self?.()), ...this.shells.map(rowFromShell)];
		// A new pane's placeholder gives way to its row once it registers, keeping the focus.
		for (const placeholder of this.pending.filter((p) => p.pane)) {
			const row = this.allRows.find((r) => r.pane === placeholder.pane);
			if (!row) continue;
			this.pending = this.pending.filter((p) => p !== placeholder);
			if (this.selectedKey === placeholder.id) this.selectedKey = row.id;
		}
		this.followStopping();
		const all = [...this.allRows, ...this.pending, ...(this.stopping ? [this.stopping.row] : [])];
		const text = this.composerText();
		const filter = queryFilter(text);
		this.rows = filter ? all.filter(filter) : all;
		this.onboarding =
			this.viewMode === "state" && !text && this.allRows.every((r) => r.self) && !this.allRows[0]?.pinned;
		const bands = buildBands(this.rows, this.viewMode, (p) => this.shorten(p), {
			launcherCwd: this.opts.cwd,
			onboarding: this.onboarding,
		});
		this.items = this.layoutItems(bands, !!filter);
		const at = this.items.findIndex((item) => item.key === this.selectedKey);
		if (filter && /^n:\S/i.test(text.trim())) {
			// A name search focuses its best match.
			const best = this.items
				.filter((i): i is Extract<Item, { kind: "row" }> => i.kind === "row")
				.reduce<Extract<Item, { kind: "row" }> | undefined>(
					(top, i) => (!top || nameScore(i.row, text) > nameScore(top.row, text) ? i : top),
					undefined,
				);
			if (best) this.selectedKey = best.key;
		} else if (!this.userMoved && this.items[at]?.kind !== "row") {
			// Until the user moves, the focus follows rows as they arrive.
			this.selectedKey = this.homeKey();
		} else if (at !== -1) this.lastIndex = at;
		else {
			// The focused row went away (deleted, filtered out, folded): its neighbour takes over.
			this.selectedKey = this.items[Math.min(this.lastIndex, this.items.length - 1)]?.key;
		}
		this.syncSpinner();
		this.syncTitle();
	}

	/** Where the focus starts: the session this view was opened from, else the first row when it
	 *  is in this directory, else the first header. */
	private homeKey(): string | undefined {
		const rows = this.items.filter((item) => item.kind === "row");
		const self = rows.find((item) => item.row.self);
		if (self) return self.key;
		const first = rows[0];
		return (first && first.row.cwd === this.opts.cwd ? first : this.items[0])?.key;
	}

	/** Claude Code's header budget: `used` lines go to live rows and band headers; when the full
	 *  header leaves fewer than 3 for Idle, it shrinks to the counts line. */
	private layoutBudget(): { compact: boolean; doneCap: number } {
		const live = this.rows.filter((r) => stateBandOf(r) !== "idle" || r.pinned);
		const used =
			live.filter((r) => !this.collapsed.has(r.pinned ? "pinned" : stateBandOf(r))).length +
			Math.max(0, new Set(live.map((r) => (r.pinned ? "pinned" : stateBandOf(r)))).size * 2 - 1);
		const free = (header: number) => this.opts.ui.terminal.rows - 8 - header - used;
		return free(4) >= 3 ? { compact: false, doneCap: free(4) } : { compact: true, doneCap: Math.max(0, free(2)) };
	}

	/** Bands → selectable items. A long Idle band folds into `… N more`, as Claude Code's does:
	 *  only when at least 3 would hide, keeping runs that finished together and the session you
	 *  came from. */
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
					for (const row of rows.slice(0, shown)) items.push({ kind: "row", key: row.id, band, row });
					items.push({ kind: "more", key: `more:${band.key}`, band, hidden: rows.length - shown });
					continue;
				}
			}
			for (const row of rows) items.push({ kind: "row", key: row.id, band, row });
		}
		return items;
	}

	/** How many Idle rows show before the fold; all of them when it would not fold. */
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
		const spinning = !!this.opening || this.rows.some((row) => row.state === "working" && row.alive);
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

	/** Where a new session runs: the selected directory when grouped by directory, else here. */
	private dispatchCwd(): string {
		if (this.viewMode !== "directory") return this.opts.cwd;
		const item = this.selected;
		if (item?.kind === "row") return item.row.cwd;
		if (item?.band.key.startsWith("dir:")) return item.band.key.slice(4);
		return this.opts.cwd;
	}

	// ---- actions -------------------------------------------------------------------------

	/** ↑/↓ wrap around, as Claude Code's do; paging and home/end stop at the ends. The peek moves
	 *  over sessions only, and so does onboarding, whose headers are labels. */
	private move(delta: number, opts: { rowsOnly?: boolean; wrap?: boolean } = {}): void {
		const rowsOnly = opts.rowsOnly || this.onboarding;
		const candidates = rowsOnly ? this.items.filter((i) => i.kind === "row") : this.items;
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
		this.lastIndex = Math.max(
			0,
			this.items.findIndex((i) => i.key === key),
		);
		this.userMoved = true;
		this.navigated = true;
		this.notice = undefined;
		this.reply.setValue(this.replyDrafts.get(key) ?? "");
		this.reply.handleInput("\x05");
		this.replyError = undefined;
		this.render_();
	}

	/** ctrl/alt+↑↓: to the previous or next band header, not wrapping. */
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

	/** Starts a session from the composer. The draft clears at once, and comes back if the start
	 *  fails while the composer is still empty; several starts can be in flight. */
	private async dispatch(open: boolean): Promise<void> {
		if (this.pasting) return;
		const draft = this.composerText();
		// Text tokens are sent as what was pasted; image tokens stay, and their images go along.
		const task = this.pastes.expandText(draft).trim();
		const images = this.pastes.imagesIn(draft);
		if (task.length < 4 && images.length === 0) {
			this.say("Too short — describe the task");
			return;
		}
		const cwd = this.dispatchCwd();
		const model = this.dispatchModel;
		this.startPane(open, draft, task, images, cwd, model);
	}

	/** Pane mode: a new session is a pi of its own, started with the task as its first prompt.
	 *  Its row is a placeholder until the pane registers. */
	private startPane(
		open: boolean,
		draft: string,
		task: string,
		images: string[],
		cwd: string,
		model: { provider: string; id: string } | undefined,
	): void {
		const panes = this.opts.panes;
		let pane: string;
		try {
			pane = panes.start(cwd, [
				...(model ? ["--model", `${model.provider}/${model.id}`] : []),
				"--",
				...images.map((file) => `@${file}`),
				...(task ? [task] : []),
			]);
			this.clearDraft();
		} catch (error) {
			this.setComposer(draft);
			this.say(`Couldn't start it — ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (open) {
			this.leaveFor(pane);
			return;
		}
		const placeholder: AgentRow = {
			id: `pending:${pane}`,
			label: labelFromTask(task || "Image task"),
			cwd,
			state: "working",
			alive: true,
			detail: "starting…",
			pinned: false,
			self: false,
			pane,
			createdAt: new Date().toISOString(),
		};
		this.pending.push(placeholder);
		this.selectedKey = placeholder.id;
		this.userMoved = true;
		this.recompute();
		this.render_();
		// A pi that never registers (it failed to start) stops being shown as starting.
		setTimeout(() => {
			this.pending = this.pending.filter((p) => p !== placeholder);
			if (!this.closed) void this.refresh();
		}, PANE_START_MS);
	}

	/** Pane mode: show `pane` in this terminal; this view closes so its session shows on return. */
	private leaveFor(pane: string): void {
		try {
			this.opts.panes.switchTo(pane);
		} catch (error) {
			this.say(`Couldn't open — ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		this.close();
	}

	/** Pane mode: open a row. A pane is switched to; a session with no pane gets one. */
	private async openPane(row: AgentRow, panes: PaneOps, sessionFile: string): Promise<void> {
		if (row.pane) {
			this.leaveFor(row.pane);
			return;
		}
		this.opening = row.id;
		this.render_();
		let pane: string;
		try {
			pane = panes.start(row.cwd, ["--session", sessionFile]);
		} catch (error) {
			this.opening = undefined;
			this.say(`Couldn't open — ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		// The pane's own row replaces the stored one.
		await this.opts.client.delete(row.id).catch(() => undefined);
		if (this.closed || this.opening !== row.id) {
			if (!this.closed) await this.refresh();
			return; // cancelled: it runs on in the background
		}
		this.opening = undefined;
		this.leaveFor(pane);
	}

	/** Enter / →: show the session in this terminal; the one here keeps running in its own pane. */
	/** A `!` command: a row of its own, in its own tmux session. */
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
		// A `!` command opens on its output.
		if (row.shell) {
			this.mode = "peek";
			this.reply.setValue("");
			this.render_();
			return;
		}
		if (row.self) {
			this.close();
			return;
		}
		if (row.id.startsWith("pending:") || !row.sessionFile) {
			this.say(
				!row.alive && !row.sessionFile
					? "No session file recorded — use /resume to reopen its saved conversation"
					: "Still starting — try again in a moment",
			);
			return;
		}
		await this.openPane(row, this.opts.panes, row.sessionFile);
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

	/**
	 * The row ctrl+x stopped keeps the focus and the armed delete: it stands in until its pi has
	 * saved it as a stopped row, which then takes its place.
	 */
	private followStopping(): void {
		const stopping = this.stopping;
		if (!stopping) return;
		const file = stopping.row.sessionFile;
		const live = this.allRows.find((r) => r.id === stopping.row.id && r.alive);
		const saved = file ? this.allRows.find((r) => r.sessionFile === file && !r.alive) : undefined;
		if (saved) {
			this.stopping = undefined;
			if (this.selectedKey === stopping.row.id) this.selectedKey = saved.id;
			if (this.armed?.key === stopping.row.id) this.armed.key = saved.id;
			if (this.justKilled === stopping.row.id) this.justKilled = saved.id;
			return;
		}
		if (live) {
			// Still on its way out: the live row shows until it goes.
			this.allRows = this.allRows.filter((r) => r !== live);
			return;
		}
		if (Date.now() > stopping.until) this.stopping = undefined;
	}

	/** The stored row a stopped pi saved for `file`, waiting a moment for it to arrive. */
	private async savedRowFor(file: string): Promise<string | undefined> {
		for (let i = 0; i < STOP_SAVE_POLLS; i++) {
			const saved = (await this.opts.client.list().catch(() => [])).find(
				(inst) => !inst.external && inst.sessionFile === file,
			);
			if (saved) return saved.id;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		return undefined;
	}

	/** ctrl+x, as Claude Code's: a running session's pi ends on the first press and its row stays,
	 *  stopped; the second press (within 2s) deletes the row. */
	private async stopOrDelete(): Promise<void> {
		const item = this.selected;
		if (!item || item.kind === "more") return;
		if (item.kind === "header") {
			const targets = item.band.rows.filter((r) => !r.self && !r.id.startsWith("pending:"));
			if (targets.length === 0 || this.composing()) return;
			if (this.armed?.key === item.key) {
				this.disarm();
				await Promise.all(
					targets
						.map(async (r) => {
							if (r.shell) return this.opts.panes.kill(r.shell);
							if (r.pane) this.opts.panes.kill(r.pane);
							await this.opts.client.delete(r.id);
						})
						.map((p) => p.catch(() => undefined)),
				);
				await this.refresh();
				return;
			}
			this.arm(item.key);
			return;
		}
		const row = item.row;
		if (row.shell) {
			// As Claude Code's: the first press stops a running command, the second removes the row.
			if (this.armed?.key === row.id) {
				this.disarm();
				this.opts.panes.kill(row.shell);
				if (this.mode === "peek") this.mode = "list";
				await this.refresh();
				return;
			}
			this.arm(row.id);
			if (row.alive) {
				this.justKilled = row.id;
				try {
					this.opts.panes.stopShell(row.shell);
				} catch (error) {
					this.say(`Couldn't stop — ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				await this.refresh();
			}
			return;
		}
		if (row.self) {
			if (this.armed?.key === row.id) {
				this.disarm();
				await this.deleteOwnPane(row, this.opts.panes);
				return;
			}
			this.arm(row.id);
			if (stoppable(row)) {
				this.justKilled = row.id;
				this.opts.onStopSelf?.();
				await this.refresh();
			}
			return;
		}
		if (row.id.startsWith("pending:")) return;
		if (this.armed?.key === row.id) {
			this.disarm();
			const stopping = this.stopping?.row.id === row.id ? this.stopping.row : undefined;
			this.stopping = undefined;
			try {
				if (row.pane && row.alive) this.opts.panes.kill(row.pane);
				// Its pi may still be saving the row it leaves behind: that is the one to delete.
				const id = stopping?.sessionFile ? ((await this.savedRowFor(stopping.sessionFile)) ?? row.id) : row.id;
				await this.opts.client.delete(id);
				if (this.mode === "peek") this.mode = "list";
			} catch (error) {
				this.say(`Couldn't delete — ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			await this.refresh();
			return;
		}
		this.arm(row.id);
		if (row.pane && stoppable(row)) {
			this.justKilled = row.id;
			this.stopping = {
				row: { ...row, alive: false, state: "stopped", pane: undefined },
				until: Date.now() + STOP_SAVE_POLLS * 150,
			};
			try {
				this.opts.panes.end(row.pane);
			} catch (error) {
				this.stopping = undefined;
				this.say(`Couldn't stop — ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			await this.refresh();
		}
	}

	/** Pane mode: this terminal moves to a new session, in agent view, and this pane ends. */
	private async deleteOwnPane(row: AgentRow, panes: PaneOps): Promise<void> {
		let next: string | undefined;
		this.leaving = true;
		this.say("Deleting…");
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
			this.leaving = false;
			if (next) {
				try {
					panes.kill(next);
				} catch {
					// it ended already
				}
			}
			this.say(`Couldn't delete — ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		this.teardown();
		await panes.unlist();
		await this.opts.client.delete(row.id).catch(() => undefined);
		try {
			panes.kill(panes.current);
		} catch {
			// This pi stays, in the background; its row is back with its next heartbeat.
		}
	}

	private async togglePin(): Promise<void> {
		const row = this.selectedRow;
		if (!row || row.id.startsWith("pending:")) return;
		if (row.shell) {
			this.say("A shell command can't be pinned");
			return;
		}
		const verb = row.pinned ? "unpin" : "pin";
		try {
			await this.opts.client.setMeta(row.id, { pinned: !row.pinned });
			this.collapsed.delete("pinned");
		} catch (error) {
			this.say(`Couldn't ${verb} — ${error instanceof Error ? error.message : String(error)}`, "error");
		}
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
		if (!row || row.id.startsWith("pending:")) return;
		if (row.shell) {
			this.say("A shell command can't be renamed");
			return;
		}
		this.renameInput.setValue(row.label);
		this.renameInput.handleInput("\x05"); // ctrl+e: cursor to the end, after the current name
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

	/** Brings a past session back into the list and opens it, as Claude Code's picker does. */
	private async resumePast(past: PastSession): Promise<void> {
		if (this.rows.some((r) => r.sessionFile === past.sessionFile)) {
			this.say("This session is already in the list — press enter on its row", "error");
			return;
		}
		this.mode = "list";
		try {
			this.leaveFor(this.opts.panes.start(past.cwd, ["--session", past.sessionFile]));
		} catch (error) {
			this.say(`Couldn't resume — ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	/** Leave pi itself (ctrl+c twice, exit words, /exit): background sessions keep running. */
	private quit(): void {
		this.close();
		this.opts.panes.detach();
	}

	/** `/model <name>`: an exact `provider/id` or id, else the only one it starts. */
	private setModel(arg: string): void {
		if (!arg) {
			this.say("Usage: /model <name> — session-scoped, not persisted");
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

	/** Slash commands agent view runs itself. A known command that needs a session says so; any
	 *  other `/text` (a skill, a prompt template) is a task. Returns whether it was handled. */
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
			default:
				if (!this.opts.isKnownCommand?.(command)) return false;
		}
		this.say(`/${command} isn't available in agent view — open a session to run it`);
		return true;
	}

	private async sendReply(row: AgentRow): Promise<void> {
		const text = this.reply.getValue().trim();
		if (!text && !row.shell) {
			void this.open(row);
			return;
		}
		this.replyError = undefined;
		if (row.shell) {
			if (text === "/stop" && row.alive) {
				this.reply.setValue("");
				this.opts.panes.stopShell(row.shell);
				await this.refresh();
				return;
			}
			if (text) this.replyError = "a shell command takes no reply — ctrl+x stops it";
			this.render_();
			return;
		}
		if (text === "/stop" && row.alive && row.state === "working") {
			this.reply.setValue("");
			this.replyDrafts.delete(row.id);
			if (row.self) {
				this.opts.onStopSelf?.();
				await this.refresh();
				return;
			}
			await this.opts.client.send(row.id, { type: "abort" }).catch((error) => {
				this.replyError = `Couldn't stop — ${error instanceof Error ? error.message : String(error)}`;
			});
			await this.refresh();
			return;
		}
		if (row.self) {
			this.teardown();
			this.opts.onSelfReply?.(text);
			this.opts.onClose();
			return;
		}
		await this.replyToPane(row, text, this.opts.panes);
	}

	/** Pane mode: a reply is the session's next prompt (queued behind a turn in progress). A
	 *  session with no pane gets one, with the reply as its first prompt. */
	private async replyToPane(row: AgentRow, text: string, panes: PaneOps): Promise<void> {
		try {
			if (row.pane) {
				if (row.state === "needs") {
					this.replyError = "it's waiting on a question — enter opens it to answer";
					this.render_();
					return;
				}
				await this.opts.client.send(row.id, { type: "prompt", text });
			} else if (row.sessionFile && !row.alive) {
				panes.start(row.cwd, ["--session", row.sessionFile, "--", text]);
				await this.opts.client.delete(row.id).catch(() => undefined);
			} else {
				this.replyError = "enter opens it";
				this.render_();
				return;
			}
			this.reply.setValue("");
			this.replyDrafts.delete(row.id);
		} catch (error) {
			this.replyError = `Couldn't send — ${error instanceof Error ? error.message : String(error)}`;
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

	private isUp(data: string): boolean {
		return getKeybindings().matches(data, "tui.select.up") || matchesKey(data, "ctrl+p");
	}

	private isDown(data: string): boolean {
		return getKeybindings().matches(data, "tui.select.down") || matchesKey(data, "ctrl+n");
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
		if (this.mode === "resume") {
			this.handleResumeInput(data);
			return;
		}
		if (this.mode === "rename") {
			this.handleRenameInput(data);
			return;
		}
		// While a session opens only cancelling (esc, ctrl+c, ↑/↓) is listened to.
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
			// Help stays open while moving; any other key closes it and then does its own thing.
			if (!this.isUp(data) && !this.isDown(data)) this.mode = "list";
		}
		if (this.handleCommonKey(data)) return;
		if (this.mode === "peek") this.handlePeekInput(data);
		else this.handleListInput(data);
	}

	/** ctrl+c clears the draft and arms the exit in one press; a second within 800ms quits. */
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

	/** esc: close the peek, then help, then clear the draft, then disarm, then go back. */
	private handleEsc(): void {
		if (this.mode === "peek") this.closePeek();
		else if (this.mode === "help") this.mode = "list";
		else if (this.composerText() || this.pasting) {
			this.clearDraft();
			this.restoreFocusAfterFilter();
			this.recompute();
		} else if (this.armed) this.disarm();
		else if (!this.opts.self?.()) {
			// No session of this terminal's to return to: as in Claude Code, esc quits.
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

	/** Keys that act the same in the list and the peek. */
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
		if (matchesKey(data, "ctrl+g")) {
			if (peek) this.closePeek();
			else void this.editExternally();
			this.render_();
			return true;
		}
		if (!peek && (matchesKey(data, "shift+up") || matchesKey(data, "shift+down"))) {
			void this.reorder(matchesKey(data, "shift+up") ? -1 : 1);
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
			if (peek) this.move(delta, { rowsOnly: true, wrap: true });
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

	/** ↑/↓ while a task is typed pick where it runs: a directory in the directory view. */
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

	/** ctrl+f: turn the typed text into a name search, or back. A state filter stays as it is. */
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
			if (!this.isNewline(data)) this.composer.handleInput("\x7f"); // a trailing \ asks for a newline
			this.composerLines.push(this.composer.getValue());
			this.composer.setValue("");
			this.afterComposerEdit(text);
			return;
		}
		// A paste token deletes as one unit, as in the prompt.
		const value = this.composer.getValue();
		const token = this.pastes.ranges(value).at(-1);
		if (matchesKey(data, "backspace") && token?.end === value.length && this.composerCursorAtEnd()) {
			this.composer.setValue(value.slice(0, token.start));
			this.composer.handleInput("\x05");
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
		if (matchesKey(data, "tab")) return;
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
					i.kind === "row" && i.row.cwd === cwd && !i.row.id.startsWith("pending:") ? [i.row] : [],
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
			// Space never types into an empty composer: on a session it opens the peek.
			if (matchesKey(data, "space")) {
				if (item?.kind === "row") {
					this.mode = "peek";
					this.reply.setValue(this.replyDrafts.get(item.key) ?? "");
					this.reply.handleInput("\x05");
					this.render_();
				}
				return;
			}
		}
		this.composer.handleInput(data);
		this.afterComposerEdit(text);
	}

	/** What enter does: quit on an exit word, run a view command, start a task, or act on the focus. */
	private handleEnter(ctrlEnter: boolean): void {
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
		// !command runs it in the user's shell as a row of its own, as in Claude Code.
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

	/** After the composer changed: notices clear, and a filter keeps the focus it had before it. */
	private afterComposerEdit(before: string): void {
		const after = this.composerText();
		if (after !== before) this.notice = undefined;
		const wasFilter = !!queryFilter(before);
		const isFilter = !!queryFilter(after);
		if (isFilter && !wasFilter) this.beforeFilter = this.selectedKey;
		this.recompute();
		if (!isFilter && wasFilter) {
			this.restoreFocusAfterFilter();
			this.recompute();
		}
		// A filter being typed focuses its first match, not whatever header survived it.
		if (isFilter && !/^n:\S/i.test(after.trim())) {
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

	private modelLabel(): string {
		if (this.dispatchModel === this.opts.model && this.opts.modelName) return this.opts.modelName;
		if (!this.dispatchModel) return "";
		const name = `${this.dispatchModel.provider}/${this.dispatchModel.id}`;
		return this.dispatchModel === this.opts.model ? name : `${name} (session)`;
	}

	/** Mascot beside name, model · cwd and the counts; only the counts when the list needs the room. */
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
		// The same static mascot as the welcome header. Its box ends in a blank cell (the wave's
		// swing room), so one more space makes a 2-cell gap.
		return renderMascot(REST, mascotGlyphs()).map((art, i) => `${art} ${text[i] ?? ""}`);
	}

	private icon(row: AgentRow, focused: boolean): string {
		if (this.opening === row.id) return SPINNER[this.frame];
		const glyph =
			this.justKilled === row.id || !row.alive ? "∙" : row.state === "working" ? SPINNER[this.frame] : "✻";
		// Working has no color of its own: gray, or the text color when focused.
		if (row.state === "working") return cc.fg(focused ? "text" : "muted", glyph);
		return cc.fg(ICON_COLOR[row.state], glyph);
	}

	private armedFor(row: AgentRow): boolean {
		const key = this.armed?.key;
		return (
			!!key &&
			(key === row.id || this.items.some((i) => i.kind === "header" && i.key === key && i.band.rows.includes(row)))
		);
	}

	private rowDetail(row: AgentRow, focused: boolean): string {
		if (this.opening === row.id)
			return cc.fg(
				"muted",
				row.state === "working"
					? "opening after its current tool finishes… · esc to cancel"
					: "opening… · esc to cancel",
			);
		if (this.armedFor(row)) {
			return cc.fg(
				"error",
				this.justKilled === row.id ? "stopped · ctrl+x again to delete" : "ctrl+x again to delete",
			);
		}
		let text = clean(row.detail);
		// Not prompted yet: what to do about it, which depends on where the focus is.
		if (row.state === "idle") {
			text = !focused ? "send a prompt to start" : row.self ? basename(row.cwd) : "space to send it a prompt";
		}
		if (this.viewMode !== "directory") return cc.fg("muted", text);
		const word = STATE_WORDS[row.state];
		const shown = row.state === "working" ? word : cc.fg(WORD_COLOR[row.state], word);
		return text ? `${shown}${cc.fg("muted", ` · ${text}`)}` : shown;
	}

	private renderRow(row: AgentRow, width: number, labelWidth: number, ageWidth: number, focused: boolean): string {
		const pad = width >= 120 ? " " : "";
		let name = truncateToWidth(clean(row.label), labelWidth, "…");
		if (this.mode === "rename" && focused) {
			const line = (this.renameInput.render(labelWidth + 2)[0] ?? "").replace(/^> /, "");
			name = truncateToWidth(line, labelWidth);
		} else if (row.self) name = theme.bold(focused ? cc.fg("text", name) : name);
		else name = focused ? cc.fg("text", name) : cc.fg("muted", name);
		const age = rowAge(row, Date.now()).padStart(ageWidth);
		const fixed = visibleWidth(pad) + 2 + labelWidth + 2 + 2 + ageWidth;
		const detailWidth = Math.max(0, width - fixed);
		const detail = truncateToWidth(this.rowDetail(row, focused), detailWidth, "…");
		const line =
			`${pad}${this.icon(row, focused)} ${name}${" ".repeat(Math.max(0, labelWidth - visibleWidth(name)))}  ` +
			`${detail}${" ".repeat(Math.max(0, detailWidth - visibleWidth(detail)))}  ${cc.fg("muted", age)}`;
		const fitted = truncateToWidth(line, width);
		if (!focused || this.composing()) return fitted;
		return cc.bg("userMessageBg", `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`);
	}

	/** The band a typed task would start in: Working, or the focused directory. */
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
		// With more than one band, the focused row's band stands out a little.
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
		const helper: Record<string, string> = {
			needs: "Sessions that have a question or need your decision land here",
			working: "Sessions actively working — they keep running even if you close the terminal",
			idle: "Sessions with nothing running wait here",
		};
		const bandCount = this.items.filter((i) => i.kind === "header").length;
		let first = true;
		for (const item of this.items) {
			const focused = item.key === this.selectedKey;
			if (item.kind === "header") {
				if (!first) lines.push("");
				first = false;
				if (focused) focusLine = lines.length;
				lines.push(this.renderBand(item, width, focused, bandCount));
				if (this.onboarding && helper[item.band.key]) {
					lines.push(...wrapTextWithAnsi(cc.fg("muted", helper[item.band.key]), width - 1).map((l) => ` ${l}`));
				}
				continue;
			}
			first = false;
			if (focused) focusLine = lines.length;
			if (item.kind === "more") {
				const text = `${width >= 120 ? " " : ""}… ${item.hidden} more`;
				lines.push(
					focused && !this.composing()
						? cc.bg("userMessageBg", cc.fg("text", text.padEnd(width)))
						: cc.fg("muted", text),
				);
			} else lines.push(this.renderRow(item.row, width, labelWidth, ageWidth, focused));
		}
		return { lines, focusLine };
	}

	/** Everything above the composer, scrolled as one: Claude Code's header scrolls with its list. */
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

	/** Inline markdown as Claude Code's peek shows a result: dim, with `code`, **bold** and ++x++ bold. */
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
			// A `!` command's peek is its output, as much of the end as fits.
			let output: string[] = [];
			try {
				output = this.opts.panes.capture(row.shell, cap);
			} catch {
				// its session is gone
			}
			for (const line of output.slice(-cap)) body.push(truncateToWidth(clean(line), inner, "…"));
		} else if (text) body.push(...wrapTextWithAnsi(shown, inner).slice(0, cap));
		const since = row.state === "needs" ? row.finishedAt : undefined;
		if (since) {
			body.push(
				cc.fg(ICON_COLOR[row.state], `  waiting ${compactAge(Date.now() - (Date.parse(since) || Date.now()))}`),
			);
		}
		body.push("");
		body.push(promptLine(this.reply, inner, "reply"));
		if (this.replyError) body.push(truncateToWidth(`\x1b[2m${cc.fg("error", this.replyError)}\x1b[22m`, inner, "…"));
		const border = (l: string, r: string) => faint(`${l}${"─".repeat(Math.max(0, width - 2))}${r}`);
		const boxed = [border("╭", "╮")];
		for (const line of body) {
			const fitted = truncateToWidth(line, inner);
			boxed.push(`${faint("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${faint("│")}`);
		}
		boxed.push(border("╰", "╯"));
		const typed = !!this.reply.getValue();
		const pending = row.id.startsWith("pending:");
		const enter = typed ? "send" : this.resumable(row) ? "resume" : "open";
		boxed.push(
			this.hints(width, [
				typed || !pending ? `enter to ${enter}` : undefined,
				typed ? "esc to close" : "space to close",
				`ctrl+x to ${this.armedFor(row) ? "confirm" : "delete"}`,
			]),
		);
		return boxed;
	}

	/** A finished or stopped run with no process: enter starts it again. */
	private resumable(row: AgentRow): boolean {
		// A shell command is never run again for you, as in Claude Code.
		return !row.shell && !row.alive && (row.state === "failed" || row.state === "stopped");
	}

	/** `/resume`: a bordered box over the composer, as Claude Code's picker. */
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

	/** `?`: the shortcut grid, under the composer in place of the hint line. */
	private renderHelp(width: number): string[] {
		const item = this.selected;
		const row = item?.kind === "row" && !item.row.id.startsWith("pending:") ? item.row : undefined;
		const cwd = item?.kind === "row" ? item.row.cwd : this.opts.cwd;
		const alt = Math.min(
			9,
			this.items.filter((i) => i.kind === "row" && i.row.cwd === cwd && !i.row.id.startsWith("pending:")).length,
		);
		const opt = process.platform === "darwin" ? "opt" : "alt";
		const items = [
			...(row && (this.viewMode === "directory" || row.pinned) ? ["shift+↑↓ to reorder"] : []),
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
		// Items stack three to a column, each column as wide as its longest item and 4 apart.
		// Where that does not fit, the columns grow taller instead of wrapping an item.
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

	/** One dim hint line; too narrow, it is cut with an ellipsis rather than dropping items. */
	private hints(width: number, items: Array<string | undefined>, lead?: string): string {
		const line = items.filter((i): i is string => !!i).join(" · ");
		// The lead keeps its own color; the items after it stay muted.
		const text = lead ? `${lead}${line ? cc.fg("muted", ` · ${line}`) : ""}` : cc.fg("muted", line);
		return truncateToWidth(`  ${text}`, width, "…");
	}

	/** The line under the composer: whatever is most pressing, else what the keys do here. */
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
			(this.connectionLost ? "lost connection to the background service — showing the last known list" : "");
		if (service) return truncateToWidth(`  ${cc.fg("warning", service)}`, width, "…");
		return this.listHints(width);
	}

	private listHints(width: number): string {
		const text = this.composerText();
		const item = this.selected;
		const composing = this.composing();
		const row = item?.kind === "row" && !item.row.id.startsWith("pending:") ? item.row : undefined;
		let enter: string | undefined;
		if (composing) enter = "enter to create";
		else if (row) enter = `enter to ${row.self ? "return" : this.resumable(row) ? "resume" : "open"}`;
		const headerRows =
			item?.kind === "header" ? item.band.rows.filter((r) => !r.self && !r.id.startsWith("pending:")) : [];
		let x: string | undefined;
		if (width >= 80 && !text) {
			if (row) x = "ctrl+x to delete";
			else if (item?.kind === "header" && this.navigated && headerRows.length > 0) x = "ctrl+x to delete all";
		}
		const find = composing && !text.trim().startsWith("/") && width >= 49 ? "ctrl+f to find" : undefined;
		return this.hints(
			width,
			[
				enter,
				item?.kind === "header" && !text && !this.onboarding
					? `enter to ${this.collapsed.has(item.band.key) ? "expand" : "collapse"}`
					: undefined,
				item?.kind === "more" && !text ? "enter to show all" : undefined,
				item?.kind === "row" && !text && width >= 55 ? "space to reply" : undefined,
				x,
				text ? "esc to clear" : "? for shortcuts",
				find,
			],
			this.opts.mode,
		);
	}

	/** The composer: every line, the first after `❯`, the rest from the left edge. */
	private composerLinesFor(width: number, dim: boolean): string[] {
		const lines = this.composerLines.map((line, i) => truncateToWidth(i === 0 ? `❯ ${line}` : line, width));
		const current = promptLine(this.composer, width, lines.length ? "" : "describe a task for a new session");
		lines.push(lines.length ? current.replace(/^❯ /, "") : current);
		if (this.pasting) lines.push(truncateToWidth(cc.fg("muted", "Reading clipboard…"), width));
		return dim ? lines.map((line) => faint(stripAnsi(line))) : lines;
	}

	render(width: number): string[] {
		if (this.loaded && !this.drawn) {
			this.drawn = true;
			// Once this frame has reached the terminal: tmux takes the mark and the output by different ways.
			if (this.opts.onDrawn) setTimeout(this.opts.onDrawn, 30);
		}
		const rows = this.opts.ui.terminal.rows;
		const rule = faint("─".repeat(width));
		let footer: string[];
		if (this.mode === "peek" && this.selectedRow) footer = this.renderPeek(this.selectedRow, width);
		else if (this.mode === "resume") footer = this.renderResume(width);
		else {
			// Explains the view above the composer while only your own session is listed.
			const intro =
				this.allRows.every((r) => r.self) && !this.composerText()
					? [
							"",
							...wrapTextWithAnsi(
								cc.fg(
									"muted",
									"A different way to work: hand off a bigger task than you would chat through, and it is organized in the sections above so you know when it needs you.",
								),
								width - 1,
							).map((line) => ` ${line}`),
							"",
						]
					: [];
			footer = [
				...intro,
				rule,
				...this.composerLinesFor(width, this.mode === "rename"),
				rule,
				...(this.mode === "help" ? this.renderHelp(width) : [this.footerSlot(width)]),
			];
		}

		const { lines: body, focusLine } = this.renderBody(width);
		const budget = Math.max(1, rows - footer.length);
		// Scroll only as far as keeps the focus in view; a header brings its blank line along.
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

/** Claude Code's ctrl+x stops a session in Working or Needs input first, and deletes the rest. */
function stoppable(row: AgentRow): boolean {
	return row.alive && (row.state === "working" || row.state === "needs" || row.state === "idle");
}

/** Claude Code's whitespace cleanup for a row's text: tags dropped, every run of space one space. */
function clean(text: string): string {
	return text
		.replace(/<(system-reminder|task-notification)>[\s\S]*?(<\/\1>|$)/g, " ")
		.replace(/<\/?[\w-]+>/g, " ")
		.replace(/[\x00-\x1f\x7f\s]+/g, " ")
		.trim();
}

/** A path cut in the middle to fit: `~/a/…/c/d`, else `…/d`. */
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

/** Clipboard images as files, for a new pane's pi to take as `@file` arguments. */
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
