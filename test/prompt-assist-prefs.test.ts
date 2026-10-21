import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL,
	loadAssistEnabled,
	loadAssistModel,
	saveAssistEnabled,
	saveAssistModel,
} from "../ext/prompt-assist/prefs.ts";

const directory = () => mkdtempSync(join(tmpdir(), "prompt-assist-"));

describe("prompt assist preferences", () => {
	it("defaults to MiMo without configuration", () => {
		expect(loadAssistModel(directory())).toBe(DEFAULT_MODEL);
	});

	it("enables assistance by default, including for existing model-only preferences", () => {
		const dir = directory();
		expect(loadAssistEnabled(dir)).toBe(true);
		saveAssistModel(dir, "custom/fast-model");
		expect(loadAssistEnabled(dir)).toBe(true);
	});

	it("saves toggles and model changes without losing either preference", () => {
		const dir = directory();
		saveAssistModel(dir, "custom/first-model");
		saveAssistEnabled(dir, false);
		expect(loadAssistEnabled(dir)).toBe(false);
		expect(loadAssistModel(dir)).toBe("custom/first-model");
		saveAssistModel(dir, "custom/next-model");
		expect(loadAssistEnabled(dir)).toBe(false);
		expect(loadAssistModel(dir)).toBe("custom/next-model");
		saveAssistEnabled(dir, true);
		expect(loadAssistEnabled(dir)).toBe(true);
		expect(loadAssistModel(dir)).toBe("custom/next-model");
	});

	it("persists provider/model IDs, including model IDs containing slashes", () => {
		const dir = directory();
		saveAssistModel(dir, "custom/vendor/fast-model");
		expect(loadAssistModel(dir)).toBe("custom/vendor/fast-model");
		expect(JSON.parse(readFileSync(join(dir, "bluclawd", "prompt-assist.json"), "utf8"))).toEqual({
			model: "custom/vendor/fast-model",
		});
	});

	it("falls back to MiMo for corrupt or invalid preferences", () => {
		const dir = directory();
		saveAssistModel(dir, DEFAULT_MODEL);
		for (const value of [
			"not json",
			"null",
			"{}",
			'{"model":false}',
			'{"model":"missing-provider"}',
			'{"model":"/model"}',
		]) {
			writeFileSync(join(dir, "bluclawd", "prompt-assist.json"), value);
			expect(loadAssistModel(dir)).toBe(DEFAULT_MODEL);
			expect(loadAssistEnabled(dir)).toBe(true);
		}
	});
});
