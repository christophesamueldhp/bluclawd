import { existsSync, statSync } from "node:fs";
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
} from "@earendil-works/pi-tui";
import { theme } from "../_shared/theme.ts";
import { BranchCache } from "./branch-cache.ts";
import { countStatuses, describeStatus, matchesQuery, relativeTime, sortForRoster } from "./fleet-status.ts";
import { NewSessionPanel } from "./new-session-panel.ts";
import { currentDaemonBuildId, type InstanceSummary, type OrchestratorClient } from "./orchestrator-client.ts";

function shortenPath(path: string, home: string): string {
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return p;
}

function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function parseModelSpec(spec: string): { provider: string; id: string } | undefined {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

/** Collapse rows that share a session file to ONE, preferring the most-alive twin (online over a
 *  stopped/saved row). This drops the old "Done" twin right after a resume AND the case that used to
 *  slip through: after a daemon restart, recoverAfterRestart persists the former-live session as
 *  "stopped" while the disk scan also returns it as `saved:<id>` — two NON-online twins for the same
 *  file. Rows without a session file are always kept. Order = position of the first twin seen. */
function dedupeBySessionFile(instances: InstanceSummary[]): InstanceSummary[] {
	const rank = (i: InstanceSummary): number => (i.status === "online" ? 0 : 1);
	const bestByFile = new Map<string, InstanceSummary>();
	const result: InstanceSummary[] = [];
	for (const inst of instances) {
		if (!inst.sessionFile) {
			result.push(inst);
			continue;
		}
		const existing = bestByFile.get(inst.sessionFile);
		if (!existing) {
			bestByFile.set(inst.sessionFile, inst);
			result.push(inst);
		} else if (rank(inst) < rank(existing)) {
			// A more-alive twin turned up — replace the weaker one in place (keep its position).
			result[result.indexOf(existing)] = inst;
			bestByFile.set(inst.sessionFile, inst);
		}
	}
	return result;
}

function windowAround(lines: string[], focusRow: number, budget: number): string[] {
	if (lines.length <= budget) return lines;
	let start = Math.max(0, focusRow - Math.floor(budget / 2));
	start = Math.min(start, lines.length - budget);
	return lines.slice(start, start + budget);
}

export interface FleetViewOptions {
	ui: TUI;
	client: OrchestratorClient;
	appName: string;
	version?: string;
	model?: string;
	/** Foreground's active model, forwarded to spawned children so they match it. */
	spawnModel?: { provider: string; id: string };
	cwd: string;
	home: string;
	mascotLines: string[] | null;
	selfId?: string;
	onClose: () => void;
	onJumpIn: (sessionFile: string, cwd: string) => void;
	/** Create a fresh session in the foreground (chosen cwd/model/task), backgrounding the current
	 *  one — the "new session" analogue of onJumpIn. When set, "New session" opens it in-window
	 *  instead of spawning a background daemon child. */
	onCreateSession?: (cwd: string, model: { provider: string; id: string } | undefined, task: string) => void;
	/** Load persisted (on-disk) sessions as resumable rows, so they survive daemon restarts / bluclawd
	 *  exits. Returns FleetView rows (status "stopped"); already filtered for hidden + empty. */
	loadSavedSessions?: () => Promise<InstanceSummary[]>;
	/** The set of session files the user has "deleted" (hidden) — loaded once per open so previously
	 *  deleted sessions stay gone. Applied to the WHOLE merged list (live + saved). */
	loadHiddenSessions?: () => Set<string>;
	/** "Delete" a session from FleetView — hides it from the list; the .jsonl stays on disk. */
	hideSession?: (sessionFile: string) => void;
	onAttach?: (instanceId: string, label: string) => void;
}

/** Minimum time an action-result `notice` stays on screen before it can self-clear
 *  (IMPROVEMENT-PLAN.md §5.1g) — long enough to actually read "reply failed" on a real terminal. */
const NOTICE_DWELL_MS = 3000;

export class FleetView implements Component, Focusable {
	focused = false;

	private readonly opts: FleetViewOptions;
	private instances: InstanceSummary[] = [];
	/** Persisted on-disk sessions (loaded once per open), merged with the live daemon list. */
	private savedSessions: InstanceSummary[] = [];
	/** Session files "deleted" (hidden) from the view — filtered out of the merged list. */
	private hidden = new Set<string>();
	private ordered: InstanceSummary[] = [];
	private selectedIndex = 0;
	/** Identity of the selected row, so selection survives the 1s poll reordering/removing rows —
	 *  every action reads ordered[selectedIndex], which would otherwise silently point at a different
	 *  session after a refresh. Re-anchored in recompute(). */
	private selectedId: string | undefined;
	/** True once ↑/↓ has been pressed; before that the highlight stays on the top row. */
	private userMoved = false;
	/** Set once close() runs, so an in-flight onShow() doesn't install a poll timer on a dead view.
	 *  One-way by design and never reset — safe only because the host (`showFleetView()`) always
	 *  constructs a fresh FleetView on each open rather than reusing a closed one. If that ever
	 *  changes, a closed-then-reopened view would need `closed` reset in onShow(), or every guard
	 *  above would permanently refuse to (re)install its poll timer (IMPROVEMENT-PLAN.md §5.2). */
	private closed = false;
	/** Type-to-search, as in Claude Code's /resume picker: filters title, path and branch. */
	private readonly search = new Input();
	/** Claude Code's /resume defaults to the current project; this defaults to ALL projects so the
	 *  "N awaiting input" header never hides a running session. ctrl+a toggles, as there. */
	private allProjects = true;
	private readonly branches = new BranchCache(() => {
		if (this.closed) return;
		this.recompute(); // a query may match the branch that just landed
		this.opts.ui.requestRender();
	});
	private readonly replyInput = new Input();
	private readonly newSession = new NewSessionPanel();
	private creating = false;
	/** Action-result message (e.g. "reply failed"); set via setNotice(), which self-clears after
	 *  NOTICE_DWELL_MS on its own timer — NOT tied to refresh()'s poll cycle, so a fast successful
	 *  poll right after an error can't wipe it before the user has had a chance to read it
	 *  (IMPROVEMENT-PLAN.md §5.1g). */
	private notice = "";
	private noticeTimer: ReturnType<typeof setTimeout> | undefined;
	// Set once per onShow() (daemon reachability/staleness), never cleared by a poll tick —
	// otherwise it would flash for under a second and vanish. Shown whenever there's no more
	// pressing transient `notice` to display instead.
	private daemonStatusNotice = "";
	/** Set when a poll's list() call fails and cleared the moment one succeeds again — so a
	 *  daemon that dies mid-view says so, instead of leaving the last-known rows on screen with
	 *  no indication they've stopped updating (IMPROVEMENT-PLAN.md §5.1c). Independent of
	 *  `notice`'s dwell timer: once `notice` self-clears, render() falls through to this tier, so
	 *  a stale action-failure message can no longer mask a live disconnect indefinitely. */
	private connectionLost = false;
	private confirmDeleteId: string | null = null;
	private replyTarget: InstanceSummary | null = null;
	private showShortcuts = false;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private refreshing = false;

	constructor(opts: FleetViewOptions) {
		this.opts = opts;
	}

	async onShow(): Promise<void> {
		const ok = await this.opts.client.ensureDaemon();
		// ensureDaemon() can take seconds on a cold start; the user may esc out during any await
		// below. If they did, bail before installing the 1s poll — otherwise it runs forever on a
		// hidden overlay (clearPolling() in close() no-op'd because pollTimer was still undefined).
		if (this.closed) return;
		this.daemonStatusNotice = "";
		if (!ok) {
			this.daemonStatusNotice =
				"daemon unavailable — couldn't start `node daemon/cli.ts serve` (see the package's daemon/)";
		} else {
			// Stale-daemon check (IMPROVEMENT-PLAN.md §4.5/§5.3): a daemon left running across a
			// local rebuild shares no version bump with what's on disk now, so compare build
			// identifiers, not just "is it reachable". getDaemonInfo()/currentDaemonBuildId()
			// never throw — a probe failure resolves to "can't tell", not an exception.
			const info = await this.opts.client.getDaemonInfo();
			if (this.closed) return;
			if (info.running && info.buildId !== currentDaemonBuildId()) {
				this.daemonStatusNotice = info.buildId
					? "daemon is running an older build — restart it (kill the `daemon/cli.ts serve` process, then reopen)"
					: "daemon predates version checks — restart it to enable them (kill the `daemon/cli.ts serve` process, then reopen)";
			}
		}
		// Load the deleted/hidden set so previously deleted sessions stay gone across reopens.
		this.hidden = this.opts.loadHiddenSessions?.() ?? new Set();
		// Load persisted sessions once per open (the disk scan is too costly for the 1s poll); the
		// live daemon list refreshes every second and is merged on top.
		if (this.opts.loadSavedSessions) {
			try {
				this.savedSessions = await this.opts.loadSavedSessions();
			} catch {
				// disk unavailable — just show the live daemon list
			}
		}
		if (this.closed) return;
		await this.refresh();
		if (this.closed) return;
		this.pollTimer = setInterval(() => void this.refresh(), 1000);
	}

	/** Torn down on every path that abandons this view (close, jumpInto's swap, foreground create)
	 *  — clears both the poll interval and any pending notice-dwell timeout, so neither can fire
	 *  requestRender() on a view nobody is looking at anymore. */
	private clearPolling(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		if (this.noticeTimer) clearTimeout(this.noticeTimer);
		this.noticeTimer = undefined;
	}

	/** Set (or clear) `notice` with a self-expiring dwell timer (IMPROVEMENT-PLAN.md §5.1g).
	 *  Clears any pending timer first — clear-and-rearm, not stack — so an older notice's timer
	 *  can never fire late and wipe a newer one still within its own dwell window. No-ops once
	 *  `closed`: an in-flight action's catch can still fire after the view was abandoned, and
	 *  arming a timer at that point would only leak it until it self-clears. */
	private setNotice(message: string): void {
		if (this.noticeTimer) clearTimeout(this.noticeTimer);
		this.noticeTimer = undefined;
		this.notice = message;
		if (!message || this.closed) return;
		this.noticeTimer = setTimeout(() => {
			this.noticeTimer = undefined;
			this.notice = "";
			this.opts.ui.requestRender();
		}, NOTICE_DWELL_MS);
	}

	private close(): void {
		this.closed = true;
		this.clearPolling();
		this.opts.onClose();
	}

	/** Take over a background session: stop its daemon child, then hand the .jsonl to the TUI. */
	private async jumpInto(target: InstanceSummary): Promise<void> {
		if (target.external) {
			// External (self-registered) sessions aren't daemon-owned and can't be taken over.
			if (target.id === this.opts.selfId) {
				this.close(); // you're already in this session
			} else {
				this.setNotice("that session is open in another window");
				this.opts.ui.requestRender();
			}
			return;
		}
		if (!target.sessionFile) {
			this.setNotice("this session has no file yet — try again in a moment");
			this.opts.ui.requestRender();
			return;
		}
		// A freshly spawned child reports its session-file PATH before it physically writes it (the
		// file lands only after the first turn persists). Taking over before then would `stop` the
		// child and load a missing file, silently leaving you in the current session. So if the file
		// isn't there yet, WAIT briefly for it to appear (a starting session becomes openable on its
		// own) instead of refusing outright; only give up if it never lands.
		if (!existsSync(target.sessionFile)) {
			this.setNotice("opening — session is still starting…");
			this.opts.ui.requestRender();
			for (let i = 0; i < 20 && !existsSync(target.sessionFile); i++) {
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
			if (!existsSync(target.sessionFile)) {
				this.setNotice("session isn't ready yet — try again in a moment (ctrl+t to watch it live)");
				this.opts.ui.requestRender();
				return;
			}
		}
		this.clearPolling();
		// Only a live daemon child needs stopping; a saved (stopped/on-disk) session just gets opened.
		if (target.status === "online") {
			try {
				await this.opts.client.stop(target.id);
			} catch {
				// Proceed anyway: the child is gone either way and the JSONL is append-safe.
			}
		}
		this.opts.onJumpIn(target.sessionFile, target.cwd);
	}

	private get query(): string {
		return this.search.getValue();
	}

	private recompute(): void {
		const scoped = this.allProjects ? this.instances : this.instances.filter((i) => i.cwd === this.opts.cwd);
		const query = this.query;
		this.ordered = sortForRoster(
			scoped.filter((i) => matchesQuery([i.label, i.sessionId, i.cwd, this.branches.get(i.cwd)], query)),
		);
		// Re-anchor selection to the SAME row by identity, so a poll that reorders/removes rows can't
		// silently move the highlight onto a different session (enter/ctrl+t/ctrl+r/space would then
		// act on the wrong one). Only fall back to the clamped index when the row is truly gone.
		// Until the user has moved, the highlight stays on the TOP row instead — live rows arrive
		// a poll or two after the saved ones and sort above them, and an anchored highlight would
		// otherwise open on whichever saved row happened to load first.
		const anchored =
			this.selectedId && this.userMoved ? this.ordered.findIndex((row) => row.id === this.selectedId) : -1;
		if (anchored !== -1) {
			this.selectedIndex = anchored;
		} else if (!this.userMoved || this.selectedIndex >= this.ordered.length) {
			this.selectedIndex = this.userMoved ? Math.max(0, this.ordered.length - 1) : 0;
		}
		this.selectedId = this.ordered[this.selectedIndex]?.id;
	}

	private async refresh(): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			// Live daemon rows first; saved on-disk rows fill in the rest. dedupeBySessionFile drops
			// a saved row when the same file is already live. Then drop any "deleted" (hidden)
			// session — applied to the WHOLE list so a hidden one can't sneak back in via a daemon
			// row (a stored stopped/Done row, or a re-backgrounded child).
			const merged = dedupeBySessionFile([...(await this.opts.client.list()), ...this.savedSessions]);
			this.instances = merged.filter((i) => !(i.sessionFile && this.hidden.has(i.sessionFile)));
			// `notice` is intentionally NOT cleared here — it self-expires on its own dwell timer
			// (setNotice()/IMPROVEMENT-PLAN.md §5.1g) so a fast successful poll can't wipe an error
			// before the user has had a chance to read it.
			this.connectionLost = false;
		} catch {
			// Keep the last known list (rows stay visible rather than vanishing), but say so —
			// otherwise a daemon that dies mid-view reads as silently frozen, not disconnected.
			this.connectionLost = true;
		} finally {
			this.refreshing = false;
		}
		this.recompute();
		this.opts.ui.requestRender();
	}

	private moveSelection(delta: number): void {
		if (this.ordered.length === 0) return;
		this.userMoved = true;
		this.selectedIndex = Math.max(0, Math.min(this.ordered.length - 1, this.selectedIndex + delta));
		this.selectedId = this.ordered[this.selectedIndex]?.id;
	}

	private startCreating(seed: string): void {
		const defaultPath = shortenPath(this.opts.cwd, this.opts.home);
		const defaultModel = this.opts.spawnModel ? `${this.opts.spawnModel.provider}/${this.opts.spawnModel.id}` : "";
		this.newSession.open({ path: defaultPath, model: defaultModel }, seed);
		this.creating = true;
		this.opts.ui.requestRender();
	}

	private async launchNewSession(): Promise<void> {
		const { path: rawPath, model: rawModel, task } = this.newSession.values();
		if (!task) {
			this.setNotice("task can't be empty");
			this.opts.ui.requestRender();
			return;
		}
		const cwd = expandHome(rawPath, this.opts.home) || this.opts.cwd;
		if (!isDirectory(cwd)) {
			this.setNotice(`path not found: ${rawPath}`);
			this.opts.ui.requestRender();
			return;
		}
		let model: { provider: string; id: string } | undefined;
		if (rawModel) {
			model = parseModelSpec(rawModel);
			if (!model) {
				this.setNotice("model must be provider/id");
				this.opts.ui.requestRender();
				return;
			}
		} else {
			model = this.opts.spawnModel;
		}
		this.creating = false;
		this.newSession.reset();
		if (this.opts.onCreateSession) {
			// Foreground: open the new session in THIS window (backgrounds the current one). The
			// overlay closes, so no list refresh is needed. Same teardown as jumpInto()'s swap:
			// clearPolling() stops an already-installed timer, and `closed = true` also stops a
			// STILL-IN-FLIGHT onShow() (ensureDaemon() can be slow on a cold start) from installing
			// a new one after this view has already been abandoned — the "zombie poll timer" class
			// close() already guards against on the esc path, unhandled here (IMPROVEMENT-PLAN.md
			// §5.2): each dead view reopens a socket connection roughly once a second, forever.
			this.closed = true;
			this.clearPolling();
			this.opts.onCreateSession(cwd, model, task);
			return;
		}
		// Fallback (no host wiring — e.g. tests): spawn as a background daemon child.
		let failed = false;
		try {
			await this.opts.client.spawn({ cwd, label: task.slice(0, 60), prompt: task, model });
		} catch {
			failed = true;
		}
		// Set the notice AFTER refresh(), not before — refresh()'s success path unconditionally
		// clears `notice`, so setting it first means it never renders at all (IMPROVEMENT-PLAN.md
		// §5.1a). Matches deleteSelected()'s already-correct ordering below.
		await this.refresh();
		if (failed) {
			this.setNotice("couldn't reach the daemon — is it running?");
			this.opts.ui.requestRender();
		}
	}

	/** Resume a non-running session by continuing its .jsonl as a fresh background child. */
	private async resumeSelected(target: InstanceSummary): Promise<void> {
		if (target.external || target.status === "online") {
			this.setNotice("that session is already running");
			this.opts.ui.requestRender();
			return;
		}
		if (!target.sessionFile) {
			this.setNotice("this session has no file to resume");
			this.opts.ui.requestRender();
			return;
		}
		let failed = false;
		try {
			await this.opts.client.spawn({
				cwd: target.cwd,
				label: target.label,
				sessionFile: target.sessionFile,
				model: this.opts.spawnModel,
			});
		} catch {
			failed = true;
		}
		// See launchNewSession()'s comment: set AFTER refresh(), which would otherwise wipe it.
		await this.refresh();
		if (failed) {
			this.setNotice("resume failed — is the daemon running?");
			this.opts.ui.requestRender();
		}
	}

	private async deleteSelected(target: InstanceSummary): Promise<void> {
		// Stop it only if it's a live daemon child; a saved (on-disk) row has nothing running.
		let stopFailed = false;
		if (target.status === "online" && !target.id.startsWith("saved:")) {
			try {
				await this.opts.client.stop(target.id);
			} catch {
				stopFailed = true;
			}
		}
		// Hide it from FleetView — the .jsonl stays on disk (still recoverable via /resume), so this
		// is a "remove from the list" delete, not a destructive file wipe. Track it in-memory too so
		// refresh filters it out even if the daemon keeps surfacing it as a stored/re-spawned row.
		// Unconditional even when stop() failed: the row is still hidden from view either way, so
		// the notice (below) is what has to tell the user whether the process actually stopped.
		if (target.sessionFile) {
			this.hidden.add(target.sessionFile);
			this.opts.hideSession?.(target.sessionFile);
			this.savedSessions = this.savedSessions.filter((s) => s.sessionFile !== target.sessionFile);
		}
		await this.refresh();
		// Brief confirmation (self-clears after NOTICE_DWELL_MS) so the delete is visible even in a
		// long list. stopFailed must win here — this used to be unconditional, silently overwriting
		// the "delete failed" notice above with a false confirmation (IMPROVEMENT-PLAN.md §5.1d found
		// this: stop() never actually rejected before that fix, so the branch was dead code).
		this.setNotice(
			stopFailed
				? "delete failed — hidden from this list, but the session may still be running"
				: "removed from the list — still resumable via /resume",
		);
		this.opts.ui.requestRender();
	}

	private async sendReply(target: InstanceSummary, text: string): Promise<void> {
		let failed = false;
		try {
			await this.opts.client.reply(target.id, text);
		} catch {
			failed = true;
		}
		// See launchNewSession()'s comment: set AFTER refresh(), which would otherwise wipe it.
		await this.refresh();
		if (failed) {
			this.setNotice("reply failed");
			this.opts.ui.requestRender();
		}
	}

	private renderShortcuts(width: number): string[] {
		const rows: Array<[string, string]> = [
			["↑ / ↓", "select session"],
			["type", "search — filters by title, path and branch"],
			["enter", "open — full session view in this window (others keep running)"],
			["ctrl+t", "peek — watch it work live, read-only (no takeover)"],
			["ctrl+r", "resume — restart a Done session as a background child"],
			["ctrl+n", "new session"],
			["ctrl+a", "show all projects / only the current one"],
			["space", "reply to the selected session"],
			["ctrl+x ×2", "delete the selected session"],
			["esc", "clear search / close"],
			["?", "toggle this help"],
		];
		const out = [theme.bold("Shortcuts"), ""];
		for (const [key, desc] of rows) {
			out.push(truncateToWidth(`  ${theme.fg("accent", key.padEnd(11))}${theme.fg("muted", desc)}`, width));
		}
		return out;
	}

	private isQuestionMark(data: string): boolean {
		return matchesKey(data, "?") || matchesKey(data, "shift+?");
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Shortcuts overlay: esc or ? closes it; everything else is ignored while it's open.
		if (this.showShortcuts) {
			if (kb.matches(data, "tui.select.cancel") || this.isQuestionMark(data)) {
				this.showShortcuts = false;
				this.opts.ui.requestRender();
			}
			return;
		}

		// New-session panel is modal: it consumes every key until launch or cancel.
		if (this.creating) {
			const result = this.newSession.handleInput(data);
			if (result === "cancel") {
				this.creating = false;
				this.newSession.reset();
				this.opts.ui.requestRender();
			} else if (result === "submit") {
				void this.launchNewSession();
			} else {
				this.opts.ui.requestRender();
			}
			return;
		}

		// Reply mode is modal: type the follow-up, enter sends, esc cancels.
		if (this.replyTarget) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.replyTarget = null;
				this.replyInput.setValue("");
				this.opts.ui.requestRender();
				return;
			}
			if (kb.matches(data, "tui.input.submit") || data === "\r" || data === "\n") {
				const text = this.replyInput.getValue().trim();
				if (text) void this.sendReply(this.replyTarget, text);
				this.replyTarget = null;
				this.replyInput.setValue("");
				return;
			}
			this.replyInput.handleInput(data);
			this.opts.ui.requestRender();
			return;
		}

		// ---- list mode ----
		if (matchesKey(data, "ctrl+x")) {
			// Second press confirms: delete the ARMED row found by id, NOT ordered[selectedIndex].
			// The 1s poll can reorder the merged list between the two presses (live sessions come and
			// go, shifting every row); keying off the current selection would then silently re-arm a
			// different row and never actually delete — which is exactly the "won't delete" symptom.
			if (this.confirmDeleteId !== null) {
				const armed = this.ordered.find((row) => row.id === this.confirmDeleteId);
				this.confirmDeleteId = null;
				if (armed) void this.deleteSelected(armed);
				this.opts.ui.requestRender();
				return;
			}
			const target = this.ordered[this.selectedIndex];
			if (!target) return;
			if (target.external) {
				this.setNotice("can't delete an external session");
				this.opts.ui.requestRender();
				return;
			}
			// First press arms the confirmation.
			this.confirmDeleteId = target.id;
			this.opts.ui.requestRender();
			return;
		}
		// Any other key cancels a pending delete confirmation.
		this.confirmDeleteId = null;

		// ctrl+t peeks: watch the selected session work live (read-only), without taking the seat.
		if (matchesKey(data, "ctrl+t")) {
			const target = this.ordered[this.selectedIndex];
			if (!target || !this.opts.onAttach) return;
			if (target.external) {
				this.setNotice(
					target.id === this.opts.selfId
						? "you're in this session already"
						: "that session is open in another window — nothing to peek at from here",
				);
			} else if (target.status !== "online") {
				this.setNotice("peek needs a running session — ctrl+r resumes it first");
			} else {
				// The host closes this overlay and opens the peek view in its place (then reopens a
				// FRESH roster on return) — same teardown as jumpInto()'s swap, or the poll leaks.
				this.closed = true;
				this.clearPolling();
				this.opts.onAttach(target.id, target.label || target.sessionId || target.id);
				return;
			}
			this.opts.ui.requestRender();
			return;
		}

		// ctrl+r resumes a non-running ("Done") session as a NEW parallel background child.
		if (matchesKey(data, "ctrl+r")) {
			const target = this.ordered[this.selectedIndex];
			if (target) void this.resumeSelected(target);
			return;
		}

		// ctrl+n opens the new-session panel (typing no longer does: it searches, as in /resume).
		if (matchesKey(data, "ctrl+n")) {
			this.startCreating("");
			return;
		}

		// ctrl+a toggles all projects / only the current one (Claude Code's /resume chord).
		if (matchesKey(data, "ctrl+a")) {
			this.allProjects = !this.allProjects;
			this.recompute();
			this.opts.ui.requestRender();
			return;
		}

		// '?' opens the shortcuts overlay — unless a search is being typed, where it's just text.
		if (this.isQuestionMark(data) && !this.query) {
			this.showShortcuts = true;
			this.opts.ui.requestRender();
			return;
		}

		// space replies to the selected session — unless a search is being typed, where it's text.
		if (matchesKey(data, "space") && !this.query) {
			const target = this.ordered[this.selectedIndex];
			if (target) {
				if (target.external) {
					this.setNotice("can't reply to an external session");
					this.opts.ui.requestRender();
					return;
				}
				this.replyTarget = target;
				this.opts.ui.requestRender();
			}
			return;
		}

		// esc clears an active search first; a second esc (or esc with no search) closes.
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.query) {
				this.search.setValue("");
				this.recompute();
				this.opts.ui.requestRender();
				return;
			}
			this.close();
			return;
		}

		// enter opens the selected session fully in this window (swap); the outgoing session is
		// handed to the daemon so it keeps running in parallel.
		if (kb.matches(data, "tui.input.submit") || data === "\r" || data === "\n") {
			const target = this.ordered[this.selectedIndex];
			if (!target) {
				this.close();
			} else {
				void this.jumpInto(target);
			}
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}

		// Everything else is search input (printable characters, backspace, cursor keys).
		this.search.handleInput(data);
		this.recompute();
		this.opts.ui.requestRender();
	}

	invalidate(): void {}

	/** Test seam: inject a known instance list without hitting the socket. */
	setInstancesForTest(instances: InstanceSummary[]): void {
		this.instances = dedupeBySessionFile(instances);
		this.recompute();
	}

	/** The visible rows' ids in display order (post dedupe/group) — for asserting dedupe. */
	orderedIdsForTest(): string[] {
		return this.ordered.map((row) => row.id);
	}

	/** The id of the currently-selected row — for asserting selection survives a refresh. */
	selectedIdForTest(): string | undefined {
		return this.selectedId;
	}

	render(width: number): string[] {
		const rows = this.opts.ui.terminal.rows;
		const counts = countStatuses(this.instances);
		const nowMs = Date.now();
		const dot = theme.fg("dim", "·");

		// Header: mascot on the left, a title / model·cwd / counts block on the right.
		const mascot = this.opts.mascotLines ?? [];
		const mascotWidth = mascot.length ? Math.max(...mascot.map(visibleWidth)) : 0;
		const titleLine = this.opts.version
			? `${theme.bold(this.opts.appName)} ${theme.fg("dim", `v${this.opts.version}`)}`
			: theme.bold(this.opts.appName);
		const subtitle = theme.fg(
			"muted",
			this.opts.model
				? `${this.opts.model} ${dot} ${shortenPath(this.opts.cwd, this.opts.home)}`
				: shortenPath(this.opts.cwd, this.opts.home),
		);
		const scope = this.allProjects ? "all projects" : "current project";
		const shown =
			this.ordered.length === this.instances.length
				? ""
				: ` ${dot} ${theme.fg("dim", `${this.ordered.length} of ${this.instances.length}`)}`;
		const countsLine = `${theme.fg("warning", `${counts.needsInput} awaiting input`)} ${dot} ${theme.fg("accent", `${counts.working} working`)} ${dot} ${theme.fg("success", `${counts.done} done`)} ${dot} ${theme.fg("dim", scope)}${shown}`;
		const textLines = [titleLine, subtitle, countsLine];
		// A daemon that never came up (or is stale) is the more specific message — "lost connection"
		// would only paraphrase it, and would mask the hint on how to fix it.
		if (this.notice) textLines.push(theme.fg("warning", this.notice));
		else if (this.daemonStatusNotice) textLines.push(theme.fg("warning", this.daemonStatusNotice));
		else if (this.connectionLost)
			textLines.push(theme.fg("warning", "lost connection to the daemon — showing the last known list"));

		const header: string[] = [];
		for (let i = 0; i < Math.max(mascot.length, textLines.length); i++) {
			const left = mascot[i] ?? "";
			const pad = " ".repeat(Math.max(0, mascotWidth - visibleWidth(left)));
			const right = textLines[i] ?? "";
			header.push(right ? truncateToWidth(`${left}${pad}  ${right}`, width) : left);
		}
		header.push("");
		// Search line, as in /resume: the query with a cursor, or a placeholder.
		if (!this.showShortcuts && !this.creating && !this.replyTarget) {
			header.push(this.query ? this.search.render(width)[0] : theme.fg("dim", "  Type to search"));
			header.push("");
		}

		// Body: two lines per session, Claude Code /resume style —
		//   › title                                   Working
		//       5m ago · main · 12 messages · ~/path
		const body: string[] = [];
		let selectedRow = 0;
		if (this.showShortcuts) {
			body.push(...this.renderShortcuts(width));
		} else if (this.ordered.length === 0) {
			const empty = this.query
				? `  No sessions match "${this.query}".`
				: this.allProjects
					? "  No sessions found — ctrl+n starts one"
					: "  No sessions in this project — ctrl+a shows all projects";
			body.push(truncateToWidth(theme.fg("dim", empty), width));
		} else {
			this.ordered.forEach((inst, index) => {
				const isSelected = index === this.selectedIndex;
				if (isSelected) selectedRow = body.length;
				const status = describeStatus(inst);
				// Unnamed sessions show the first 8 characters of their id, as Claude Code does.
				const rawName = (inst.label || (inst.sessionId || inst.id).slice(0, 8))
					.replace(/[\x00-\x1f\x7f]/g, " ")
					.trim();
				const selfTag = inst.id === this.opts.selfId ? theme.fg("dim", " (this session)") : "";
				const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
				const badge = theme.fg(status.color, status.label);
				const nameBudget = Math.max(10, width - 2 - visibleWidth(selfTag) - visibleWidth(badge) - 2);
				const name =
					(isSelected
						? theme.bold(truncateToWidth(rawName, nameBudget, "…"))
						: truncateToWidth(rawName, nameBudget, "…")) + selfTag;
				const left = `${cursor}${name}`;
				const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(badge));
				body.push(truncateToWidth(`${left}${" ".repeat(gap)}${badge}`, width));

				const details = [relativeTime(inst.lastSeenAt ?? inst.createdAt, nowMs), this.branches.get(inst.cwd)];
				if (inst.messageCount !== undefined) details.push(`${inst.messageCount} messages`);
				if (this.allProjects) details.push(shortenPath(inst.cwd, this.opts.home));
				body.push(truncateToWidth(theme.fg("dim", `    ${details.filter(Boolean).join(" · ")}`), width, "…"));
			});
		}

		const footer: string[] = [];
		footer.push(theme.fg("dim", "─".repeat(Math.max(0, width))));
		if (this.creating) {
			footer.push(...this.newSession.render(width));
		} else if (this.replyTarget) {
			footer.push(
				truncateToWidth(theme.fg("dim", `> reply to "${this.replyTarget.label || this.replyTarget.id}"`), width),
			);
			footer.push(this.replyInput.render(width)[0]);
		}
		const pendingDelete =
			this.confirmDeleteId !== null && this.ordered[this.selectedIndex]?.id === this.confirmDeleteId;
		if (pendingDelete) {
			footer.push(
				truncateToWidth(theme.fg("warning", "press ctrl+x again to delete · any other key cancels"), width),
			);
		} else if (this.creating) {
			footer.push(truncateToWidth(theme.fg("dim", "↑↓/tab field · enter launch · esc cancel"), width));
		} else if (this.replyTarget) {
			footer.push(truncateToWidth(theme.fg("dim", "enter send · esc cancel"), width));
		} else if (this.showShortcuts) {
			footer.push(truncateToWidth(theme.fg("dim", "? or esc to close"), width));
		} else {
			const scopeHint = this.allProjects ? "ctrl+a current project" : "ctrl+a all projects";
			const escHint = this.query ? "esc clear" : "esc close";
			footer.push(
				truncateToWidth(
					theme.fg("dim", "↑↓ select · enter open · ctrl+t peek · space reply · ctrl+r resume"),
					width,
				),
				truncateToWidth(theme.fg("dim", `ctrl+n new · ${scopeHint} · ctrl+x delete · ${escHint} · ? help`), width),
			);
		}

		const budget = Math.max(1, rows - header.length - footer.length);
		const windowed = windowAround(body, selectedRow, budget);
		const pad = Math.max(0, budget - windowed.length);
		return [...header, ...windowed, ...Array(pad).fill(""), ...footer];
	}
}
