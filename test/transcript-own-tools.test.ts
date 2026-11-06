import { describe, expect, it } from "vitest";
import { DOT, draw, plain, type Row, restyled, text } from "./helpers/tool-render.ts";

/** A bluclawd tool row, drawn as pi would draw a tool whose definition has no renderers of its own. */
const row = (toolName: string, r: Row, width?: number) => plain(draw(restyled(toolName, {}), r, width));

describe("websearch", () => {
	it("is the quoted query and how many results came back", () => {
		const out = row("websearch", {
			args: { query: "pi tui", objective: "docs" },
			result: text("1. Pi\n   https://pi.dev\n\nvia exa", { provider: "exa", results: 8 }),
		});
		expect(out).toBe(`${DOT} WebSearch("pi tui")\n  ⎿  8 results`);
	});
});

describe("webfetch", () => {
	it("is the page it read and how many it fetched", () => {
		const out = row("webfetch", {
			args: { urls: ["https://pi.dev/docs"] },
			result: text("## Pi — https://pi.dev/docs\n\nbody", { pages: 1, failed: 0 }),
		});
		expect(out).toBe(`${DOT} WebFetch(https://pi.dev/docs)\n  ⎿  Fetched 1 page`);
	});

	it("names the first page and counts the others, and the pages that failed", () => {
		const out = row("webfetch", {
			args: { urls: ["https://a.dev", "https://b.dev", "https://c.dev"] },
			result: text("…", { pages: 3, failed: 1 }),
		});
		expect(out).toBe(`${DOT} WebFetch(https://a.dev +2)\n  ⎿  Fetched 2 of 3 pages`);
	});
});

describe("memory", () => {
	it("is the action and the Memory's name, then what was done", () => {
		const out = row("memory", {
			args: { action: "save", name: "user-role", description: "d", type: "user", body: "b" },
			result: text('Saved Memory "user-role".'),
		});
		expect(out).toBe(`${DOT} Memory(save user-role)\n  ⎿  Saved Memory "user-role".`);
	});

	it("counts the lines of a Memory it read rather than showing them", () => {
		const out = row("memory", { args: { action: "read", name: "x" }, result: text("---\nname: x\n---\nfact") });
		expect(out).toBe(`${DOT} Memory(read x)\n  ⎿  Read 4 lines`);
	});
});

describe("monitor", () => {
	it("is what it watches and the task it started", () => {
		const out = row("monitor", {
			args: { command: "tail -f log", description: "errors in the log" },
			result: text("Monitor started (task b3, expires in 5m unless the source ends first). You will be notified."),
		});
		expect(out).toBe(`${DOT} Monitor(errors in the log)\n  ⎿  Started task b3`);
	});
});

describe("task_stop", () => {
	it("is the task id and the stop message", () => {
		const message = "Successfully stopped task: b3 (npm run dev)";
		const out = row("task_stop", {
			args: { task_id: "b3" },
			result: text(JSON.stringify({ message, task_id: "b3", task_type: "local_bash", command: "npm run dev" })),
		});
		expect(out).toBe(`${DOT} TaskStop(b3)\n  ⎿  ${message}`);
	});
});

describe("subagent", () => {
	it("is the run's name and how long its report is", () => {
		const out = row("subagent", {
			args: { agent: "explorer", name: "auth-scan", task: "Find every login path" },
			result: text('[Report from subagent "auth-scan" (sub_1), from another session.]\n\nOne\nTwo\nThree', {
				runId: "sub_1",
				name: "auth-scan",
			}),
		});
		expect(out).toBe(`${DOT} Subagent(auth-scan)\n  ⎿  Reported (3 lines)`);
	});

	it("names an inline role when the run has no name, and says a background run runs there", () => {
		const out = row("subagent", {
			args: { agent: { name: "linter", description: "d", instructions: "i" }, task: "t", background: true },
			result: text("Background subagent launched: linter-1 (sub_2)\n…", { deliveryMode: "background" }),
		});
		expect(out).toBe(`${DOT} Subagent(linter)\n  ⎿  Running in the background`);
	});
});

describe("the subagent tools", () => {
	it.each([
		["subagent_message", { to: "auth-scan", content: "hi" }, "Message 2 accepted.", "SubagentMessage(auth-scan)"],
		["subagent_stop", { agent: "all" }, "Stopped the turn of 2 subagents.", "SubagentStop(all)"],
		["subagent_close", { agent: "auth-scan" }, 'Closed "auth-scan" (sub_1).', "SubagentClose(auth-scan)"],
		["subagent_roster", {}, "You can message: parent (your orchestrator), lint.", "SubagentRoster()"],
		["subagent_status", {}, "No subagents are running.", "SubagentStatus()"],
	])("%s is its target and its one-line answer", (tool, args, answer, call) => {
		expect(row(tool, { args, result: text(answer) })).toBe(`${DOT} ${call}\n  ⎿  ${answer}`);
	});

	it("subagent_status counts the runs it lists", () => {
		const run = (name: string) => `${name} (explorer, sub_1): working\n  task: t\n  elapsed: 1m`;
		const out = row("subagent_status", { args: {}, result: text(`${run("a")}\n\n${run("b")}`) });
		expect(out).toBe(`${DOT} SubagentStatus()\n  ⎿  2 subagents`);
	});

	it("subagent_models counts the models it lists", () => {
		const models = [
			{ provider: "anthropic", id: "a" },
			{ provider: "anthropic", id: "b" },
		];
		const out = row("subagent_models", { args: { provider: "anthropic" }, result: text(JSON.stringify({ models })) });
		expect(out).toBe(`${DOT} SubagentModels(anthropic)\n  ⎿  2 models`);
	});
});

describe("a bluclawd tool, expanded or failed", () => {
	const output = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");

	it("shows every line of its output when expanded", () => {
		const out = row("websearch", { args: { query: "pi" }, result: text(output, { results: 3 }), expanded: true });
		expect(out).toBe(`${DOT} WebSearch("pi")\n${output}`);
	});

	it("never folds an error: the whole output, no summary", () => {
		const out = row("websearch", { args: { query: "pi" }, result: text(output), isError: true });
		expect(out).toBe(`${DOT} WebSearch("pi")\n${output}`);
	});

	it("wraps a long output line rather than cutting it", () => {
		const out = row("websearch", { args: { query: "pi" }, result: text("x".repeat(100)), isError: true }, 40);
		expect(out.match(/x/g)).toHaveLength(100);
	});
});
