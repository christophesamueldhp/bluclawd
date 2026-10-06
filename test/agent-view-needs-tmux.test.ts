import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentView from "../ext/agent-view/index.ts";
import { Tmux } from "../ext/agent-view/tmux.ts";

/** A PATH holding only a `tmux` that answers `-V`, or nothing at all. */
function pathWith(tmux: boolean): string {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-path-"));
	if (tmux) {
		writeFileSync(join(dir, "tmux"), "#!/bin/sh\necho 'tmux 3.5'\n");
		chmodSync(join(dir, "tmux"), 0o755);
	}
	return dir;
}

afterEach(() => vi.unstubAllEnvs());

describe("agent view needs tmux", () => {
	it("without tmux it says so once and lists nothing; ← says so again", async () => {
		vi.stubEnv("PATH", pathWith(false));
		vi.stubEnv("BLUCLAWD_PANE", "");
		const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
		const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
		agentView({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers[event] = handler;
			},
			registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands[name] = def;
			},
		} as never);
		const notes: string[] = [];
		const status: string[] = [];
		const ctx = {
			mode: "tui",
			cwd: "/p",
			ui: {
				theme: { fg: (_c: string, t: string) => t, getColorMode: () => "256" },
				notify: (text: string) => notes.push(text),
				setStatus: (key: string) => status.push(key),
			},
		};
		await handlers.session_start({}, ctx);
		await handlers.session_start({}, ctx);
		expect(notes).toEqual(["Agent view needs tmux — install it (brew install tmux) and start pi again"]);
		expect(status).toEqual([]);
		await commands["agent-view"].handler("", ctx);
		expect(notes).toHaveLength(2);
	});

	it("BLUCLAWD_TMUX=0 no longer turns tmux off", () => {
		vi.stubEnv("PATH", pathWith(true));
		vi.stubEnv("BLUCLAWD_TMUX", "0");
		expect(Tmux.available()).toBe(true);
	});
});
