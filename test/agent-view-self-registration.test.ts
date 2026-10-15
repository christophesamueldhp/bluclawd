import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorClient, PaneMessage, RegisterInput } from "../daemon/orchestrator-client.ts";
import { piCommand } from "../daemon/tmux.ts";
import { deriveLabel, ForegroundActivity, SelfRegistration } from "../ext/agent-view/self-registration.ts";

describe("ForegroundActivity (what the roster shows for THIS window)", () => {
	it("starts idle, works during an agent run, and settles back to idle", () => {
		const fg = new ForegroundActivity();
		expect(fg.current).toBe("idle");
		expect(fg.apply({ type: "agent_start" })).toBe("working");
		expect(fg.apply({ type: "turn_start" })).toBe("working");
		expect(fg.apply({ type: "agent_settled" })).toBe("idle");
	});

	it("a blocking prompt mid-run is 'needs input'; answering it resumes 'working'", () => {
		const fg = new ForegroundActivity();
		fg.apply({ type: "agent_start" });
		expect(fg.apply({ type: "ui_prompt_start", kind: "confirm" })).toBe("awaiting_input");
		expect(fg.apply({ type: "ui_prompt_end", kind: "confirm" })).toBe("working");
	});

	it("a blocking prompt outside a run goes back to idle when answered", () => {
		const fg = new ForegroundActivity();
		expect(fg.apply({ type: "ui_prompt_start", kind: "select" })).toBe("awaiting_input");
		expect(fg.apply({ type: "ui_prompt_end", kind: "select" })).toBe("idle");
	});

	it("a 'custom' overlay (agent view itself, /diff, …) is not a question for the user", () => {
		const fg = new ForegroundActivity();
		fg.apply({ type: "agent_start" });
		expect(fg.apply({ type: "ui_prompt_start", kind: "custom" })).toBe("working");
		expect(fg.apply({ type: "ui_prompt_end", kind: "custom" })).toBe("working");
	});

	it("ignores unrelated events", () => {
		const fg = new ForegroundActivity();
		expect(fg.apply({ type: "tool_execution_start" })).toBe("idle");
	});
});

describe("deriveLabel (roster title for the foreground session)", () => {
	const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
	const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: text } });

	it("prefers the session's name", () => {
		expect(deriveLabel("my refactor", [user("do the thing")])).toBe("my refactor");
	});

	it("falls back to the first user message, first line only, trimmed to 60 chars", () => {
		const long = `  ${"x".repeat(70)}\nsecond line`;
		expect(deriveLabel(undefined, [assistant("hi"), user(long)])).toBe("x".repeat(60));
	});

	it("reads text blocks out of a structured user message", () => {
		const entry = {
			type: "message",
			message: { role: "user", content: [{ type: "image" }, { type: "text", text: "fix the footer" }] },
		};
		expect(deriveLabel(undefined, [entry])).toBe("fix the footer");
	});

	it("is undefined for an empty session, so the roster shows the id", () => {
		expect(deriveLabel(undefined, [])).toBeUndefined();
		expect(deriveLabel("", [assistant("hi")])).toBeUndefined();
	});
});

describe("SelfRegistration heartbeats", () => {
	function fakeClient() {
		const calls: RegisterInput[] = [];
		const client = {
			register: async (input: RegisterInput) => {
				calls.push(input);
			},
			unregister: async () => {},
		} as unknown as OrchestratorClient;
		return { client, calls };
	}

	it("re-registers immediately with the new activity when it changes", async () => {
		const { client, calls } = fakeClient();
		const reg = new SelfRegistration(client, () => ({ cwd: "/p", label: "deploy" }));
		reg.setActivity("working");
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.at(-1)?.activity).toBe("working");
		expect(calls.at(-1)?.label).toBe("deploy");
		reg.setActivity("working"); // unchanged: no extra heartbeat
		await new Promise((r) => setTimeout(r, 0));
		expect(calls.length).toBe(1);
	});

	it("tells the daemon its leaf and how to start another pi like it", async () => {
		const { client, calls } = fakeClient();
		const reg = new SelfRegistration(client, () => ({ cwd: "/p", leafId: "e7" }));
		await reg.refresh();
		expect(calls.at(-1)).toMatchObject({ leafId: "e7", launch: { command: piCommand() } });
	});
});

describe("SelfRegistration watched flag", () => {
	it("reports after every heartbeat whether a phone watches the session", async () => {
		const replies: Array<{ watched?: boolean } | Error> = [{ watched: true }, {}, new Error("daemon down")];
		const client = {
			register: async () => {
				const reply = replies.shift();
				if (reply instanceof Error) throw reply;
				return { messages: [], ...reply };
			},
			unregister: async () => {},
		} as unknown as OrchestratorClient;
		const watched: boolean[] = [];
		const reg = new SelfRegistration(
			client,
			() => ({ cwd: "/p" }),
			() => {},
			"pi-1",
			(w) => watched.push(w),
		);
		await reg.refresh();
		await reg.refresh();
		await reg.refresh();
		expect(watched).toEqual([true, false, false]);
	});
});

describe("SelfRegistration report request", () => {
	it("passes on each heartbeat's request for a report, which a restarted daemon lacks", async () => {
		const replies: Array<{ wantReport?: boolean }> = [{ wantReport: true }, {}];
		const client = {
			register: async () => ({ messages: [], watched: false, ...replies.shift() }),
			unregister: async () => {},
		} as unknown as OrchestratorClient;
		let asked = 0;
		const reg = new SelfRegistration(
			client,
			() => ({ cwd: "/p" }),
			() => {},
			"pi-1",
			() => {},
			() => asked++,
		);
		await reg.refresh();
		await reg.refresh();
		expect(asked).toBe(1);
	});
});

describe("SelfRegistration.stop", () => {
	it("unregisters and resolves when pi's API is gone by the time an in-flight register lands", async () => {
		let land: (reply: { watched: boolean; messages: [] }) => void = () => {};
		const unregistered: string[] = [];
		const client = {
			register: () =>
				new Promise((resolve) => {
					land = resolve;
				}),
			unregister: async (id: string) => {
				unregistered.push(id);
			},
		} as unknown as OrchestratorClient;
		let told = 0;
		const reg = new SelfRegistration(
			client,
			() => ({ cwd: "/p" }),
			() => {},
			"pi-1",
			() => {
				told++;
				throw new Error("extension API invalidated");
			},
		);
		const beat = reg.refresh();
		const stopping = reg.stop();
		land({ watched: true, messages: [] });
		await expect(stopping).resolves.toBeUndefined();
		await expect(beat).resolves.toBeUndefined();
		expect(unregistered).toEqual(["pi-1"]);
		expect(told).toBe(0);
	});

	it("can stop without unregistering, for the next session of the same pane to carry on its row", async () => {
		let land: (reply: { watched: boolean; messages: [] }) => void = () => {};
		const order: string[] = [];
		const client = {
			register: () =>
				new Promise((resolve) => {
					land = (reply) => {
						order.push("register");
						resolve(reply);
					};
				}),
			unregister: async () => {
				order.push("unregister");
			},
		} as unknown as OrchestratorClient;
		const reg = new SelfRegistration(
			client,
			() => ({ cwd: "/p" }),
			() => {},
			"pi-1",
		);
		void reg.refresh();
		const stopping = reg.stop({ unregister: false });
		land({ watched: false, messages: [] });
		await stopping;
		expect(order).toEqual(["register"]);
	});

	it("waits for every register on its way, not only the latest, before unregistering", async () => {
		const lands: Array<() => void> = [];
		const order: string[] = [];
		const client = {
			register: () =>
				new Promise((resolve) => {
					const n = lands.length + 1;
					lands.push(() => {
						order.push(`register-${n}`);
						resolve({ watched: false, messages: [] });
					});
				}),
			unregister: async () => {
				order.push("unregister");
			},
		} as unknown as OrchestratorClient;
		const reg = new SelfRegistration(
			client,
			() => ({ cwd: "/p" }),
			() => {},
			"pi-1",
		);
		void reg.refresh();
		reg.setActivity("working");
		const stopping = reg.stop();
		lands[1]();
		await new Promise((resolve) => setTimeout(resolve, 0));
		lands[0]();
		await stopping;
		expect(order).toEqual(["register-2", "register-1", "unregister"]);
	});

	it("queues again what a register on its way drains after the stop, instead of running it in a gone session", async () => {
		let land: (reply: { watched: boolean; messages: PaneMessage[] }) => void = () => {};
		const requeued: Array<[string, PaneMessage]> = [];
		const client = {
			register: () =>
				new Promise((resolve) => {
					land = resolve;
				}),
			unregister: async () => {},
			send: async (id: string, message: PaneMessage) => {
				requeued.push([id, message]);
			},
		} as unknown as OrchestratorClient;
		const handled: PaneMessage[] = [];
		const reg = new SelfRegistration(
			client,
			() => ({ cwd: "/p" }),
			(m) => handled.push(m),
			"pi-1",
		);
		void reg.refresh();
		const stopping = reg.stop({ unregister: false });
		land({ watched: false, messages: [{ type: "prompt", text: "edited" }, { type: "abort" }] });
		await stopping;
		expect(handled).toEqual([]);
		expect(requeued).toEqual([
			["pi-1", { type: "prompt", text: "edited" }],
			["pi-1", { type: "abort" }],
		]);
	});

	it("keeps a throwing onWatched from failing the heartbeat", async () => {
		const client = {
			register: async () => ({ watched: true, messages: [] }),
			unregister: async () => {},
		} as unknown as OrchestratorClient;
		const reg = new SelfRegistration(
			client,
			() => ({ cwd: "/p" }),
			() => {},
			"pi-1",
			() => {
				throw new Error("boom");
			},
		);
		await expect(reg.refresh()).resolves.toBeUndefined();
	});
});

describe("SelfRegistration waits for its next message", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** A daemon whose registers answer `replies` in turn (then none), and whose waits the test answers. */
	function waitingClient(replies: Array<PaneMessage[] | Error> = []) {
		const registers: number[] = [];
		const waits: Array<{ answer: (queued: boolean | undefined | Error) => void; signal: AbortSignal }> = [];
		const client = {
			register: async () => {
				registers.push(Date.now());
				const reply = replies.shift() ?? [];
				if (reply instanceof Error) throw reply;
				return { watched: false, messages: reply };
			},
			unregister: async () => {},
			send: async () => {},
			wait: (_id: string, signal: AbortSignal) =>
				new Promise<boolean | undefined>((resolve, reject) => {
					waits.push({ answer: (q) => (q instanceof Error ? reject(q) : resolve(q)), signal });
				}),
		} as unknown as OrchestratorClient;
		return { client, registers, waits };
	}

	function started(client: OrchestratorClient, handled: PaneMessage[] = []) {
		const reg = new SelfRegistration(
			client,
			() => ({ cwd: "/p" }),
			(m) => handled.push(m),
			"pi-1",
		);
		reg.start();
		return reg;
	}

	it("waits once registered, and registers at once when woken, to take what was queued", async () => {
		vi.useFakeTimers();
		const { client, registers, waits } = waitingClient([[], [{ type: "abort" }]]);
		const handled: PaneMessage[] = [];
		const reg = started(client, handled);
		await vi.advanceTimersByTimeAsync(0);
		expect(registers).toHaveLength(1);
		expect(waits).toHaveLength(1);
		waits[0].answer(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(registers).toHaveLength(2);
		expect(handled).toEqual([{ type: "abort" }]);
		expect(waits).toHaveLength(2);
		await reg.stop();
	});

	it("waits again when a wait ends with nothing queued", async () => {
		vi.useFakeTimers();
		const { client, registers, waits } = waitingClient();
		const reg = started(client);
		await vi.advanceTimersByTimeAsync(0);
		waits[0].answer(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(registers).toHaveLength(1);
		expect(waits).toHaveLength(2);
		await reg.stop();
	});

	it("does not wait before a register has succeeded, nor without being started", async () => {
		vi.useFakeTimers();
		const { client, waits } = waitingClient([new Error("daemon down")]);
		const reg = started(client);
		await vi.advanceTimersByTimeAsync(0);
		expect(waits).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(3000);
		expect(waits).toHaveLength(1);
		await reg.stop();

		const other = waitingClient();
		const unstarted = new SelfRegistration(other.client, () => ({ cwd: "/p" }));
		await unstarted.refresh();
		expect(other.waits).toHaveLength(0);
	});

	it.each([[{ type: "fork", entryId: "1a2b3c4d" }], [{ type: "compact" }]] as PaneMessage[][])(
		"after %o, leaves what follows it to the next heartbeat",
		async (message) => {
			vi.useFakeTimers();
			const { client, registers, waits } = waitingClient([[], [message], []]);
			const handled: PaneMessage[] = [];
			const reg = started(client, handled);
			await vi.advanceTimersByTimeAsync(0);
			waits[0].answer(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(handled).toEqual([message]);
			expect(waits).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(3000);
			expect(registers).toHaveLength(3);
			expect(waits).toHaveLength(2);
			await reg.stop();
		},
	);

	it("after a prompt, leaves a move queued behind it to the turn's first heartbeat", async () => {
		vi.useFakeTimers();
		const { client, registers, waits } = waitingClient([
			[],
			[{ type: "prompt", text: "hi" }],
			[{ type: "tree", entryId: "1a2b3c4d" }],
		]);
		const handled: PaneMessage[] = [];
		const reg = started(client, handled);
		await vi.advanceTimersByTimeAsync(0);
		waits[0].answer(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(handled).toEqual([{ type: "prompt", text: "hi" }]);
		expect(registers).toHaveLength(2);
		expect(waits).toHaveLength(1);
		// agent_start's heartbeat, by which pi no longer reports the pane idle.
		reg.setActivity("working");
		await vi.advanceTimersByTimeAsync(0);
		expect(registers).toHaveLength(3);
		expect(handled).toEqual([
			{ type: "prompt", text: "hi" },
			{ type: "tree", entryId: "1a2b3c4d" },
		]);
		await reg.stop();
	});

	it("does not register on a wake that comes after a navigation another heartbeat delivered", async () => {
		vi.useFakeTimers();
		const { client, registers, waits } = waitingClient([[], [{ type: "tree", entryId: "1a2b3c4d" }]]);
		const reg = started(client);
		await vi.advanceTimersByTimeAsync(0);
		reg.setActivity("working");
		await vi.advanceTimersByTimeAsync(0);
		expect(registers).toHaveLength(2);
		waits[0].answer(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(registers).toHaveLength(2);
		expect(waits).toHaveLength(1);
		await reg.stop();
	});

	it("waits again only after the next heartbeat when a wait fails", async () => {
		vi.useFakeTimers();
		const { client, waits } = waitingClient();
		const reg = started(client);
		await vi.advanceTimersByTimeAsync(0);
		waits[0].answer(new Error("Unknown instance: pi-1"));
		await vi.advanceTimersByTimeAsync(2999);
		expect(waits).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(waits).toHaveLength(2);
		await reg.stop();
	});

	it("on a daemon that does not know the request, asks again only at the next heartbeat", async () => {
		vi.useFakeTimers();
		const { client, registers, waits } = waitingClient();
		const reg = started(client);
		await vi.advanceTimersByTimeAsync(0);
		waits[0].answer(undefined);
		await vi.advanceTimersByTimeAsync(2999);
		expect(registers).toHaveLength(1);
		expect(waits).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(registers).toHaveLength(2);
		expect(waits).toHaveLength(2);
		await reg.stop();
	});

	it("ends its wait on stop, and a wake that still comes registers nothing", async () => {
		vi.useFakeTimers();
		const { client, registers, waits } = waitingClient();
		const reg = started(client);
		await vi.advanceTimersByTimeAsync(0);
		await reg.stop({ unregister: false });
		expect(waits[0].signal.aborted).toBe(true);
		waits[0].answer(true);
		await vi.advanceTimersByTimeAsync(3000);
		expect(registers).toHaveLength(1);
	});
});
