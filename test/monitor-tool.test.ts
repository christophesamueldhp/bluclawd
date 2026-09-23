import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackgroundExec, BackgroundJobRegistry } from "../ext/_shared/background-bash.ts";
import { createMonitorTool, stdoutOnly, websocketExec } from "../ext/sandbox/monitor-tool.ts";

function harness(exec: BackgroundExec, refuse?: string) {
	const sent: { message: any; options: any }[] = [];
	const registry = new BackgroundJobRegistry();
	const tool = createMonitorTool({
		sendMessage: (message, options) => sent.push({ message, options }),
		cwd: "/",
		exec: () => exec,
		refuse: () => refuse,
		registry,
		rateLimit: { capacity: 2, refillMs: 60_000, maxSuppressMs: 500 },
	}) as any;
	const id = () => registry.list()[0]?.id as string;
	return { tool, sent, registry, id };
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

	it("starts a monitor job and reports its id in Claude Code's words", async () => {
		const { tool, registry, id } = harness(() => new Promise(() => {}));
		const result = await tool.execute(
			"c1",
			{ command: "tail -f x", description: "x errors", persistent: false },
			undefined as any,
			undefined,
		);
		expect(id()).toMatch(/^b[0-9a-z]{8}$/);
		expect(result.content[0].text).toBe(
			`Monitor started (task ${id()}, expires in 5m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`,
		);
		expect(registry.get(id())).toMatchObject({ kind: "monitor", description: "x errors" });
	});

	it("sends one steer+triggerTurn notification per batch and a terminal one on exit", async () => {
		// The process outlives the 200ms batch window, so the batch and the exit are two messages.
		const exec: BackgroundExec = async (_c, _d, { onData }) => {
			onData(Buffer.from("a\nb\n"));
			await new Promise((r) => setTimeout(r, 500));
			return { exitCode: 0 };
		};
		const { tool, sent } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d", persistent: false }, undefined as any, undefined);
		await vi.advanceTimersByTimeAsync(600);
		expect(sent).toHaveLength(2);
		expect(sent[0].message.content).toContain('<summary>Monitor event: "d"</summary>\n<event>a\nb</event>');
		expect(sent[1].message.content).toContain('<summary>Monitor "d" stream ended</summary>');
		expect(sent[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	it("folds leftover lines into the terminal message instead of sending two", async () => {
		const exec: BackgroundExec = async (_c, _d, { onData }) => {
			onData(Buffer.from("only\n"));
			return { exitCode: 3 };
		};
		const { tool, sent, registry, id } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d", persistent: false }, undefined as any, undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toContain(
			'<summary>Monitor "d" script failed (exit 3)</summary>\n<event>only</event>',
		);
		// The leftover line rode along in the terminal message but is still an event: /tasks must count it.
		expect(registry.get(id())?.events).toBe(1);
	});

	it("keeps the event count at 0 when a monitor exits with no leftover lines", async () => {
		const exec: BackgroundExec = async () => ({ exitCode: 0 });
		const { tool, registry, id, sent } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d", persistent: false }, undefined as any, undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(registry.get(id())?.events).toBe(0);
		expect(sent[0].message.content).toContain('Monitor "d" ended without producing output (exit 0)');
	});

	it("suppresses events past the bucket, says so, and stops after a long suppression", async () => {
		let onDataRef!: (b: Buffer) => void;
		const exec: BackgroundExec = (_c, _d, { onData, signal }) =>
			new Promise((_resolve, reject) => {
				onDataRef = onData;
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const { tool, sent, registry, id } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d", persistent: false }, undefined as any, undefined);
		for (let i = 0; i < 7; i++) {
			onDataRef(Buffer.from(`${i}\n`));
			await vi.advanceTimersByTimeAsync(250);
		}
		// Two events through, the rest suppressed until the suppression outlasted 500ms.
		expect(
			sent.filter((s) => s.message.content.includes("<event>0") || s.message.content.includes("<event>1")),
		).toHaveLength(2);
		expect(registry.get(id())?.stopReason).toMatch(
			/^\[Monitor stopped — too much output \(\d+ events suppressed over \d+s\)/,
		);
		expect(sent.at(-1)?.message.content).toContain("[Monitor stopped — too much output");
		const afterExit = sent.length;
		onDataRef(Buffer.from("late\n"));
		await vi.advanceTimersByTimeAsync(250);
		expect(sent.length).toBe(afterExit);
	});

	it("reports how many events it suppressed once the bucket refills", async () => {
		let onDataRef!: (b: Buffer) => void;
		const exec: BackgroundExec = (_c, _d, { onData }) =>
			new Promise(() => {
				onDataRef = onData;
			});
		const sent: { message: any }[] = [];
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const tool = createMonitorTool({
			sendMessage: (message) => sent.push({ message }),
			cwd: "/",
			exec: () => exec,
			refuse: () => undefined,
			registry,
			rateLimit: { capacity: 1, refillMs: 1000, maxSuppressMs: 60_000 },
		}) as any;
		await tool.execute("c1", { command: "x", description: "d" }, undefined as any, undefined);
		onDataRef(Buffer.from("first\n"));
		await vi.advanceTimersByTimeAsync(250);
		onDataRef(Buffer.from("dropped\n"));
		await vi.advanceTimersByTimeAsync(250);
		await vi.advanceTimersByTimeAsync(1000);
		onDataRef(Buffer.from("back\n"));
		await vi.advanceTimersByTimeAsync(250);
		expect(sent).toHaveLength(2);
		expect(sent[1].message.content).toContain(
			"<event>[1 events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]\nback</event>",
		);
	});

	it("sends one expiry notice when the timeout ends it", async () => {
		const exec: BackgroundExec = async (_c, _d, { timeout }) => {
			throw new Error(`timeout:${timeout}`);
		};
		const { tool, sent } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d" }, undefined as any, undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toContain(
			"<event>[Monitor expired after 5m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]</event>",
		);
	});

	it("delivers nothing more once killed, even if the child ignores the signal", async () => {
		let onDataRef!: (b: Buffer) => void;
		// A child that traps SIGTERM: the abort never ends it, so the job never exits and
		// the exit guard alone would let it keep steering the model.
		const exec: BackgroundExec = (_c, _d, { onData }) =>
			new Promise(() => {
				onDataRef = onData;
			});
		const { tool, sent, registry, id } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d" }, undefined as any, undefined);
		registry.kill(id(), "a registry stop");
		const afterKill = sent.length;
		onDataRef(Buffer.from("late\n"));
		await vi.advanceTimersByTimeAsync(250);
		expect(sent.length).toBe(afterKill);
	});

	it("stays quiet after the model's own task_stop, and tells it about a stop the user made", async () => {
		const exec: BackgroundExec = (_c, _d, { signal }) =>
			new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		const { tool, sent, registry } = harness(exec);
		await tool.execute("c1", { command: "x", description: "d" }, undefined as any, undefined);
		await tool.execute("c2", { command: "y", description: "e" }, undefined as any, undefined);
		const [first, second] = registry.list();
		registry.kill(first.id);
		registry.kill(second.id, undefined, true);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toContain('<summary>Task "e" was stopped by the user</summary>');
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

describe("monitor sources", () => {
	it("refuses a call with neither or both of command and ws", async () => {
		const { tool } = harness(async () => ({ exitCode: 0 }));
		for (const params of [{ description: "d" }, { command: "x", ws: { url: "wss://h" }, description: "d" }]) {
			const result = await tool.execute("c1", params, undefined as any, undefined);
			expect(result.isError).toBe(true);
		}
	});

	it("runs the command when a strict-schema model sends an empty ws beside it", async () => {
		const seen: string[] = [];
		const { tool, registry } = harness(async (command) => {
			seen.push(command);
			return { exitCode: 0 };
		});
		const result = await tool.execute(
			"c1",
			{ command: "echo hi", ws: { url: "", protocols: [] }, description: "d" },
			undefined as any,
			undefined,
		);
		expect(result.isError).toBeUndefined();
		expect(registry.list()[0].command).toBe("echo hi");
	});

	it("sends a command's stderr to the output file instead of the event stream", async () => {
		const seen: string[] = [];
		const exec: BackgroundExec = async (command) => {
			seen.push(command);
			return { exitCode: 0 };
		};
		await stdoutOnly(exec)("grep x log", "/", { onData: () => {}, outputFile: "/tmp/it's.output" });
		expect(seen[0]).toBe("{ grep x log\n} 2>>'/tmp/it'\\''s.output'");
		await stdoutOnly(exec)("grep x log", "/", { onData: () => {} });
		expect(seen[1]).toBe("grep x log");
	});

	it("turns WebSocket frames into lines and close into the exit", async () => {
		class FakeSocket {
			static last: FakeSocket;
			binaryType = "";
			listeners: Record<string, ((e: any) => void)[]> = {};
			constructor() {
				FakeSocket.last = this;
			}
			addEventListener(type: string, fn: (e: any) => void) {
				this.listeners[type] = [...(this.listeners[type] ?? []), fn];
			}
			emit(type: string, event: any) {
				for (const fn of this.listeners[type] ?? []) fn(event);
			}
			close() {}
		}
		vi.stubGlobal("WebSocket", FakeSocket);
		try {
			const out: string[] = [];
			const run = websocketExec("wss://events.example/stream")("", "/", { onData: (d) => out.push(d.toString()) });
			FakeSocket.last.emit("message", { data: "deploy started" });
			FakeSocket.last.emit("message", { data: new ArrayBuffer(4) });
			FakeSocket.last.emit("close", { code: 1006, reason: "" });
			expect(await run).toEqual({ exitCode: 1006 });
			expect(out).toEqual(["deploy started\n", "[binary frame, 4 bytes]\n", "[WebSocket closed: 1006]\n"]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
