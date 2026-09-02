/**
 * Statusline extension: the Claude Code status line, two ways.
 *
 * 1. The footer itself. `ctx.ui.setFooter` replaces pi's built-in footer with
 *    `CcStatuslineFooter` (./footer.ts), a widget-for-widget replica of the
 *    user's ccstatusline configuration — model, thinking effort, context slider,
 *    git owner/branch/changes, cwd, plan-usage sliders, token stats — plus a
 *    right-aligned context token counter above the prompt. Data pi's
 *    `ReadonlyFooterDataProvider` does not carry (origin owner, change counts,
 *    plan usage) comes from ./git-info.ts and ./usage-providers.ts. Everything
 *    that used to land on the built-in footer via `ctx.ui.setStatus` (permission
 *    mode, mcp, this extension's own external command) still shows: the custom
 *    footer renders `footerData.getExtensionStatuses()` as its last line.
 *
 * 2. Claude-Code-style *external* statusline commands: when
 *    `settings.statusline.command` is set, the command is run and its stdout is
 *    published via ctx.ui.setStatus("statusline", text), which the footer above
 *    shows on its status line. When the setting is unset, nothing runs.
 *
 * `/usage` and `/cost` (Claude Code's names) live here too rather than in
 * `diagnostics`: they report the plan-usage windows the footer's pollers hold,
 * and reading that state from another top-level extension would cross a
 * `pi.extensions` module-graph boundary (see `_shared/global-state.ts`).
 *
 * Payload delivery: the JSON payload is written to the command's STDIN (Claude
 * Code parity — real CC statusline scripts read stdin; review I5) AND exposed as
 * the BLUCLAWD_STATUSLINE_JSON env var (kept for scripts written against this
 * extension's original env-var-only delivery). Both go through exec's per-child
 * `stdin`/`env` options, so nothing mutates process.env (which would race across
 * concurrent refreshes).
 *
 * Non-blocking: `turn_end` fires INLINE in the agent loop (pi-agent-core awaits
 * emit() before the next round-trip, and turn_end fires on every tool-calling
 * round-trip, not once per user message). So refresh() must NOT be awaited by the
 * handlers, or a slow statusline.command would add up to its 5s timeout of latency
 * to every round-trip. The handlers fire it detached (void refresh().catch(...));
 * the status line updating a beat late is fine, blocking the agent is not. The
 * git-branch sub-exec also carries its own short timeout so it can't hang unbounded.
 * A module-scoped isRefreshing guard drops any refresh that starts while another is
 * still in flight (the next turn_end refreshes anyway) — this both prevents
 * out-of-order status updates from overlapping detached runs and bounds concurrent
 * child processes to one.
 *
 * intervalMs (settings.statusline.intervalMs): when set alongside command, a
 * periodic refresh timer runs between turns (clamped to MIN_INTERVAL_MS). The
 * timer is (re)started on session_start — which also makes /reload pick up
 * setting changes — and cleared on session_shutdown. Module-scoped handle so the
 * factory's double trust-resolving pass never leaks a second timer; unref'd so
 * it can never keep a headless process alive. Ticks reuse refresh()'s in-flight
 * guard, so a slow command coalesces instead of stacking.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { readStoredCredential, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../_shared/ansi.ts";
import { execWithIo } from "../_shared/exec.ts";
import * as forkSettings from "../_shared/settings.ts";
import {
	CcStatuslineFooter,
	ContextTokenCount,
	formatTokens,
	isUsingSubscription,
	type SessionTotals,
	sumSessionUsage,
} from "./footer.ts";
import { GitInfo } from "./git-info.ts";
import {
	type OpencodeGoUsageData,
	OpencodeGoUsageProvider,
	UsageDataProvider,
	type UsageWindowData,
} from "./usage-providers.ts";

/** Env var carrying the JSON payload to the external statusline command. */
export const STATUSLINE_ENV_VAR = "BLUCLAWD_STATUSLINE_JSON";

/** Cap on the rendered status text, independent of terminal width (the footer
 * truncates to terminal width separately at render time; this just bounds how
 * much a runaway command's stdout can inflate in-memory status state). */
const MAX_STATUS_CHARS = 200;

/** Timeout for the main statusline command. Detached, so it no longer blocks the
 * agent loop; 5s is a generous ceiling before we give up and clear. */
const COMMAND_TIMEOUT_MS = 5000;

/** Timeout for the git-branch sub-exec so a hung git can't stall the refresh. */
const GIT_TIMEOUT_MS = 2000;

/** Floor for statusline.intervalMs — smaller configured values clamp up to this
 * so a typo (e.g. `5`) can't spawn a shell command hundreds of times a second. */
export const MIN_INTERVAL_MS = 250;

/**
 * Module-scoped in-flight guard. Module scope (not factory closure) is deliberate:
 * the factory may run twice per trust-resolving load, and a shared guard drops
 * overlapping refreshes across both handler registrations. Reset in refresh()'s
 * finally block.
 */
let isRefreshing = false;

/**
 * Module-scoped periodic-refresh timer. Module scope for the same reason as
 * isRefreshing: the factory may run twice per trust-resolving load, and both
 * passes' session_start handlers restart the same slot instead of leaking a
 * second timer.
 */
let intervalTimer: ReturnType<typeof setInterval> | undefined;
/**
 * The interval the LIVE timer is running at, in ms — undefined when none runs.
 *
 * `/statusline` used to re-read settings from disk, but the timer is only built at
 * session_start, so editing intervalMs mid-session made the command report a
 * refresh rate that was not the one in effect — the exact misreporting the clamp
 * note beside it was written to prevent.
 */
let activeIntervalMs: number | undefined;

function stopIntervalTimer(): void {
	if (intervalTimer !== undefined) {
		clearInterval(intervalTimer);
		intervalTimer = undefined;
	}
}

/**
 * The live data sources behind the custom footer. Module-scoped for the same
 * reason as the timers above: session_start may fire more than once per
 * process (double factory pass, /reload, session switch) and each start must
 * replace — not stack — the pollers of the previous one.
 */
let footerRuntime: { git: GitInfo; usage: UsageDataProvider; goUsage: OpencodeGoUsageProvider } | undefined;

/**
 * Latest context seen by any handler. The footer reads model, thinking level,
 * context usage, and session entries through it on every render; its getters
 * are live, so one captured reference stays current for the whole session.
 */
let latestCtx: ExtensionContext | undefined;

function disposeFooterRuntime(): void {
	footerRuntime?.git.dispose();
	footerRuntime?.usage.dispose();
	footerRuntime?.goUsage.dispose();
	footerRuntime = undefined;
}

/** Replace pi's footer with the ccstatusline replica and start its data pollers. */
function installFooter(ctx: ExtensionContext): void {
	disposeFooterRuntime();
	const git = new GitInfo(ctx.cwd);
	const usage = new UsageDataProvider(() => readStoredCredential("anthropic"));
	const goUsage = new OpencodeGoUsageProvider();
	footerRuntime = { git, usage, goUsage };

	ctx.ui.setFooter((tui, theme, footerData) => {
		const repaint = () => tui.requestRender();
		const unsubscribe = [
			git.onChange(repaint),
			usage.onChange(repaint),
			goUsage.onChange(repaint),
			footerData.onBranchChange(repaint),
		];
		const footer = new CcStatuslineFooter(
			{
				ctx: () => latestCtx,
				gitBranch: () => footerData.getGitBranch(),
				gitOriginOwner: () => git.getOriginOwner(),
				gitChanges: () => git.getChanges(),
				usage: () => usage.getUsageData(),
				goUsage: () => goUsage.getUsageData(),
				extensionStatuses: () => footerData.getExtensionStatuses(),
			},
			theme,
		);
		return Object.assign(footer, {
			dispose: () => {
				for (const off of unsubscribe) off();
			},
		});
	});
	ctx.ui.setWidget(
		"statusline-context-tokens",
		(_tui, theme) => new ContextTokenCount(() => latestCtx?.getContextUsage()?.tokens, theme),
		{ placement: "aboveEditor" },
	);

	usage.start();
	goUsage.start();
}

/** Snapshot rendered by `/usage`. Plain data so it survives in the session file. */
export interface UsageReport {
	model?: string;
	subscription: boolean;
	totals: SessionTotals;
	claude: UsageWindowData | null;
	go: OpencodeGoUsageData | null;
}

/**
 * The `/usage` (and `/cost`) report: this session's spend and token totals,
 * followed by whichever plan-usage windows the footer pollers have. Exported
 * pure for tests; `theme` is the only styling dependency.
 */
export function formatUsageReport(
	report: UsageReport,
	theme: { bold(s: string): string; fg(color: "dim", s: string): string },
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const lines: string[] = [theme.bold("Session usage")];
	const t = report.totals;
	lines.push(`${dim("Model:")} ${report.model ?? "none selected"}`);
	lines.push(
		`${dim("Cost:")} $${t.cost.toFixed(4)}${report.subscription ? dim(" (subscription — not billed per token)") : ""}`,
	);
	lines.push(
		`${dim("Tokens:")} ↑${formatTokens(t.input)} in · ↓${formatTokens(t.output)} out · cache read ${formatTokens(t.cacheRead)} · cache write ${formatTokens(t.cacheWrite)}`,
	);
	if (t.latestCacheHitRate !== undefined) {
		lines.push(`${dim("Cache hit (last turn):")} ${t.latestCacheHitRate.toFixed(1)}%`);
	}

	const resetSuffix = (iso: string | undefined): string => {
		if (!iso) return "";
		const at = new Date(iso);
		return Number.isNaN(at.getTime()) ? "" : dim(` (resets ${at.toLocaleString()})`);
	};

	const claude = report.claude;
	if (claude && (claude.sessionUsage !== undefined || claude.weeklyUsage !== undefined)) {
		lines.push("", theme.bold("Plan usage (Claude)"));
		if (claude.sessionUsage !== undefined) {
			lines.push(`${dim("Session (5h):")} ${claude.sessionUsage.toFixed(0)}%${resetSuffix(claude.sessionResetAt)}`);
		}
		if (claude.weeklyUsage !== undefined) {
			lines.push(`${dim("Weekly:")} ${claude.weeklyUsage.toFixed(0)}%${resetSuffix(claude.weeklyResetAt)}`);
		}
	}

	const go = report.go;
	if (go && (go.rolling || go.weekly || go.monthly)) {
		lines.push("", theme.bold("Plan usage (OpenCode Go)"));
		for (const [label, window] of [
			["Session (5h)", go.rolling],
			["Weekly", go.weekly],
			["Monthly", go.monthly],
		] as const) {
			if (window) lines.push(`${dim(`${label}:`)} ${window.usagePercent.toFixed(0)}%${resetSuffix(window.resetAt)}`);
		}
	}

	if (!claude && !go) {
		lines.push(
			"",
			dim("No plan usage available: Claude windows need an Anthropic OAuth login (/login);"),
			dim("OpenCode Go windows need OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE."),
		);
	}
	return lines;
}

/**
 * Sanitize a command's stdout line for safe single-line TUI rendering. The output
 * is trusted config (statusline.command) but can still emit ANSI/OSC escapes,
 * cursor moves, or stray control bytes that would corrupt the terminal. Strip ANSI
 * escape sequences via the shared stripAnsi util, then remove any remaining C0
 * control chars and DEL (the footer's own sanitizer only handles \r\n\t, not these).
 */
function sanitizeStatusOutput(text: string): string {
	return stripAnsi(text).replace(/[\x00-\x1f\x7f]/g, "");
}

export interface StatuslinePayload {
	model: string;
	branch: string | null;
	cwd: string;
	contextPct: number | null;
	costUsd: number;
}

/**
 * Pure helper: total cost in USD summed over assistant messages' usage.cost.total.
 * Modeled on FooterComponent.render's cost accumulation (footer.ts ~L91-100), but
 * exported as a plain function over an array so it's unit-testable without a live
 * session. contextPct is deliberately NOT computed here: it requires the model's
 * live contextWindow (ctx.getContextUsage()), which isn't derivable from messages
 * alone — the handler below fetches it separately, keeping this function pure.
 */
export function computeFooterStats(messages: AgentMessage[]): {
	costUsd: number;
} {
	let costUsd = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			costUsd += message.usage.cost.total;
		}
	}
	return { costUsd };
}

/**
 * Run the statusline command and push its output to the footer. Detached from the
 * agent loop (see file header): never awaited by the handlers, never throws, and
 * drops itself if another refresh is already in flight.
 */
async function refresh(ctx: ExtensionContext, exec: typeof execWithIo): Promise<void> {
	// statusline.command is arbitrary shell: project-scope settings apply ONLY when
	// the user trusted the project (an untrusted repo's .bluclawd/settings.json
	// must never execute — mirrors web/index.ts's trust-aware settings read).
	const command = forkSettings
		.statusline(
			SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			}),
		)
		?.command?.trim();
	if (!command) return; // unset: leave the built-in footer untouched
	if (isRefreshing) return; // overlap guard: the next turn_end will refresh anyway
	isRefreshing = true;

	try {
		const messages: AgentMessage[] = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "message") messages.push(entry.message);
		}
		const { costUsd } = computeFooterStats(messages);

		const branchResult = await exec("git", ["branch", "--show-current"], {
			cwd: ctx.cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		const branchOut = branchResult?.code === 0 ? branchResult.stdout.trim() : "";
		const branch = branchOut.length > 0 ? branchOut : null;

		const payload: StatuslinePayload = {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			branch,
			cwd: ctx.cwd,
			contextPct: ctx.getContextUsage()?.percent ?? null,
			costUsd,
		};

		const payloadJson = JSON.stringify(payload);
		const result = await exec("bash", ["-c", command], {
			cwd: ctx.cwd,
			timeout: COMMAND_TIMEOUT_MS,
			stdin: payloadJson,
			env: { [STATUSLINE_ENV_VAR]: payloadJson },
		});

		if (result.killed || result.code !== 0) {
			ctx.ui.setStatus("statusline", undefined);
			return;
		}

		const firstLine = sanitizeStatusOutput(result.stdout.split("\n")[0] ?? "").trim();
		ctx.ui.setStatus("statusline", firstLine ? truncateToWidth(firstLine, MAX_STATUS_CHARS) : undefined);
	} catch {
		// Never throw out of a detached refresh. Clear rather than show stale data.
		ctx.ui.setStatus("statusline", undefined);
	} finally {
		isRefreshing = false;
	}
}

/**
 * Extension factory. Idempotent at registration time: the body below only calls
 * on() (no exec/timer work), so it is safe to run twice per load (bootstrap +
 * final trust-resolving pass). All command execution is deferred to event handlers,
 * and fired detached so it never blocks the agent loop.
 */
export function factory(pi: ExtensionAPI): void {
	// Fire-and-forget: do NOT await refresh() (see file header — turn_end is inline
	// in the agent loop). The inner .catch is redundant with refresh()'s own
	// try/catch but guards against an unhandled rejection if that ever regresses.
	const fire = (ctx: ExtensionContext) => {
		latestCtx = ctx;
		void refresh(ctx, execWithIo).catch(() => {});
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") installFooter(ctx);
		fire(ctx);

		// (Re)start the periodic refresh timer. Restarting on every session_start
		// keeps exactly one timer alive across the factory's double pass and lets
		// /reload pick up statusline setting changes. Trust-aware settings read,
		// same as refresh().
		stopIntervalTimer();
		const statusline = forkSettings.statusline(
			SettingsManager.create(ctx.cwd, undefined, {
				projectTrusted: ctx.isProjectTrusted(),
			}),
		);
		const intervalMs = statusline?.intervalMs;
		if (!statusline?.command?.trim() || typeof intervalMs !== "number" || !Number.isFinite(intervalMs)) return;
		activeIntervalMs = Math.max(intervalMs, MIN_INTERVAL_MS);
		intervalTimer = setInterval(() => fire(ctx), activeIntervalMs);
		// Never keep a headless process alive just to repaint a footer.
		intervalTimer.unref?.();
	});
	pi.on("session_shutdown", () => {
		stopIntervalTimer();
		disposeFooterRuntime();
	});
	pi.on("turn_end", (_event, ctx) => fire(ctx));

	pi.registerEntryRenderer<UsageReport>("bluclawd:usage", (entry, _options, theme) => {
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new Text(entry.data ? formatUsageReport(entry.data, theme).join("\n") : "", 1, 0));
		return container;
	});

	const usageHandler = async (_args: string, ctx: ExtensionContext): Promise<void> => {
		const model = ctx.model;
		pi.appendEntry<UsageReport>("bluclawd:usage", {
			model: model ? `${model.provider}/${model.id}` : undefined,
			subscription: isUsingSubscription(ctx),
			totals: sumSessionUsage(ctx),
			claude: footerRuntime?.usage.getUsageData() ?? null,
			go: footerRuntime?.goUsage.getUsageData() ?? null,
		});
	};
	pi.registerCommand("usage", {
		description: "Show session cost, token totals, and plan usage",
		handler: usageHandler,
	});
	pi.registerCommand("cost", {
		description: "Show session cost and token totals (same as /usage)",
		handler: usageHandler,
	});

	pi.registerCommand("statusline", {
		description: "Show the external status line command and how it refreshes",
		handler: async (_args, ctx) => {
			const statusline = forkSettings.statusline(
				SettingsManager.create(ctx.cwd, undefined, {
					projectTrusted: ctx.isProjectTrusted(),
				}),
			);
			const command = statusline?.command?.trim();
			if (!command) {
				ctx.ui.notify(
					[
						"No status line command configured.",
						"",
						'Set statusline.command in settings.json, e.g. { "statusline": { "command": "npx -y ccstatusline@latest" } }.',
						"It receives session JSON on stdin and its first line of stdout becomes the status line.",
					].join("\n"),
					"info",
				);
				return;
			}
			// Report the RUNNING timer, not the file: the two diverge whenever
			// intervalMs is edited mid-session, and the running one is the answer to
			// "how often does this refresh?".
			const configured = statusline?.intervalMs;
			const lines = [`Status line: ${command}`];
			if (activeIntervalMs === undefined) {
				lines.push("Refresh: after each turn only — set statusline.intervalMs for a periodic refresh");
			} else {
				lines.push(`Refresh: every ${activeIntervalMs}ms between turns (floor ${MIN_INTERVAL_MS}ms)`);
			}
			if (typeof configured === "number" && Number.isFinite(configured)) {
				const wouldRunAt = Math.max(configured, MIN_INTERVAL_MS);
				if (wouldRunAt !== activeIntervalMs) {
					lines.push(`Settings now say ${configured}ms — /reload to apply it to this session.`);
				} else if (configured !== activeIntervalMs) {
					lines.push(`(configured ${configured}ms, clamped up to the ${MIN_INTERVAL_MS}ms floor)`);
				}
			} else if (activeIntervalMs !== undefined) {
				lines.push("Settings no longer set intervalMs — /reload to stop the periodic refresh.");
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

const statuslineExtension: InlineExtension = { name: "statusline", factory };
export default statuslineExtension.factory;
