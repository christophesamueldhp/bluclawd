import { describe, expect, it } from "vitest";
import { checkSources, relevantPassages, renderVerdicts } from "../ext/web/source-check.ts";
import type { StoredContent } from "../ext/web/store.ts";

const source = (id: string, text: string): StoredContent => ({
	id,
	kind: "fetch",
	source: `https://${id}.example/`,
	text,
	createdAt: 0,
});

const docs = [
	source(
		"f1",
		"Intro line\nTypeScript 7 ships a native compiler written in Go.\nIt is about ten times faster on full builds.\nOther text",
	),
	source("f2", "Unrelated page about gardening.\nTomatoes like sun."),
];

describe("source_check", () => {
	it("picks the passages that share words with a claim", () => {
		const passages = relevantPassages("TypeScript 7 compiler is written in Go", docs);
		expect(passages[0].id).toBe("f1");
		expect(passages.some((p) => p.id === "f2")).toBe(false);
	});

	it("keeps verdicts whose quote is really in the source and downgrades invented ones", async () => {
		let prompt = "";
		const complete = async (_system: string, user: string) => {
			prompt = user;
			return [
				'{"claim": 0, "status": "supported", "source": "f1", "quote": "TypeScript 7 ships a native  compiler written in Go.", "note": "stated directly"}',
				'{"claim": 1, "status": "supported", "source": "f1", "quote": "It is a hundred times faster.", "note": "made up"}',
				'{"claim": 2, "status": "missing-evidence", "note": "nothing on this"}',
			].join("\n");
		};
		const out = await checkSources(
			[
				"The TypeScript 7 compiler is written in Go",
				"TypeScript 7 is a hundred times faster",
				"Bun ships TypeScript 8",
			],
			docs,
			complete,
		);
		expect(prompt).toContain('<passage source="f1">');
		expect(out?.verdicts.map((v) => v.status)).toEqual(["supported", "unclear", "missing-evidence"]);
		expect(out?.verdicts[0].url).toBe("https://f1.example/");
		expect(out?.verdicts[1].note).toMatch(/not in the source/);
		expect(out?.digests[0].sha256).toMatch(/^[0-9a-f]{64}$/);
		const text = renderVerdicts(out!.verdicts, out!.digests);
		expect(text).toContain("1. **supported**: The TypeScript 7 compiler is written in Go");
		expect(text).toContain("Sources checked:\n- f1 https://f1.example/ sha256:");
	});

	it("marks a claim the model skipped as unclear, and returns undefined with no model", async () => {
		const out = await checkSources(["a claim"], docs, async () => "no json here");
		expect(out?.verdicts[0]).toMatchObject({ status: "unclear" });
		expect(await checkSources(["a claim"], docs, async () => undefined)).toBeUndefined();
	});
});
