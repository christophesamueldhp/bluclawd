# Powerline Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the user-selected features of pi-powerline-footer 0.17.1 (MIT, nicobailon) into bluclawd natively — no dependency on that package, no powerline presets/layout.

**Architecture:** Each feature lands in the bluclawd extension that already owns its surface: context/cost/git behaviour in `ext/statusline`, the welcome content in `ext/branding`, `!` sandbox parity in `ext/sandbox`. Features with no owner get a new extension: `ext/shell` (bash mode + stash — they share one custom editor), `ext/queue`, `ext/vibes`. The existing ccstatusline-replica footer stays the only footer.

**Tech Stack:** TypeScript on pi (`@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`), vitest, biome, tmux for live verification.

**Approved decisions (2026-09-16/17, do not re-ask):**
- No powerline presets/layout, no dependency on pi-powerline-footer; port what is needed.
- `!` and bash mode follow Claude Code: they run OUTSIDE the sandbox even when it is on (CC docs: "commands you type in shell mode run outside the sandbox even when you've enabled sandboxing"). Model-run commands stay sandboxed.
- Bash mode is a persistent shell (cd/export/alias survive). Ghost-text completions are out of scope.
- Queue: hold input during compaction, `/compact <text>`, `/queue` list/send/retry/clear. Cross-project aliases/targets are out of scope. (Later skipped — see Tier 4.)
- Vibes: off by default, session model by default (provider-neutral rule), `/vibe model` override, file mode.
- Welcome: powerline's content goes into the existing mascot banner's sidebar; no separate overlay.
- Currency: powerline's list plus IDR. Labels `(subscription)` / `(per token)` stay.
- Already shipped (f5641b8): git counts refresh after tool calls; `~N tokens` estimate after compaction.

**Working-tree hygiene:** other sessions keep uncommitted work in this tree (`ext/_shared/settings.ts`, `ext/subagents`, `ext/mcp`, `ext/web`, `test/registration.test.ts`). Stage only this plan's hunks. For a file with foreign hunks, build the staged blob from `git show HEAD:<file>` plus this plan's change and stage it with `git hash-object -w` + `git update-index --cacheinfo`. Never `git stash` the shared tree. Commits: the user authorized committing each tier once its tests and live verification pass; pushes still need asking.

---

## Tier 1 — Statusline: context colors, live streaming context, cost currency

**Done: 0b53ac3.**

### Task 1.1: Context slider turns yellow past 70% and red past 90%

**Files:**
- Modify: `ext/statusline/footer.ts` (SGR table, `renderInfoLine`)
- Test: `test/statusline-footer.test.ts` (`describe("CcStatuslineFooter")`)

- [x] **Step 1: Write the failing test** — inside `describe("CcStatuslineFooter", ...)`, after the line-1 test:

```ts
	it("colors the context slider yellow past 70% and red past 90%", () => {
		const line1 = (percent: number) =>
			new CcStatuslineFooter(
				sources({
					ctx: () =>
						({
							...sources().ctx(),
							getContextUsage: () => ({ percent, tokens: percent * 10, contextWindow: 1000 }),
						}) as never,
				}),
				fakeTheme,
			).render(100)[0];
		expect(line1(70)).toContain("\x1b[1;97m▓▓▓▓▓▓▓░░░");
		expect(line1(71)).toContain("\x1b[1;93m▓▓▓▓▓▓▓░░░");
		expect(line1(90)).toContain("\x1b[1;93m▓▓▓▓▓▓▓▓▓░");
		expect(line1(91)).toContain("\x1b[1;91m▓▓▓▓▓▓▓▓▓░");
	});
```

- [x] **Step 2: Run it** — `npx vitest run test/statusline-footer.test.ts -t "colors the context slider"` → FAIL (71 renders `97`).

- [x] **Step 3: Implement** — in `footer.ts` add `redBright: 91,` to `SGR`, add below `makeSliderBar`:

```ts
/** Context slider color: yellow once compaction is worth planning for, red once it is close. */
export function contextSliderColor(percent: number): "whiteBright" | "yellowBright" | "redBright" {
	if (percent > 90) return "redBright";
	if (percent > 70) return "yellowBright";
	return "whiteBright";
}
```

and in `renderInfoLine` replace `paint("whiteBright", makeSliderBar(contextUsage.percent))` with `paint(contextSliderColor(contextUsage.percent), makeSliderBar(contextUsage.percent))`; update the widget comment to `brightWhite, yellow past 70%, red past 90%`.

- [x] **Step 4: Run** — same command → PASS; then `npx vitest run test/statusline-footer.test.ts` → all pass.

### Task 1.2: Slider and counter follow a streaming reply

pi's `getContextUsage()` estimates over `agent.state.messages`, which only receives an assistant message at message end; the in-flight reply's usage (full prompt + output so far) is newer.

**Files:**
- Modify: `ext/statusline/footer.ts` (`resolveContextUsage`, new `streamingContextUsage`, `FooterSources`)
- Modify: `ext/statusline/index.ts` (`message_update` / `message_end` handlers, sources, token widget)
- Test: `test/statusline-footer.test.ts`, `test/registration.test.ts` (statusline events 4 → 6)

- [x] **Step 1: Write the failing tests** — in `describe("context usage after compaction")` (rename it to `describe("context usage")`), add:

```ts
	const usage = (tokens: number) => ({
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});

	it("prefers a streaming reply's usage over pi's finished-message figure", () => {
		const ctx = { getContextUsage: () => ({ tokens: 500, contextWindow: 1000, percent: 50 }) } as never;
		expect(resolveContextUsage(ctx, usage(650) as never)).toEqual({ tokens: 650, percent: 65, approximate: false });
	});

	it("takes usage only from a live assistant message that reports some", () => {
		const assistant = (over: object) => ({ role: "assistant", stopReason: "stop", usage: usage(10), ...over }) as never;
		expect(streamingContextUsage(assistant({}))).toEqual(usage(10));
		expect(streamingContextUsage(assistant({ stopReason: "aborted" }))).toBeUndefined();
		expect(streamingContextUsage(assistant({ stopReason: "error" }))).toBeUndefined();
		expect(streamingContextUsage(assistant({ usage: usage(0) }))).toBeUndefined();
		expect(streamingContextUsage({ role: "user", content: [], timestamp: 0 } as never)).toBeUndefined();
	});
```

Add `streamingContextUsage` to the `footer.ts` import. In `test/registration.test.ts` change only the statusline line to `events: 6`.

- [x] **Step 2: Run** — `npx vitest run test/statusline-footer.test.ts test/registration.test.ts` → FAIL (`streamingContextUsage` not exported; events 4 ≠ 6).

- [x] **Step 3: Implement footer.ts**

Imports: add `calculateContextTokens` to the pi-coding-agent import, and

```ts
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
```

Above `resolveContextUsage`:

```ts
/**
 * The usage an in-flight assistant message reports, when it can stand in for
 * pi's figure: pi counts a reply only once it has finished, so while one streams
 * its own usage is the newer number. Errored and aborted replies, and providers
 * that report nothing until the end, leave pi's figure in charge.
 */
export function streamingContextUsage(message: AgentMessage): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	return calculateContextTokens(message.usage) > 0 ? message.usage : undefined;
}
```

Change the signature to `resolveContextUsage(ctx: ExtensionContext, streaming?: Usage)` and insert right after `if (!usage) return undefined;`:

```ts
	if (streaming) {
		const tokens = calculateContextTokens(streaming);
		return { tokens, percent: (tokens / usage.contextWindow) * 100, approximate: false };
	}
```

`FooterSources`: add `/** Usage of the assistant reply currently streaming, if it reports any. */ streamingUsage(): Usage | undefined;` and in `renderInfoLine` call `resolveContextUsage(ctx, this.sources.streamingUsage())`. Add `streamingUsage: () => undefined,` to the test `sources()` helper and to the literal sources in the compaction slider test.

- [x] **Step 4: Implement index.ts**

Next to `latestCtx`:

```ts
/** Usage of the reply streaming right now; cleared when it ends (see streamingContextUsage). */
let streamingUsage: Usage | undefined;
```

(import `type Usage` from `@earendil-works/pi-ai`, `streamingContextUsage` from `./footer.ts`). In `installFooter` sources add `streamingUsage: () => streamingUsage,` and change the widget getter to `() => latestCtx && resolveContextUsage(latestCtx, streamingUsage)`. In `factory`, after the `turn_end` handler:

```ts
	pi.on("message_update", (event) => {
		streamingUsage = streamingContextUsage(event.message) ?? streamingUsage;
	});
	pi.on("message_end", () => {
		streamingUsage = undefined;
	});
```

and at the top of the `session_start` handler `streamingUsage = undefined;`.

- [x] **Step 5: Run** — `npx vitest run test/statusline-footer.test.ts test/registration.test.ts` → all pass (registration may still show the other session's subagents mismatch; only the statusline row matters).

### Task 1.3: Cost figure in a configurable currency

**Files:**
- Create: `ext/statusline/currency.ts`
- Modify: `ext/_shared/settings.ts` (`StatuslineSettings.currency`) — foreign hunks present, stage per hygiene note
- Modify: `ext/statusline/footer.ts` (`FooterSources.currency`, `renderStatsLine`)
- Modify: `ext/statusline/index.ts` (rates instance, setting, repaint, `/usage` report)
- Test: `test/statusline-currency.test.ts` (new), `test/statusline-footer.test.ts`

- [x] **Step 1: Write the failing tests** — `test/statusline-currency.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrencyRates, formatCost, normalizeCurrency } from "../ext/statusline/currency.ts";

describe("formatCost", () => {
	it("keeps USD as before and converts other currencies at their usual precision", () => {
		expect(formatCost(0.0172, "USD", 1)).toBe("$0.017");
		expect(formatCost(0.0172, "USD", 1, 4)).toBe("$0.0172");
		expect(formatCost(0.0172, "IDR", 17708.74)).toBe("Rp305");
		expect(formatCost(0.0172, "EUR", 0.866)).toBe("€0.01");
		expect(formatCost(1, "JPY", 147.3)).toBe("¥147");
	});

	it("shows the code without a number until a rate is known", () => {
		expect(formatCost(1, "IDR", null)).toBe("-- IDR");
	});
});

describe("normalizeCurrency", () => {
	it("accepts supported codes in any case and rejects everything else", () => {
		expect(normalizeCurrency(" idr ")).toBe("IDR");
		expect(normalizeCurrency("XYZ")).toBeUndefined();
		expect(normalizeCurrency(5)).toBeUndefined();
	});
});

describe("CurrencyRates", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "statusline-currency-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const ok = (idr: number) => async () => ({ ok: true, status: 200, json: async () => ({ usd: { idr, eur: 0.9 } }) });

	it("fetches once, writes the disk cache, and a new instance reuses it without fetching", async () => {
		const cachePath = join(dir, "nested", "rates.json");
		const fetchSpy = vi.fn(ok(17000));
		const rates = new CurrencyRates({ cachePath, fetch: fetchSpy as never });
		expect(rates.rate("IDR")).toBeNull();
		await rates.settled();
		expect(rates.rate("IDR")).toBe(17000);

		const fresh = new CurrencyRates({ cachePath, fetch: fetchSpy as never });
		fresh.rate("IDR");
		await fresh.settled();
		expect(fresh.rate("IDR")).toBe(17000);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("refetches a day-old table, keeps serving it when the fetch fails, and backs off", async () => {
		let now = 0;
		const fetchSpy = vi.fn(ok(17000));
		const rates = new CurrencyRates({ cachePath: join(dir, "rates.json"), fetch: fetchSpy as never, now: () => now });
		rates.rate("IDR");
		await rates.settled();

		now = 25 * 60 * 60 * 1000;
		fetchSpy.mockImplementation(async () => {
			throw new Error("offline");
		});
		expect(rates.rate("IDR")).toBe(17000);
		await rates.settled();
		expect(rates.rate("IDR")).toBe(17000);
		await rates.settled();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("notifies listeners when a table arrives", async () => {
		const rates = new CurrencyRates({ cachePath: join(dir, "rates.json"), fetch: vi.fn(ok(1)) as never });
		const listener = vi.fn();
		rates.onChange(listener);
		rates.rate("IDR");
		await rates.settled();
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
```

And in `test/statusline-footer.test.ts` `describe("CcStatuslineFooter")`: add `currency: () => ({ code: "USD", rate: 1 }),` to `sources()` (and to the literal sources in the compaction slider test), plus:

```ts
	it("shows the cost in the configured currency with the billing label", () => {
		const lines = new CcStatuslineFooter(sources({ currency: () => ({ code: "IDR", rate: 17000 }) }), fakeTheme)
			.render(100)
			.map(stripAnsi);
		expect(lines[1]).toBe(" Rp0 (per token) ");
	});
```

- [x] **Step 2: Run** — `npx vitest run test/statusline-currency.test.ts test/statusline-footer.test.ts` → FAIL (module missing).

- [x] **Step 3: Implement `ext/statusline/currency.ts`**

```ts
/**
 * The cost figure in a currency other than USD. pi reports every cost in USD;
 * this converts at a daily rate from a keyless public table (the one
 * pi-powerline-footer uses), cached on disk so a new session shows a figure
 * before its first fetch. Until any rate is known the figure reads `-- IDR`
 * rather than a wrong number.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const COST_CURRENCIES = ["USD", "IDR", "EUR", "GBP", "JPY", "CNY", "CAD", "AUD", "CHF", "INR", "KRW"] as const;
export type CostCurrency = (typeof COST_CURRENCIES)[number];

const SYMBOLS: Record<CostCurrency, string> = {
	USD: "$",
	IDR: "Rp",
	EUR: "€",
	GBP: "£",
	JPY: "¥",
	CNY: "¥",
	CAD: "CA$",
	AUD: "A$",
	CHF: "CHF ",
	INR: "₹",
	KRW: "₩",
};

/** Currencies whose smallest everyday unit is the whole unit. */
const WHOLE_UNITS: readonly CostCurrency[] = ["IDR", "JPY", "KRW"];

const RATE_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";
const RATE_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch, wait this long before trying again — renders happen per keystroke. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

type RateTable = Partial<Record<CostCurrency, number>>;
type CachedRates = { timestamp: number; rates: RateTable };

export function normalizeCurrency(value: unknown): CostCurrency | undefined {
	if (typeof value !== "string") return undefined;
	const code = value.trim().toUpperCase();
	return (COST_CURRENCIES as readonly string[]).includes(code) ? (code as CostCurrency) : undefined;
}

/** `usdDecimals` keeps each caller's existing USD precision (footer 3, `/usage` 4). */
export function formatCost(amountUsd: number, currency: CostCurrency, rate: number | null, usdDecimals = 3): string {
	if (currency === "USD") return `$${amountUsd.toFixed(usdDecimals)}`;
	if (rate === null) return `-- ${currency}`;
	const decimals = WHOLE_UNITS.includes(currency) ? 0 : 2;
	return `${SYMBOLS[currency]}${(amountUsd * rate).toFixed(decimals)}`;
}

function parseRates(source: unknown): RateTable {
	const rates: RateTable = { USD: 1 };
	if (typeof source !== "object" || source === null) return rates;
	const record = source as Record<string, unknown>;
	for (const code of COST_CURRENCIES) {
		const rate = record[code.toLowerCase()] ?? record[code];
		if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) rates[code] = rate;
	}
	return rates;
}

async function readCache(path: string): Promise<CachedRates | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as { timestamp?: unknown; rates?: unknown };
		return typeof parsed.timestamp === "number" ? { timestamp: parsed.timestamp, rates: parseRates(parsed.rates) } : undefined;
	} catch {
		return undefined;
	}
}

export class CurrencyRates {
	private readonly cachePath: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private cached: CachedRates | undefined;
	private diskRead = false;
	private retryAt = 0;
	private pending: Promise<void> | undefined;
	private readonly listeners = new Set<() => void>();

	constructor(options: { cachePath: string; fetch: typeof fetch; now?: () => number }) {
		this.cachePath = options.cachePath;
		this.fetchImpl = options.fetch;
		this.now = options.now ?? Date.now;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** USD → `currency`, null until a table is known. A missing or day-old table refreshes in the background. */
	rate(currency: CostCurrency): number | null {
		if (currency === "USD") return 1;
		const now = this.now();
		const stale = !this.cached || now - this.cached.timestamp >= RATE_TTL_MS;
		if (stale && !this.pending && now >= this.retryAt) {
			this.pending = this.refresh().finally(() => {
				this.pending = undefined;
			});
		}
		return this.cached?.rates[currency] ?? null;
	}

	/** Resolves when the refresh in flight (if any) has finished. */
	settled(): Promise<void> {
		return this.pending ?? Promise.resolve();
	}

	private async refresh(): Promise<void> {
		if (!this.diskRead) {
			this.diskRead = true;
			const fromDisk = await readCache(this.cachePath);
			if (fromDisk) this.publish(fromDisk);
			if (fromDisk && this.now() - fromDisk.timestamp < RATE_TTL_MS) return;
		}
		try {
			const response = await this.fetchImpl(RATE_URL);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = (await response.json()) as { usd?: unknown };
			const fresh = { timestamp: this.now(), rates: parseRates(body.usd) };
			this.publish(fresh);
			await mkdir(dirname(this.cachePath), { recursive: true });
			await writeFile(this.cachePath, JSON.stringify(fresh));
		} catch {
			// Offline, a bad response, or an unwritable cache: whatever table is already
			// showing stays, and the next attempt waits instead of firing every render.
			this.retryAt = this.now() + RETRY_AFTER_MS;
		}
	}

	private publish(rates: CachedRates): void {
		this.cached = rates;
		for (const listener of this.listeners) listener();
	}
}
```

Note: in the "refetches a day-old table" test the second `rate()` after a failure is inside `RETRY_AFTER_MS`, so `fetchSpy` stays at 2 calls — that is the back-off assertion.

- [x] **Step 4: Wire the footer** — `footer.ts`: import `{ type CostCurrency, formatCost } from "./currency.ts"`; `FooterSources` gains `/** Currency for the cost figure and its USD rate (null until known). */ currency(): { code: CostCurrency; rate: number | null };`. In `renderStatsLine` replace the two cost pushes with:

```ts
		const { code, rate } = this.sources.currency();
		const cost = formatCost(totals.cost, code, rate);
		if (ctx.model) {
			parts.push(`${cost} (${isUsingSubscription(ctx) ? "subscription" : "per token"})`);
		} else if (totals.cost) {
			parts.push(cost);
		}
```

(keep the existing comment above it).

- [x] **Step 5: Wire settings and index.ts** — `ext/_shared/settings.ts` `StatuslineSettings`:

```ts
	/** Currency of the cost figure in the footer and `/usage`, converted from USD at a daily rate. default: USD */
	currency?: string;
```

`index.ts`: import `getAgentDir` from pi-coding-agent, `join` from `node:path`, `{ COST_CURRENCIES, type CostCurrency, CurrencyRates, formatCost, normalizeCurrency }` from `./currency.ts`. Module scope:

```ts
/** Daily USD rates for the cost figure; one table per process, shared by every session. */
const currencyRates = new CurrencyRates({
	cachePath: join(getAgentDir(), "bluclawd", "currency-rates.json"),
	fetch: (input, init) => fetch(input, init),
});
let costCurrency: CostCurrency = "USD";
```

`installFooter`: add `currencyRates.onChange(repaint),` to `unsubscribe` and `currency: () => ({ code: costCurrency, rate: currencyRates.rate(costCurrency) }),` to the sources. In `session_start`, right after `setSubscriptionProviders(...)`:

```ts
		const currency = statusline?.currency === undefined ? "USD" : normalizeCurrency(statusline.currency);
		if (!currency) {
			ctx.ui.notify(
				`statusline.currency "${statusline?.currency}" is not supported, showing USD. Supported: ${COST_CURRENCIES.join(", ")}.`,
				"warning",
			);
		}
		costCurrency = currency ?? "USD";
```

`UsageReport` gains `/** Absent on entries written before currencies existed: they render in USD. */ currency?: { code: CostCurrency; rate: number | null };`; `usageHandler` adds `currency: { code: costCurrency, rate: currencyRates.rate(costCurrency) },`; `formatUsageReport` cost line becomes ``lines.push(`${dim("Cost:")} ${formatCost(t.cost, report.currency?.code ?? "USD", report.currency?.rate ?? 1, 4)}${billing}`);``.

- [x] **Step 6: Run** — `npx vitest run test/statusline-currency.test.ts test/statusline-footer.test.ts test/registration.test.ts` → pass; `npx biome check ext/statusline test/statusline-currency.test.ts test/statusline-footer.test.ts` → clean; `npx tsc --noEmit 2>&1 | grep -v "mcp\|subagents"` → no statusline errors.

### Task 1.4: Live verify Tier 1 and commit

- [x] **Step 1: tmux** — scratch git repo under `$CLAUDE_JOB_DIR/tmp/live`; `pi -ne -e <repo>/ext/statusline/index.ts --session-dir <tmp>/sessions` in a 110×35 tmux session. Put `{"statusline":{"currency":"IDR"}}` in the scratch repo's `.pi/settings.json` and trust the project when asked (if it does not apply untrusted, set it in a throwaway `PI_CODING_AGENT_DIR` copy instead — never edit the user's global settings). Check: stats line shows `Rp… (subscription|per token)`; a long read-heavy prompt moves the slider while `Working` is shown; `/usage` shows `Cost: Rp…`. Colors: confirm the SGR code of the slider via `tmux capture-pane -e -p`.
- [x] **Step 2: Full checks** — `npm test` (report the other sessions' failures separately), `npx biome check .`, `npx tsc --noEmit`.
- [x] **Step 3: Commit (ask first)** — stage `ext/statusline/{footer,index,currency}.ts`, `test/statusline-{footer,currency}.test.ts`, and the plan hunks of `ext/_shared/settings.ts` / `test/registration.test.ts` per the hygiene note. Message: `statusline: context colors, live streaming context, cost in a configurable currency`.

---

## Tier 2 — `!` outside the sandbox, `!` git refresh, bash mode (`ext/shell`)

**Done: 12589f8.** Found while verifying: Ctrl+C killed the whole shell (powerline has the same bug) — fixed with an INT trap in the init script; sentinels are matched mid-line so `printf foo` cannot hang a command. Bash-mode output stays out of the conversation (powerline behaviour).

Detailed steps are written when this tier starts, against the code as it is then.

- **2.1 `!` follows Claude Code.** `ext/sandbox/index.ts` `user_bash` handler removed (strict refusal and sandboxed operations). Tests in `test/sandbox*.test.ts` that assert `!` is sandboxed/refused are inverted, not deleted. README sandbox section and memory note `bluclawd-sandbox-cc-parity.md` ("deliberate deviations") updated.
- **2.2 Git counts refresh when `!` finishes.** `ext/statusline` owns `user_bash`: returns `{ operations }` wrapping `createLocalBashOperations()` whose `exec` invalidates `GitInfo` changes and requests a render when the command settles. The invalidation is also published as `sharedRef("statusline.workingTreeChanged")` for `ext/shell`. Test: the wrapped exec invalidates after resolve and after reject.
- **2.3 Bash mode.** New `ext/shell/` porting powerline's `bash-mode/{shell-session,transcript,editor,history,types}.ts` (MIT notice kept in the file headers): persistent shell per session, `ctrl+shift+b` and `/bash-mode on|off|toggle`, output transcript widget below the editor, `shell` status (`bash · idle · <dir>`) on the footer's status line, working-tree invalidation after each command, shell killed on `session_shutdown`. Whether bash-mode output enters the model's context follows powerline's behaviour, checked at detailing time. Registered in `package.json` `pi.extensions`; registration test row added. Tests: shell session cwd/export persistence, sentinel parsing, editor toggle. Live tmux verify: `cd`, `export`, `!` alongside bash mode, sandbox ON.

## Tier 3 — Stash (`ext/shell`)

**Done: dc692d3.** `/stash` is the history picker (powerline used ctrl+alt+h). Found while verifying: `setEditorText` does not repaint, so an inserted stash was invisible until the next key.

- `alt+s` in the shared editor: stash non-empty text and clear; on an empty editor restore; with an active stash and new text, update the stash. `stash` status on the footer status line. History persisted at `getAgentDir()/bluclawd/stash-history.json`, session-local active stash. Port of powerline's stash logic from `index.ts`. Tests: the three transitions + persistence. Live tmux verify.

## Tier 4 — Queue (`ext/queue`)

**Skipped by user decision (2026-09-17).** The pi version bluclawd runs on already holds prompts typed during compaction and sends them when it finishes (`queueCompactionMessage` / `flushCompactionQueue`), restoring them on failure — the core of powerline's queue, which predates that. The remaining extras (`/compact <text>` re-purposing, file-backed `/queue`) were not worth the code.

- During compaction (`session_before_compact` → `session_compact` / `session_compact_failed`), prompts typed are held (`input` handler returns handled) and delivered after a successful compaction via `pi.sendUserMessage`; on failure they stay queued with a notice. `/compact <text>` = compact then send `<text>` (checked at detailing time whether an extension may take the built-in name; if not, `/compact-then`). `/queue` picker + `send [id]`, `retry [id]`, `clear <id|all>`. Store: `getAgentDir()/bluclawd/queue.jsonl`, atomic writes with `proper-lockfile` (already a dependency). Interaction with `ext/memory` and `ext/mcp` `input` handlers tested (handler order). Tests: hold/deliver/fail paths, store round-trip and locking. Live tmux verify with a manual `/compact`.

## Tier 5 — Vibes (`ext/vibes`)

**Done: 886a4f6.** Found while verifying: OpenCode Go rejects requests without `x-opencode-session` (the helper moved from `ext/web` to `_shared/session-headers.ts`), and a reasoning model spent a 40-token budget thinking — generation uses 1024 tokens and a 10 s timeout.

- Port `working-vibes.ts`: `/vibe <theme>`, `/vibe off`, `/vibe` (show), `/vibe model [provider/id[:thinking]]`, `/vibe mode generate|file`, `/vibe generate <theme> <n>`. Default model = the session's current model (never a hard-coded vendor); `vibes.model` setting overrides. Uses `ctx.ui.setWorkingMessage`; 3s timeout, 30s refresh, fallback `Working`. Files at `getAgentDir()/bluclawd/vibes/<theme>.txt`. Settings under `vibes.*` in `StatuslineSettings`' sibling interface. Tests: response cleanup/length cap, model resolution fallback, file-mode seeded shuffle. Live tmux verify with opencode-go.

## Tier 6 — Welcome content in the mascot banner (`ext/branding`)

**Done: 986e4bf.** Counts come from `loadProjectContextFiles` and `pi.getCommands()` / `getAllTools()`; `getSystemPromptOptions` exists only on command contexts. There is no extension count API, so tools are shown instead.

- Sidebar sections: **Model** (name · provider), **Loaded** (AGENTS.md/CLAUDE.md context files, extensions, skills, prompt templates — from what pi exposes to extensions), **System prompt** (`~N tokens`, chars/4), **Recent sessions** (3 newest for this cwd with relative time), **Tips** (existing three). Sections that have no data are omitted; narrow terminals already drop the sidebar. Tests: `welcome-box` rendering with the new sections, recent-session formatting. Live tmux verify at 110 and 70 columns.

## Tier 7 — Docs, memory, final checks

**Done** in the commit that carries this line.

- README: commands table (`/bash-mode`, `/queue`, `/vibe`, `/compact <text>`), shortcuts (`ctrl+shift+b`, `alt+s`), settings (`statusline.currency`, `vibes.*`), sandbox `!` note, MIT attribution for pi-powerline-footer.
- Memory: footer note, sandbox parity note, new notes for shell/queue/vibes traps found during live verify.
- `npm test`, `npx biome check .`, `npx tsc --noEmit`; ask before pushing.
