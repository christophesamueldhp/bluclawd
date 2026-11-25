import { describe, expect, it, vi } from "vitest";
import { OUTER_TMUX_ENV, PANE_ENV } from "../daemon/tmux.ts";
import backgroundBash, { backgroundHint, tasksPillLabel } from "../ext/background-bash/index.ts";
import {
	MONITOR_MESSAGE_TYPE,
	type MonitorMessageDetails,
	TASK_EXIT_MESSAGE_TYPE,
	type TaskExitDetails,
} from "../ext/background-bash/monitor-events.ts";

type Renderer = (message: any, options: any, theme: any) => { render(width: number): string[] } | undefined;

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
const options = { outputPad: 0, expanded: false } as any;

function renderers(): Record<string, Renderer> {
	const registered: Record<string, Renderer> = {};
	const pi = {
		on: () => {},
		registerEntryRenderer: () => {},
		registerCommand: () => {},
		registerTool: () => {},
		registerMessageRenderer: (type: string, renderer: Renderer) => {
			registered[type] = renderer;
		},
	} as any;
	backgroundBash(pi);
	return registered;
}

function render(type: string, details: unknown): string | undefined {
	const renderer = renderers()[type];
	const component = renderer(
		{ role: "custom", customType: type, content: "", display: true, details },
		options,
		theme,
	);
	return component?.render(120).join("\n");
}

const exitDetails: TaskExitDetails = {
	id: "b00000002",
	description: "make",
	command: "make",
	end: 'Background command "make" failed with exit code 1',
	outputFile: "/tmp/claude/x/b00000002.output",
	state: "failed",
};

const DOT = process.platform === "darwin" ? "⏺" : "●";

describe("task-exit renderer", () => {
	it("draws a dot and the summary, nothing else", () => {
		const out = render(TASK_EXIT_MESSAGE_TYPE, exitDetails) ?? "";
		expect(out.trim()).toBe(`${DOT} Background command "make" failed with exit code 1`);
		expect(out).not.toContain("b00000002.output");
	});

	it("colours the dot by the notification's status", () => {
		const seen: string[] = [];
		const colouring = {
			...theme,
			fg: (c: string, t: string) => {
				seen.push(c);
				return t;
			},
		};
		const draw = (state?: string) =>
			renderers()
				[TASK_EXIT_MESSAGE_TYPE](
					{
						role: "custom",
						customType: TASK_EXIT_MESSAGE_TYPE,
						content: "",
						display: true,
						details: { ...exitDetails, state },
					},
					options,
					colouring,
				)
				?.render(120);
		for (const state of ["completed", "failed", "killed", "stopped", undefined]) draw(state);
		expect(seen).toEqual(["success", "error", "warning"]);
	});

	it("falls back to pi's own rendering when the message carries no details", () => {
		expect(render(TASK_EXIT_MESSAGE_TYPE, undefined)).toBeUndefined();
	});

	it("strips escape sequences out of the summary", () => {
		const out = render(TASK_EXIT_MESSAGE_TYPE, { ...exitDetails, end: "\u001b[31mdone\u001b[0m" }) ?? "";
		expect(out).toContain(`${DOT} done`);
		expect(out).not.toContain("\u001b[31m");
	});
});

describe("monitor renderer", () => {
	const monitorDetails: MonitorMessageDetails = {
		id: "b00000003",
		description: "errors in deploy.log",
		lines: ["l1", "l2"],
		end: 'Monitor "errors in deploy.log" stream ended',
		status: "success",
	};

	it("renders the header, every event line and the end", () => {
		const out = render(MONITOR_MESSAGE_TYPE, monitorDetails) ?? "";
		expect(out).toContain("monitor b00000003 · errors in deploy.log");
		expect(out).toContain("l1");
		expect(out).toContain("l2");
		expect(out).toContain("stream ended");
	});

	it("falls back to pi's own rendering when the message carries no details", () => {
		expect(render(MONITOR_MESSAGE_TYPE, undefined)).toBeUndefined();
	});

	it("strips escape sequences out of the child's output", () => {
		const lines = ["\u001b[31mERROR\u001b[0m: boom\u001b[2K"];
		const out = render(MONITOR_MESSAGE_TYPE, { ...monitorDetails, lines }) ?? "";
		expect(out).toContain("ERROR: boom");
		expect(out).not.toContain("\u001b");
	});
});

describe("footer pill label", () => {
	const row = (id: string, kind: "shell" | "monitor" | "agent", state: "running" | "completed" = "running") =>
		({ id, kind, label: "x", state, startedAt: 0 }) as const;

	it.each([
		[[row("b00000001", "shell")], "1 shell"],
		[[row("b00000001", "shell"), row("b00000002", "shell")], "2 shells"],
		[[row("b00000001", "shell"), row("b00000002", "monitor")], "1 shell, 1 monitor"],
		[[row("b00000001", "monitor"), row("b00000002", "monitor")], "2 monitors"],
		[[row("s00000001", "monitor")], "1 monitor"],
		[[row("sa-1", "agent"), row("b00000001", "shell")], "1 shell"],
		[[row("s00000001", "monitor"), row("b00000001", "monitor")], "2 background tasks"],
	])("labels %j as %s", (rows, label) => {
		expect(tasksPillLabel([...rows])).toBe(label);
	});

	it("counts only what is running, and shows nothing when nothing is", () => {
		expect(tasksPillLabel([row("b00000001", "shell", "completed")])).toBeUndefined();
		expect(tasksPillLabel([row("b00000001", "shell"), row("b00000002", "shell", "completed")])).toBe("1 shell");
		expect(tasksPillLabel([row("sa-1", "agent"), row("sa-2", "agent")])).toBeUndefined();
	});
});

describe("background hint", () => {
	const once = "(ctrl+b to run in background)";
	const twice = "(ctrl+b ctrl+b (twice) to run in background)";

	it("asks for one press outside tmux", () => {
		vi.stubEnv("TMUX", "");
		vi.stubEnv(PANE_ENV, "");
		expect(backgroundHint()).toBe(once);
	});

	it("asks for two presses in the user's own tmux, whose prefix takes the first", () => {
		vi.stubEnv("TMUX", "/tmp/tmux-501/default,1,0");
		vi.stubEnv(PANE_ENV, "");
		expect(backgroundHint()).toBe(twice);
	});

	it("asks for one press in a pane of the private server, which has no prefix", () => {
		vi.stubEnv("TMUX", "/srv/tmux.sock,1,0");
		vi.stubEnv(PANE_ENV, "pi-1");
		vi.stubEnv(OUTER_TMUX_ENV, "0");
		expect(backgroundHint()).toBe(once);
	});

	it("asks for two presses in a pane the daemon started, as no terminal says otherwise", () => {
		vi.stubEnv("TMUX", "/srv/tmux.sock,1,0");
		vi.stubEnv(PANE_ENV, "pi-1");
		vi.stubEnv(OUTER_TMUX_ENV, "");
		expect(backgroundHint()).toBe(twice);
	});

	it("asks for two presses in a pane started from inside the user's own tmux", () => {
		vi.stubEnv("TMUX", "/srv/tmux.sock,1,0");
		vi.stubEnv(PANE_ENV, "pi-1");
		vi.stubEnv(OUTER_TMUX_ENV, "1");
		expect(backgroundHint()).toBe(twice);
	});
});
