import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CcStatuslineFooter,
	type FooterSources,
	formatCwd,
	formatUsageDuration,
	makeSliderBar,
} from "../ext/statusline/footer.ts";
import { parseDiffShortStat, parseRemoteOwner } from "../ext/statusline/git-info.ts";
import { parseOpencodeGoDashboard, UsageDataProvider } from "../ext/statusline/usage-providers.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Let a fire-and-forget refresh() promise settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("ccstatusline formatting helpers", () => {
	it("renders slider bars at ccstatusline's 10-cell width", () => {
		expect(makeSliderBar(0)).toBe("░░░░░░░░░░");
		expect(makeSliderBar(50)).toBe("▓▓▓▓▓░░░░░");
		expect(makeSliderBar(100)).toBe("▓▓▓▓▓▓▓▓▓▓");
		expect(makeSliderBar(250)).toBe("▓▓▓▓▓▓▓▓▓▓");
	});

	it("formats reset durations like ccstatusline's reset-timer widget", () => {
		const hr = 60 * 60 * 1000;
		expect(formatUsageDuration(2.5 * hr)).toBe("2hr 30m");
		expect(formatUsageDuration(27 * hr)).toBe("1d 3hr");
		expect(formatUsageDuration(45 * 60 * 1000)).toBe("45m");
		expect(formatUsageDuration(-5)).toBe("0m");
		expect(formatUsageDuration(2.5 * hr, true)).toBe("2h30m");
	});

	it("abbreviates home in the cwd widget", () => {
		expect(formatCwd("/home/me/src/app", "/home/me")).toBe("~/src/app");
		expect(formatCwd("/home/me", "/home/me")).toBe("~");
		expect(formatCwd("/opt/other", "/home/me")).toBe("/opt/other");
	});
});

describe("git widgets", () => {
	it("extracts the owner from every remote URL shape", () => {
		expect(parseRemoteOwner("git@github.com:owner/repo.git")).toBe("owner");
		expect(parseRemoteOwner("https://github.com/owner/repo.git")).toBe("owner");
		expect(parseRemoteOwner("ssh://git@github.com/owner/repo")).toBe("owner");
		expect(parseRemoteOwner("not a url")).toBeNull();
	});

	it("parses --shortstat with singular and plural units", () => {
		expect(parseDiffShortStat(" 3 files changed, 42 insertions(+), 7 deletions(-)")).toEqual({
			insertions: 42,
			deletions: 7,
		});
		expect(parseDiffShortStat(" 1 file changed, 1 insertion(+)")).toEqual({ insertions: 1, deletions: 0 });
		expect(parseDiffShortStat("")).toEqual({ insertions: 0, deletions: 0 });
	});
});

describe("OpenCode Go dashboard parser", () => {
	it("reads the SSR hydration format regardless of field order", () => {
		const html =
			"rollingUsage:$R[3]={usagePercent:12.5,resetInSec:3600};weeklyUsage:$R[4]={resetInSec:86400,usagePercent:40}";
		const parsed = parseOpencodeGoDashboard(html);
		expect(parsed?.rolling?.usagePercent).toBe(12.5);
		expect(parsed?.weekly?.usagePercent).toBe(40);
		expect(parsed?.monthly).toBeUndefined();
	});

	it("falls back to the data-slot format", () => {
		const html = [
			'<div data-slot="usage-item"><span data-slot="usage-label">Rolling</span><span data-slot="usage-value">33%</span><span data-slot="reset-time">Resets in 1 hour 56 minutes</span></div>',
			'<div data-slot="usage-item"><span data-slot="usage-label">Monthly</span><span data-slot="usage-value">5%</span><span data-slot="reset-now">now</span></div>',
		].join("");
		const parsed = parseOpencodeGoDashboard(html);
		expect(parsed?.rolling?.usagePercent).toBe(33);
		expect(parsed?.monthly?.usagePercent).toBe(5);
	});

	it("returns null for unrelated HTML", () => {
		expect(parseOpencodeGoDashboard("<html><body>login</body></html>")).toBeNull();
	});
});

describe("UsageDataProvider credential gate", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("does not call the usage API when there is no Anthropic OAuth credential", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const provider = new UsageDataProvider(() => undefined);
		provider.start();
		await settle();
		provider.dispose();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(provider.getUsageData()).toBeNull();
	});

	it("ignores a non-oauth (api_key) credential the same way", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const provider = new UsageDataProvider(() => ({ type: "api_key" }));
		provider.start();
		await settle();
		provider.dispose();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends the resolved token when an OAuth credential exists", async () => {
		let sentAuth: string | undefined;
		vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
			sentAuth = init.headers.Authorization;
			return {
				ok: true,
				status: 200,
				json: async () => ({ five_hour: { utilization: 12, resets_at: "2026-08-01T10:00:00Z" } }),
			};
		});
		const provider = new UsageDataProvider(async () => ({ type: "oauth", access: "tok-abc" }));
		provider.start();
		await settle();
		provider.dispose();
		expect(sentAuth).toBe("Bearer tok-abc");
		expect(provider.getUsageData()?.sessionUsage).toBe(12);
	});
});

describe("CcStatuslineFooter", () => {
	const fakeTheme = { fg: (_c: string, s: string) => s } as unknown as ConstructorParameters<
		typeof CcStatuslineFooter
	>[1];
	const sources = (overrides: Partial<FooterSources> = {}): FooterSources => ({
		ctx: () =>
			({
				cwd: "/home/me/proj",
				model: { name: "Kimi K2.6 (preview)", id: "kimi-k2.6", provider: "opencode-go", reasoning: true },
				thinkingLevel: "high",
				getContextUsage: () => ({ percent: 50, tokens: 100_000 }),
				sessionManager: { getEntries: () => [] },
				modelRegistry: { isUsingOAuth: () => false },
			}) as never,
		gitBranch: () => "main",
		gitOriginOwner: () => "owner",
		gitChanges: () => ({ insertions: 4, deletions: 2 }),
		usage: () => null,
		goUsage: () => null,
		extensionStatuses: () => new Map(),
		...overrides,
	});

	it("renders line 1 as model · effort · slider — flex — owner · branch · changes · cwd", () => {
		vi.stubEnv("HOME", "/home/me");
		const [line1, ...rest] = new CcStatuslineFooter(sources(), fakeTheme).render(100);
		const plain = stripAnsi(line1);
		expect(plain.length).toBe(100);
		expect(plain.startsWith(" Kimi K2.6  high  ▓▓▓▓▓░░░░░ ")).toBe(true);
		expect(plain.endsWith(" owner  ⎇ main  (+4,-2)  ~/proj ")).toBe(true);
		expect(rest).toEqual([]);
		vi.unstubAllEnvs();
	});

	it("shows the usage line only when a provider has data, and statuses last", () => {
		const lines = new CcStatuslineFooter(
			sources({
				usage: () => ({ sessionUsage: 20, weeklyUsage: 60, sessionResetAt: undefined, weeklyResetAt: undefined }),
				extensionStatuses: () =>
					new Map([
						["b", "same"],
						["a", "same"],
						["c", "⏸ manual"],
					]),
			}),
			fakeTheme,
		)
			.render(120)
			.map(stripAnsi);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("Session: ▓▓░░░░░░░░ 20.0%");
		expect(lines[1]).toContain(" | ");
		expect(lines[1]).toContain("Weekly: ▓▓▓▓▓▓░░░░ 60.0%");
		expect(lines[2]).toBe("same ⏸ manual");
	});

	it("degrades to a bare footer when the context is gone", () => {
		const lines = new CcStatuslineFooter(
			sources({
				ctx: () => {
					throw new Error("runner retired");
				},
			}),
			fakeTheme,
		).render(80);
		expect(stripAnsi(lines[0])).toContain("no-model");
	});
});
