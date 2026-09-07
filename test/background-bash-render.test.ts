import { describe, expect, it } from "vitest";
import {
	MONITOR_MESSAGE_TYPE,
	type MonitorMessageDetails,
	TASK_EXIT_MESSAGE_TYPE,
	type TaskExitDetails,
} from "../ext/_shared/monitor-events.ts";
import backgroundBash from "../ext/background-bash/index.ts";

type Renderer = (message: any, options: any, theme: any) => { render(width: number): string[] } | undefined;

/** The colours are not what these tests are about, so every theme call is the identity. */
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
const options = { outputPad: 0, expanded: false } as any;

/** Runs the extension factory against a fake pi and returns the two message renderers by type. */
function renderers(): Record<string, Renderer> {
	const registered: Record<string, Renderer> = {};
	const pi = {
		registerTool: () => {},
		registerEntryRenderer: () => {},
		registerCommand: () => {},
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
	id: "bash_2",
	description: "make",
	command: "make",
	end: "exited with code 1",
	tail: "boom",
	status: "error",
};

describe("task-exit renderer", () => {
	it("names the command once when it is also the description", () => {
		const out = render(TASK_EXIT_MESSAGE_TYPE, exitDetails) ?? "";
		expect(out).toContain("task bash_2 · make exited with code 1");
		expect(out).not.toContain("make exited with code 1 — make");
		expect(out).toContain("boom");
	});

	it("names the command once beside a description of its own", () => {
		const out = render(TASK_EXIT_MESSAGE_TYPE, { ...exitDetails, description: "build" }) ?? "";
		expect(out).toContain("task bash_2 · build exited with code 1 — make");
		expect(out.split("— make").length - 1).toBe(1);
	});

	it("falls back to pi's own rendering when the message carries no details", () => {
		expect(render(TASK_EXIT_MESSAGE_TYPE, undefined)).toBeUndefined();
	});

	it("strips escape sequences out of the child's output", () => {
		const tail = "\u001b[31mERROR\u001b[0m: boom\u001b[2K";
		const out = render(TASK_EXIT_MESSAGE_TYPE, { ...exitDetails, tail }) ?? "";
		expect(out).toContain("ERROR: boom");
		expect(out).not.toContain("\u001b");
	});
});

describe("monitor renderer", () => {
	const monitorDetails: MonitorMessageDetails = {
		id: "bash_3",
		description: "errors in deploy.log",
		lines: ["l1", "l2"],
		more: 3,
		end: "exited with code 0",
		status: "success",
	};

	it("renders the header, every event line, the overflow note and the end", () => {
		const out = render(MONITOR_MESSAGE_TYPE, monitorDetails) ?? "";
		expect(out).toContain("monitor bash_3 · errors in deploy.log");
		expect(out).toContain("l1");
		expect(out).toContain("l2");
		expect(out).toContain("3 more lines");
		expect(out).toContain("exited with code 0");
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
