import { getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import vibes from "../ext/vibes/index.ts";
import { pickVibe, SPINNER_VERBS } from "../ext/vibes/vibes.ts";

describe("SPINNER_VERBS", () => {
	it("holds bluclawd's single-word verbs except Clauding (186), capitalised, without duplicates or ellipses", () => {
		expect(SPINNER_VERBS).toHaveLength(186);
		expect(new Set(SPINNER_VERBS).size).toBe(186);
		for (const verb of SPINNER_VERBS) expect(verb).toMatch(/^[A-Z][\p{L}'-]+$/u);
		expect(SPINNER_VERBS).toContain("Flambéing");
		expect(SPINNER_VERBS).toContain("Working");
		expect(SPINNER_VERBS).not.toContain("Clauding");
	});
});

describe("pickVibe", () => {
	it("walks a seeded shuffle that uses every vibe once before repeating", () => {
		const vibes = ["a...", "b...", "c...", "d..."];
		const firstRound = [0, 1, 2, 3].map((index) => pickVibe(vibes, index, 42));
		expect([...firstRound].sort()).toEqual(vibes);
		expect(pickVibe(vibes, 4, 42)).toBe(firstRound[0]);
		expect([0, 1, 2, 3].map((index) => pickVibe(vibes, index, 42))).toEqual(firstRound);
	});
});

describe("the working message", () => {
	const piKeybindings = getKeybindings();
	const bindInterrupt = (keys: string) =>
		setKeybindings(new KeybindingsManager({ "app.interrupt": { defaultKeys: keys, description: "" } } as never));
	afterEach(() => setKeybindings(piKeybindings));

	function started() {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		vibes({ on: (event: string, handler: any) => handlers.set(event, handler) } as never);
		const setWorkingMessage = vi.fn();
		const ctx = { hasUI: true, ui: { setWorkingMessage } };
		const emit = (event: string) => handlers.get(event)?.({}, ctx);
		emit("before_agent_start");
		return { emit, setWorkingMessage };
	}

	it("counts the run's elapsed seconds after its verb and ends with the interrupt hint, through each of pi's passes", () => {
		vi.useFakeTimers();
		try {
			bindInterrupt("escape");
			const { emit, setWorkingMessage } = started();
			const first: string = setWorkingMessage.mock.lastCall?.[0];
			const verb = first.match(/^([A-Z][\p{L}'-]+)… \(0s · escape to interrupt\)$/u)?.[1];
			expect(SPINNER_VERBS).toContain(verb);

			vi.advanceTimersByTime(12_000);
			expect(setWorkingMessage).toHaveBeenLastCalledWith(`${verb}… (12s · escape to interrupt)`);

			// A retry or a queued follow-up ends one pass and starts another within the same run.
			emit("agent_end");
			vi.advanceTimersByTime(1_000);
			expect(setWorkingMessage).toHaveBeenLastCalledWith(`${verb}… (13s · escape to interrupt)`);
		} finally {
			vi.useRealTimers();
		}
	});

	it("names the interrupt key the user bound", () => {
		bindInterrupt("ctrl+g");
		const { emit, setWorkingMessage } = started();
		expect(setWorkingMessage.mock.lastCall?.[0]).toMatch(/… \(0s · ctrl\+g to interrupt\)$/);
		emit("agent_settled");
	});

	it.each(["agent_settled", "session_shutdown"])("stops on %s", (event) => {
		vi.useFakeTimers();
		try {
			const { emit, setWorkingMessage } = started();
			emit(event);
			if (event === "agent_settled") expect(setWorkingMessage).toHaveBeenLastCalledWith();
			const calls = setWorkingMessage.mock.calls.length;
			vi.advanceTimersByTime(5_000);
			expect(setWorkingMessage).toHaveBeenCalledTimes(calls);
		} finally {
			vi.useRealTimers();
		}
	});
});
