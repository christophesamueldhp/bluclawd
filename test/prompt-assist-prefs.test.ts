import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, loadAssistModel, saveAssistModel } from "../ext/prompt-assist/prefs.ts";

const directory = () => mkdtempSync(join(tmpdir(), "prompt-assist-"));

describe("prompt assist preferences", () => {
	it("defaults to MiMo without configuration", () => {
		expect(loadAssistModel(directory())).toBe(DEFAULT_MODEL);
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
		}
	});
});
