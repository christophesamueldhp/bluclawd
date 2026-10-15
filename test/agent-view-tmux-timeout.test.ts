import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ""));
vi.mock("node:child_process", async (actual) => ({
	...(await actual<typeof import("node:child_process")>()),
	execFileSync,
}));

const { Tmux } = await import("../daemon/tmux.ts");

describe("tmux command timeout", () => {
	const dir = mkdtempSync(join(tmpdir(), "bc-tmux-timeout-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const timeoutOf = (tmux: InstanceType<typeof Tmux>) => {
		execFileSync.mockClear();
		tmux.newSession({ cwd: "/p", args: [], command: ["/bin/pi"] });
		return (execFileSync.mock.calls[0][2] as { timeout?: number }).timeout;
	};

	it("gives up on a hung command only when asked to, as the daemon does", () => {
		expect(timeoutOf(new Tmux(dir))).toBeUndefined();
		expect(timeoutOf(new Tmux(dir, undefined, { timeoutMs: 2000 }))).toBe(2000);
	});
});
