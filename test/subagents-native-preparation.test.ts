import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedSubagentPolicySnapshot } from "../ext/subagents/execution-policy.ts";
import {
	assertSubagentPreparation,
	type SubagentPreparationContext,
	withSubagentPreparation,
} from "../ext/subagents/preparation.ts";
import { captureSourceSnapshot } from "../ext/subagents/source-snapshot.ts";
import { createSubagentFixture } from "./helpers/subagent-fixture.ts";

const fixtures: Awaited<ReturnType<typeof createSubagentFixture>>[] = [];
const owner = () => ({
	parentSessionId: "native-parent",
	runtimeGeneration: 1,
	signal: new AbortController().signal,
	isCurrent: () => true,
});
afterEach(async () => {
	vi.useRealTimers();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

function untilAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

describe("shared native preparation lease", () => {
	it("runs two operations and rejects the seventh before its work begins", async () => {
		const ac = new AbortController();
		const options = { ...owner(), signal: ac.signal };
		let started = 0;
		const work = async (ctx: SubagentPreparationContext) => {
			started++;
			await untilAborted(ctx.signal);
		};
		const pending = Array.from({ length: 6 }, () => withSubagentPreparation(options, work));
		const settled = Promise.allSettled(pending);
		try {
			await vi.waitFor(() => expect(started).toBe(2));
			await expect(withSubagentPreparation(options, work)).rejects.toThrow(/capacity|queue/i);
			expect(started).toBe(2);
		} finally {
			ac.abort();
		}
		expect((await settled).every((result) => result.status === "rejected")).toBe(true);
		expect(await withSubagentPreparation(owner(), async () => "next request")).toBe("next request");
	});

	it("uses one thirty-second deadline including queue wait", async () => {
		vi.useFakeTimers();
		let started = 0;
		const pending = Array.from({ length: 6 }, () =>
			withSubagentPreparation(owner(), async (ctx) => {
				started++;
				expect(ctx.deadlineAt - Date.now()).toBeLessThanOrEqual(30_000);
				await untilAborted(ctx.signal);
			}),
		);
		const settled = Promise.allSettled(pending);
		await vi.waitFor(() => expect(started).toBe(2));
		await vi.advanceTimersByTimeAsync(30_001);
		const results = await settled;
		expect(started).toBe(2);
		expect(results.every((result) => result.status === "rejected" && /timed out/i.test(String(result.reason)))).toBe(
			true,
		);
	});

	it("rejects copied, foreign and expired contexts", async () => {
		let retained: SubagentPreparationContext;
		await withSubagentPreparation(owner(), async (ctx) => {
			retained = ctx;
			expect(Object.isFrozen(ctx)).toBe(true);
			expect(() => assertSubagentPreparation({ ...ctx }, "native-parent", 1)).toThrow();
			expect(() => assertSubagentPreparation(ctx, "another-parent", 1)).toThrow();
			expect(() => assertSubagentPreparation(ctx, "native-parent", 2)).toThrow();
			assertSubagentPreparation(ctx, "native-parent", 1);
		});
		expect(() => assertSubagentPreparation(retained!, "native-parent", 1)).toThrow();
	});

	it("rejects owner drift after an await and releases the lease", async () => {
		let current = true;
		await expect(
			withSubagentPreparation({ ...owner(), isCurrent: () => current }, async (ctx) => {
				await Promise.resolve();
				current = false;
				assertSubagentPreparation(ctx, "native-parent", 1);
			}),
		).rejects.toThrow(/owner|session|current/i);
		expect(await withSubagentPreparation(owner(), async () => "available")).toBe("available");
	});

	it("pins the owner even if the caller mutates its options during admission", async () => {
		const options = owner();
		const pending = withSubagentPreparation(options, async (ctx) => {
			assertSubagentPreparation(ctx, "native-parent", 1);
			expect(() => assertSubagentPreparation(ctx, "changed-parent", 1)).toThrow();
			return "original owner";
		});
		options.parentSessionId = "changed-parent";
		expect(await pending).toBe("original owner");
	});

	it("rejects an aborted or invalid owner without starting work", async () => {
		let started = false;
		const work = async () => {
			started = true;
		};
		await expect(withSubagentPreparation({ ...owner(), signal: AbortSignal.abort() }, work)).rejects.toThrow();
		await expect(withSubagentPreparation({ ...owner(), parentSessionId: "../other" }, work)).rejects.toThrow();
		await expect(
			withSubagentPreparation({ ...owner(), parentSessionId: false as unknown as string }, work),
		).rejects.toThrow();
		await expect(withSubagentPreparation({ ...owner(), runtimeGeneration: -1 }, work)).rejects.toThrow();
		await expect(withSubagentPreparation({ ...owner(), isCurrent: () => false }, work)).rejects.toThrow();
		expect(started).toBe(false);
	});

	it("captures under two existing leases without nested admission", async () => {
		const fixture = await createSubagentFixture();
		fixtures.push(fixture);
		const options = {
			...owner(),
			agentDir: fixture.stateDir,
			policy: createIsolatedSubagentPolicySnapshot({
				cwd: fixture.parentCwd,
				denyRules: [],
				allowedTools: ["read", "bash"],
			}).snapshot!,
			exec: fixture.exec,
		};
		const sources = await Promise.all(
			Array.from({ length: 2 }, () =>
				withSubagentPreparation(options, (preparation) => captureSourceSnapshot({ ...options, preparation })),
			),
		);
		expect(sources[0].worktreeTree).toBe(sources[1].worktreeTree);
		expect(sources[0].snapshotId).not.toBe(sources[1].snapshotId);
		for (const invalid of [null, false, { signal: options.signal, deadlineAt: Date.now() + 30_000 }]) {
			await expect(
				captureSourceSnapshot({ ...options, preparation: invalid as unknown as SubagentPreparationContext }),
			).rejects.toThrow();
		}
	}, 10000);
});
