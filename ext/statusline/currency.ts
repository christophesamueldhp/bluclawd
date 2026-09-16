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
		return typeof parsed.timestamp === "number"
			? { timestamp: parsed.timestamp, rates: parseRates(parsed.rates) }
			: undefined;
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
