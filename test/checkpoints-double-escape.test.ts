import { describe, expect, it } from "vitest";
import checkpoints from "../ext/checkpoints/index.ts";

const ESC = "\x1b";

/** checkpoints' session_start with a fake TUI; returns a key feeder and what it ran. */
async function load(state: { idle?: boolean; text?: string; overlay?: boolean } = {}) {
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const sent: string[] = [];
	checkpoints({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers[event] = handler;
		},
		registerCommand: () => {},
		sendUserMessage: (text: string) => sent.push(text),
	} as never);
	let onKey: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const released = { listener: false, widget: false };
	const tui = { hasOverlay: () => !!state.overlay, getFocusedComponent: () => ({ getText: () => "" }) };
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => state.idle ?? true,
		ui: {
			getEditorText: () => state.text ?? "",
			onTerminalInput: (handler: typeof onKey) => {
				onKey = handler;
				return () => {
					released.listener = true;
				};
			},
			setWidget: (_key: string, factory?: (tui: unknown) => unknown) => {
				if (factory) factory(tui);
				else released.widget = true;
			},
		},
	};
	await handlers.session_start({}, ctx);
	return {
		press: (data: string) => onKey?.(data),
		sent,
		released,
		shutdown: () => handlers.session_shutdown?.({}, ctx),
	};
}

describe("Esc Esc opens /rewind", () => {
	it("a second Esc on an empty idle prompt runs /rewind instead of pi's /tree", async () => {
		const { press, sent } = await load();
		expect(press(ESC)).toBeUndefined();
		expect(press(ESC)).toEqual({ consume: true });
		expect(sent).toEqual(["/rewind"]);
	});

	it("leaves Esc to pi while a turn runs, with text in the prompt, or over a dialog", async () => {
		for (const state of [{ idle: false }, { text: "draft" }, { overlay: true }]) {
			const { press, sent } = await load(state);
			press(ESC);
			expect(press(ESC)).toBeUndefined();
			expect(sent).toEqual([]);
		}
	});
});

describe("session end", () => {
	it("lets go of the keyboard and the TUI it held", async () => {
		const { shutdown, released } = await load();
		await shutdown();
		expect(released).toEqual({ listener: true, widget: true });
	});
});
