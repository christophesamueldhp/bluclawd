import { describe, expect, it } from "vitest";
import {
	createModeStore,
	isModeAllowedUntrusted,
	MODE_CYCLE,
	MODE_DESCRIPTIONS,
	nextInCycle,
	PERMISSION_MODES,
	parseMode,
	SAFEST_MODE,
} from "../ext/permissions/modes.ts";

describe("mode vocabulary", () => {
	it("names modes after pi's own ask/always/never, plus the two scoped ones", () => {
		expect(PERMISSION_MODES).toEqual(["ask", "edits", "auto", "always", "never"]);
		expect(SAFEST_MODE).toBe("ask");
	});

	it("still accepts the Claude Code names this layer shipped with", () => {
		// A stored permissions.defaultMode, a script passing --permission-mode, and
		// muscle memory at the /mode prompt all go through parseMode.
		expect(parseMode("default")).toBe("ask");
		expect(parseMode("acceptEdits")).toBe("edits");
		expect(parseMode("bypass")).toBe("always");
		expect(parseMode("dontAsk")).toBe("never");
	});

	it("accepts the current names and surrounding whitespace, and rejects anything else", () => {
		for (const mode of PERMISSION_MODES) expect(parseMode(mode)).toBe(mode);
		expect(parseMode("  auto  ")).toBe("auto");
		expect(parseMode("plan")).toBeUndefined();
		expect(parseMode("")).toBeUndefined();
		expect(parseMode("ASK")).toBeUndefined();
	});

	it("keeps the two non-interactive modes off the keyboard cycle", () => {
		expect(MODE_CYCLE).toEqual(["ask", "edits", "auto"]);
		expect(MODE_CYCLE).not.toContain("always");
		expect(MODE_CYCLE).not.toContain("never");
	});

	it("describes every mode, for the /mode picker", () => {
		for (const mode of PERMISSION_MODES) expect(MODE_DESCRIPTIONS[mode]).toBeTruthy();
	});
});

describe("mode store", () => {
	it("starts in the safest mode and cycles through the three interactive ones", () => {
		const store = createModeStore();
		expect(store.get()).toBe("ask");
		expect(store.cycle()).toBe("edits");
		expect(store.cycle()).toBe("auto");
		expect(store.cycle()).toBe("ask");
	});

	it("resumes the cycle at ask when the current mode is outside it", () => {
		const store = createModeStore();
		store.set("never");
		expect(store.cycle()).toBe("ask");
	});

	it("reports every change once, and not for a no-op set", () => {
		const seen: string[] = [];
		const store = createModeStore((mode) => seen.push(mode));
		store.set("auto");
		store.set("auto");
		store.cycle();
		expect(seen).toEqual(["auto", "ask"]);
	});
});

describe("project trust clamps the mode", () => {
	const untrusted = () => createModeStore(undefined, () => false);

	it("refuses every mode above the safest one", () => {
		const store = untrusted();
		for (const mode of PERMISSION_MODES) {
			const allowed = store.set(mode);
			expect(allowed).toBe(isModeAllowedUntrusted(mode));
			expect(store.get()).toBe("ask");
		}
	});

	it("makes cycling a no-op instead of a silent partial raise", () => {
		const store = untrusted();
		expect(store.cycle()).toBe("ask");
		expect(store.cycle()).toBe("ask");
	});

	it("can still name the mode a refused cycle was aiming at", () => {
		// cycle() reports the mode still in effect, so a refusal needs this to explain
		// itself: "ask was refused" while sitting in ask reads as nonsense.
		expect(nextInCycle("ask")).toBe("edits");
		expect(nextInCycle("edits")).toBe("auto");
		expect(nextInCycle("auto")).toBe("ask");
		expect(nextInCycle("never")).toBe("ask");
	});

	it("never fires onChange for a refused transition", () => {
		const seen: string[] = [];
		const store = createModeStore(
			(mode) => seen.push(mode),
			() => false,
		);
		store.set("always");
		store.cycle();
		expect(seen).toEqual([]);
	});

	it("re-reads trust on every transition, so /trust unlocks mid-session", () => {
		let trusted = false;
		const store = createModeStore(undefined, () => trusted);
		expect(store.set("auto")).toBe(false);
		trusted = true;
		expect(store.set("auto")).toBe(true);
		expect(store.get()).toBe("auto");
	});

	it("lets a trusted project reach every mode", () => {
		const store = createModeStore(undefined, () => true);
		for (const mode of PERMISSION_MODES) {
			expect(store.set(mode)).toBe(true);
			expect(store.get()).toBe(mode);
		}
	});
});
