import { describe, expect, it } from "vitest";
import { startSession } from "../daemon/remote/spawn.ts";
import { Tmux } from "../ext/agent-view/tmux.ts";

describe("starting a pane from the phone", () => {
	const launch = { command: ["/usr/bin/node", "/pi/cli.js"] };
	function fakeTmux(fail = false) {
		const calls: string[][] = [];
		const tmux = new Tmux("/nonexistent", (args) => {
			calls.push(args);
			if (fail) throw new Error("tmux: no server");
			return "";
		});
		return { tmux, calls };
	}
	/** What the pane runs: its pi command and arguments, after tmux's own options. */
	const runs = (args: string[], argc: number) => args.slice(-(launch.command.length + argc));

	it("starts a new session with the task as its first prompt, as agent view's composer does", () => {
		const { tmux, calls } = fakeTmux();
		const pane = startSession({ cwd: "/p", task: "-fix it", launch, tmux });
		expect(pane).toMatch(/^pi-[0-9a-f]{8}$/);
		expect(calls[0].slice(0, 4)).toEqual(["new-session", "-d", "-s", pane]);
		expect(calls[0]).toContain("/p");
		expect(runs(calls[0], 2)).toEqual([...launch.command, "--", "-fix it"]);
	});

	it("passes a model", () => {
		const { tmux, calls } = fakeTmux();
		startSession({ cwd: "/p", task: "go", model: "anthropic/claude-opus-5-5", launch, tmux });
		expect(runs(calls[0], 4)).toEqual([...launch.command, "--model", "anthropic/claude-opus-5-5", "--", "go"]);
	});

	it("resumes a stored session with the reply as its next prompt", () => {
		const { tmux, calls } = fakeTmux();
		startSession({ cwd: "/p", task: "next", sessionFile: "/s/a.jsonl", launch, tmux });
		expect(runs(calls[0], 4)).toEqual([...launch.command, "--session", "/s/a.jsonl", "--", "next"]);
	});

	it("surfaces a tmux failure", () => {
		const { tmux } = fakeTmux(true);
		expect(() => startSession({ cwd: "/p", task: "go", launch, tmux })).toThrow("no server");
	});
});
