import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn((..._args: unknown[]) => ""));
vi.mock("node:child_process", async (actual) => ({
	...(await actual<typeof import("node:child_process")>()),
	execFileSync,
}));
/** The files written, counted. */
const writes = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (actual) => {
	const fs = await actual<typeof import("node:fs")>();
	return {
		...fs,
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			writes(args[0]);
			return fs.writeFileSync(...args);
		},
	};
});

const { Tmux } = await import("../daemon/tmux.ts");

describe("tmux command timeout", () => {
	const dir = mkdtempSync(join(tmpdir(), "bc-tmux-timeout-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const timeoutOf = (tmux: InstanceType<typeof Tmux>) => {
		execFileSync.mockClear();
		tmux.newSession({ cwd: "/p", args: [], command: ["/bin/pi"] });
		return (execFileSync.mock.calls[0][2] as { timeout?: number }).timeout;
	};

	it("makes both new and existing server directories owner-only", () => {
		const own = join(dir, "private");
		new Tmux(own).attached();
		expect(statSync(own).mode & 0o777).toBe(0o700);
		chmodSync(own, 0o755);
		new Tmux(own).attached();
		expect(statSync(own).mode & 0o777).toBe(0o700);
	});

	it("gives up on a hung command only when asked to, as the daemon does", () => {
		expect(timeoutOf(new Tmux(dir))).toBeUndefined();
		expect(timeoutOf(new Tmux(dir, undefined, { timeoutMs: 2000 }))).toBe(2000);
	});

	it("writes its config with its first command only, not with every one", () => {
		const own = join(dir, "own");
		const tmux = new Tmux(own);
		writes.mockClear();
		execFileSync.mockClear();
		for (let i = 0; i < 3; i++) tmux.capture("pi-1", 10);
		const config = join(own, "tmux.conf");
		expect(writes.mock.calls.filter(([file]) => file === config)).toHaveLength(1);
		expect(readFileSync(config, "utf8")).toContain("set -g prefix None");
		expect(execFileSync.mock.calls).toHaveLength(3);
		for (const call of execFileSync.mock.calls) expect(call[1]).toEqual(expect.arrayContaining(["-f", config]));
	});
});
