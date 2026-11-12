import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import checkpoints from "../ext/checkpoints/index.ts";

const ESC = "\x1b";

// test/setup/agent-dir.ts sets PI_CODING_AGENT_DIR for every test file.
const settingsFile = () => join(process.env.PI_CODING_AGENT_DIR!, "settings.json");

/** pi's `doubleEscapeAction` in the user's settings; undefined leaves it unset. */
function setDoubleEscapeAction(action: string | undefined): void {
	writeFileSync(settingsFile(), JSON.stringify(action === undefined ? {} : { doubleEscapeAction: action }));
}

/** The session's directory: empty, so no project settings. */
const cwd = mkdtempSync(join(tmpdir(), "bluclawd-double-esc-"));

afterEach(() => {
	rmSync(settingsFile(), { force: true });
});

afterAll(() => {
	rmSync(cwd, { recursive: true, force: true });
});

/** checkpoints' session_start with a fake TUI; returns a key feeder and what it ran. */
async function load(state: { idle?: boolean; text?: string; overlay?: boolean; elsewhere?: boolean } = {}) {
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
	const tui = {
		hasOverlay: () => !!state.overlay,
		// Only the prompt editor has getText.
		getFocusedComponent: () => (state.elsewhere ? {} : { getText: () => "" }),
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd,
		isProjectTrusted: () => true,
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

describe("Esc Esc and pi's doubleEscapeAction", () => {
	it("leaves a double Esc to pi when the setting is unset, pi's default being its /tree", async () => {
		setDoubleEscapeAction(undefined);
		const { press, sent } = await load();
		expect(press(ESC)).toBeUndefined();
		expect(press(ESC)).toBeUndefined();
		expect(sent).toEqual([]);
	});

	it("leaves a double Esc to pi for every action pi runs on it", async () => {
		for (const action of ["tree", "fork"]) {
			setDoubleEscapeAction(action);
			const { press, sent } = await load();
			expect(press(ESC)).toBeUndefined();
			expect(press(ESC)).toBeUndefined();
			expect(sent).toEqual([]);
		}
	});

	it("opens /rewind on a second Esc on an empty idle prompt when pi's action is none", async () => {
		setDoubleEscapeAction("none");
		const { press, sent } = await load();
		expect(press(ESC)).toBeUndefined();
		expect(press(ESC)).toEqual({ consume: true });
		expect(sent).toEqual(["/rewind"]);
	});

	it("follows a change made during the session, as pi does", async () => {
		setDoubleEscapeAction("tree");
		const { press, sent } = await load();
		setDoubleEscapeAction("none");
		press(ESC);
		expect(press(ESC)).toEqual({ consume: true });
		setDoubleEscapeAction("tree");
		press(ESC);
		expect(press(ESC)).toBeUndefined();
		expect(sent).toEqual(["/rewind"]);
	});

	it("leaves Esc to pi while a turn runs, with text in the prompt, over a dialog, or with the keyboard elsewhere", async () => {
		setDoubleEscapeAction("none");
		for (const state of [{ idle: false }, { text: "draft" }, { overlay: true }, { elsewhere: true }]) {
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
