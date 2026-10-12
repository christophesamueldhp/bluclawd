import { describe, expect, it, vi } from "vitest";
import { applyPaneMessage, buildReport } from "../ext/remote/report.ts";

const model = (provider: string, id: string, name?: string, reasoning = false) => ({ provider, id, name, reasoning });

function fakes(options: { current?: ReturnType<typeof model>; available?: ReturnType<typeof model>[] } = {}) {
	const available = options.available ?? [];
	const ctx = {
		model: options.current,
		modelRegistry: {
			getAvailable: () => available,
			find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id),
		},
		getContextUsage: () => ({ tokens: 12_000, contextWindow: 200_000, percent: 6 }),
		sessionManager: {
			getEntries: () => [
				{ type: "message", message: { role: "user", content: "hi" } },
				{
					type: "message",
					message: { role: "assistant", usage: { input: 100, output: 20, cost: { total: 0.5 } } },
				},
				{ type: "model_change" },
				{
					type: "message",
					message: { role: "assistant", usage: { input: 50, output: 5, cost: { total: 0.25 } } },
				},
			],
		},
		compact: vi.fn(),
	};
	const pi = { getThinkingLevel: () => "high", setModel: vi.fn(async () => true) };
	return { ctx, pi };
}

describe("buildReport", () => {
	it("reports the model, the models to pick from, thinking, context and session usage", () => {
		const opus = model("anthropic", "claude-opus", "Opus", true);
		const { ctx, pi } = fakes({
			current: opus,
			available: [
				model("openai", "gpt-5", "GPT-5"),
				model("anthropic", "claude-sonnet", "Sonnet"),
				opus,
				model("anthropic", "claude-sonnet", "Sonnet"),
			],
		});
		expect(buildReport(ctx as never, pi as never)).toEqual({
			model: { provider: "anthropic", id: "claude-opus", name: "Opus" },
			models: [
				{ provider: "anthropic", id: "claude-opus", name: "Opus" },
				{ provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
				{ provider: "openai", id: "gpt-5", name: "GPT-5" },
			],
			thinkingLevel: "high",
			context: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
			usage: { input: 150, output: 25, cost: 0.75 },
		});
	});

	it("lists the current model even when it is not available, and no thinking for a model without it", () => {
		const { ctx, pi } = fakes({ current: model("local", "llama") });
		const report = buildReport(ctx as never, pi as never);
		expect(report.models).toEqual([{ provider: "local", id: "llama" }]);
		expect(report.thinkingLevel).toBeUndefined();
	});

	it("has no model before one is selected", () => {
		const { ctx, pi } = fakes();
		const report = buildReport(ctx as never, pi as never);
		expect(report.model).toBeUndefined();
		expect(report.models).toEqual([]);
	});
});

describe("applyPaneMessage", () => {
	it("switches to a model the registry knows, and ignores one it does not", () => {
		const sonnet = model("anthropic", "claude-sonnet", "Sonnet");
		const { ctx, pi } = fakes({ available: [sonnet] });
		applyPaneMessage({ type: "set_model", provider: "anthropic", id: "claude-sonnet" }, ctx as never, pi as never);
		expect(pi.setModel).toHaveBeenCalledWith(sonnet);
		applyPaneMessage({ type: "set_model", provider: "anthropic", id: "nope" }, ctx as never, pi as never);
		expect(pi.setModel).toHaveBeenCalledTimes(1);
	});

	it("compacts", () => {
		const { ctx, pi } = fakes();
		applyPaneMessage({ type: "compact" }, ctx as never, pi as never);
		expect(ctx.compact).toHaveBeenCalled();
	});

	it("ignores messages it does not handle", () => {
		const { ctx, pi } = fakes();
		applyPaneMessage({ type: "clone" }, ctx as never, pi as never);
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
	});
});
