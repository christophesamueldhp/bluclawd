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
});
