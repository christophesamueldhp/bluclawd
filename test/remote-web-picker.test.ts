import { describe, expect, it } from "vitest";
import { modelGroups, pickerHtml } from "#remote-web/picker.js";

const models = [
	{ provider: "anthropic", id: "fable", name: "Claude Fable 5.1" },
	{ provider: "anthropic", id: "haiku" },
	{ provider: "openai-codex", id: "astra", name: "GPT-6 Astra" },
];

describe("a choice's sheet", () => {
	it("groups models by provider, valued as asked", () => {
		expect(modelGroups(models, (m) => `${m.provider}/${m.id}`)).toEqual([
			{
				label: "anthropic",
				options: [
					{ value: "anthropic/fable", label: "Claude Fable 5.1" },
					{ value: "anthropic/haiku", label: "haiku" },
				],
			},
			{ label: "openai-codex", options: [{ value: "openai-codex/astra", label: "GPT-6 Astra" }] },
		]);
		expect(modelGroups([], () => "")).toEqual([]);
	});

	it("checks the current value only, and escapes what it shows", () => {
		const html = pickerHtml({
			title: "Model",
			value: "1",
			groups: [
				{
					label: "<b>",
					options: [
						{ value: "0", label: "a&b" },
						{ value: "1", label: "Two" },
					],
				},
				{ options: [] },
			],
		});
		expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
		expect(html).toContain('aria-selected="true" data-value="1"><span>Two</span><svg');
		expect(html).toContain('<h3 class="group">&#60;b&#62;</h3>');
		expect(html).toContain("<span>a&#38;b</span>");
		// An empty group shows nothing.
		expect(html.match(/class="options"/g)).toHaveLength(1);
	});
});
