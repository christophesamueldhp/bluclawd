import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackgroundExec, BackgroundJobRegistry } from "../ext/_shared/background-bash.ts";
import { createMonitorTool } from "../ext/sandbox/monitor-tool.ts";

function harness(exec: BackgroundExec, refuse?: string) {
	const sent: { message: any; options: any }[] = [];
	const registry = new BackgroundJobRegistry();
	const tool = createMonitorTool({
		sendMessage: (message, options) => sent.push({ message, options }),
		cwd: "/",
		exec: () => exec,
		refuse: () => refuse,
		registry,
		rateLimit: { max: 2, windowMs: 60_000 },
	}) as any;
	return { tool, sent, registry };
}

describe("monitor tool", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("accepts a call that omits persistent", () => {
		// pi validates but never applies schema defaults, so a required `persistent`
		// would turn the documented default into a validation error.
		const { tool } = harness(() => new Promise(() => {}));
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "c1",
			name: "monitor",
			arguments: { command: "x", description: "d" },
		});
		expect(args).toMatchObject({ command: "x" });
	});

	it("refuses when the sandbox refusal applies", async () => {
		const { tool, registry } = harness(async () => ({ exitCode: 0 }), "Refusing to run");
		const result = await tool.execute(
			"c1",
			{ command: "x", description: "d", persistent: false },
			undefined as any,
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(registry.list()).toEqual([]);
	});

	it("starts a monitor job and reports its id", async () => {
		const { tool, registry } = harness(() => new Promise(() => {}));
		const result = await tool.execute(
			"c1",
			{ command: "tail -f x", description: "x errors", persistent: false },
			undefined as any,
			undefined,
		);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Started monitor bash_1") });
		expect(registry.get("bash_1")).toMatchObject({ kind: "monitor", description: "x errors" });
	});

	it("sends one steer+triggerTurn message per batch and a terminal one on exit", async () => {
		// The process outlives the 200ms batch window, so the batch and the exit are two messages.
		const exec: BackgroundExec = async (_c, _d, { onData }) => {
			onData(Buffer.from("a\nb\n"));
			await new Promise((r) => setTimeout(r, 500));
			return { exitCode: 0 };
		};
		const { tool, sent } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d", persistent: false }, undefined as any, undefined);
		await vi.advanceTimersByTimeAsync(600);
		expect(sent.map((s) => s.message.content)).toEqual([
			"[monitor bash_1 · d]\na\nb",
			"[monitor bash_1 · d]\nexited with code 0",
		]);
		expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("folds leftover lines into the terminal message instead of sending two", async () => {
		const exec: BackgroundExec = async (_c, _d, { onData }) => {
			onData(Buffer.from("only\n"));
			return { exitCode: 3 };
		};
		const { tool, sent } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d", persistent: false }, undefined as any, undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent.map((s) => s.message.content)).toEqual(["[monitor bash_1 · d]\nonly\nexited with code 3"]);
	});

	it("stops a monitor that exceeds the rate limit", async () => {
		let onDataRef!: (b: Buffer) => void;
		const exec: BackgroundExec = (_c, _d, { onData, signal }) =>
			new Promise((_resolve, reject) => {
				onDataRef = onData;
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const { tool, sent, registry } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d", persistent: false }, undefined as any, undefined);
		for (let i = 0; i < 3; i++) {
			onDataRef(Buffer.from(`${i}\n`));
			await vi.advanceTimersByTimeAsync(250);
		}
		expect(registry.get("bash_1")?.stopReason).toContain("too many events");
		expect(sent.at(-1)?.message.content).toContain(
			"stopped: too many events (2 in 60s), restart with a tighter filter",
		);
		const afterExit = sent.length;
		onDataRef(Buffer.from("late\n"));
		await vi.advanceTimersByTimeAsync(250);
		expect(sent.length).toBe(afterExit);
	});

	it("delivers nothing more once killed, even if the child ignores the signal", async () => {
		let onDataRef!: (b: Buffer) => void;
		// A child that traps SIGTERM: the abort never ends it, so the job never exits and
		// the exit guard alone would let it keep steering the model.
		const exec: BackgroundExec = (_c, _d, { onData }) =>
			new Promise(() => {
				onDataRef = onData;
			});
		const { tool, sent, registry } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d" }, undefined as any, undefined);
		for (let i = 0; i < 3; i++) {
			onDataRef(Buffer.from(`${i}\n`));
			await vi.advanceTimersByTimeAsync(250);
		}
		expect(registry.get("bash_1")?.killed).toBe(true);
		const afterKill = sent.length;
		onDataRef(Buffer.from("late\n"));
		await vi.advanceTimersByTimeAsync(250);
		expect(sent.length).toBe(afterKill);
	});

	it("delivers nothing more after kill_bash, even if the child ignores the signal", async () => {
		let onDataRef!: (b: Buffer) => void;
		const exec: BackgroundExec = (_c, _d, { onData }) =>
			new Promise(() => {
				onDataRef = onData;
			});
		const { tool, sent, registry } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d" }, undefined as any, undefined);
		// No reason: this is the model's own kill_bash, not a registry-initiated stop.
		registry.kill("bash_1");
		const afterKill = sent.length;
		onDataRef(Buffer.from("late\n"));
		await vi.advanceTimersByTimeAsync(250);
		expect(sent.length).toBe(afterKill);
	});

	it("passes the timeout through unless persistent, clamped to the maximum", async () => {
		const seen: (number | undefined)[] = [];
		const exec: BackgroundExec = (_c, _d, { timeout }) => {
			seen.push(timeout);
			return new Promise(() => {});
		};
		const { tool } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d", persistent: false }, undefined as any, undefined);
		await tool.execute(
			"c2",
			{ command: "x", description: "d", persistent: false, timeout: 60 },
			undefined as any,
			undefined,
		);
		await tool.execute(
			"c3",
			{ command: "x", description: "d", persistent: true, timeout: 60 },
			undefined as any,
			undefined,
		);
		await tool.execute(
			"c4",
			{ command: "x", description: "d", persistent: false, timeout: 7200 },
			undefined as any,
			undefined,
		);
		expect(seen).toEqual([300, 60, undefined, 3600]);
	});
});
