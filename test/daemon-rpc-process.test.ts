import { describe, expect, it } from "vitest";
import { buildRpcTailArgs } from "../daemon/rpc-process.ts";

describe("buildRpcTailArgs", () => {
	it("is empty when nothing is set", () => {
		expect(buildRpcTailArgs({})).toEqual([]);
	});

	it("appends --session to resume a session", () => {
		expect(buildRpcTailArgs({ sessionFile: "/s/x.jsonl" })).toEqual(["--session", "/s/x.jsonl"]);
	});

	it("pins the model at startup via --provider/--model", () => {
		expect(buildRpcTailArgs({ provider: "anthropic", model: "claude-opus-4-8" })).toEqual([
			"--provider",
			"anthropic",
			"--model",
			"claude-opus-4-8",
		]);
	});

	it("combines resume and model", () => {
		expect(buildRpcTailArgs({ sessionFile: "/s/x.jsonl", provider: "anthropic", model: "claude-opus-4-8" })).toEqual([
			"--session",
			"/s/x.jsonl",
			"--provider",
			"anthropic",
			"--model",
			"claude-opus-4-8",
		]);
	});
});
