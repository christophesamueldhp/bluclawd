import { describe, expect, it } from "vitest";
import { type BatchMember, formatBatchAggregate } from "../ext/subagents/batches.ts";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";

/** A settled member named `name`: completed with a long Report, failed, or cancelled. */
function member(name: string, status: "completed" | "failed" | "cancelled"): BatchMember {
	const record = {
		runId: `sub_${name}`,
		name,
		generation: 0,
		status: status === "cancelled" ? "cancelled" : "closed",
		stopReason: status === "cancelled" ? "Stopped by its orchestrator" : undefined,
		reportPath: `/runs/${name}/report.md`,
	} as SubagentRunRecord;
	const outcome =
		status === "failed" ? { status: "failed" as const, error: "its model failed" } : { status: "completed" as const };
	return { record, report: { seq: 1, generation: 0, text: `${name}: ${"finding ".repeat(200)}`, outcome } };
}

describe("a settled batch's aggregate", () => {
	it("stays within its budget however many members, lists failures first, and says what it left out", () => {
		const members = Array.from({ length: 300 }, (_, i) =>
			member(`m${i}`, i === 250 ? "failed" : i === 299 ? "cancelled" : "completed"),
		);
		const { text, truncated } = formatBatchAggregate("batch_x", members, "/runs/batches/batch_x.md", 16 * 1024);

		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
		expect(truncated).toBe(true);
		expect(text).toContain("Batch batch_x: 300 tasks, 298 completed, 1 failed, 1 cancelled.");
		expect(text).toContain("Every member's status, full Report and transcript: /runs/batches/batch_x.md");
		expect(text).toContain('- "m250" (sub_m250): failed: its model failed');
		expect(text).toContain('- "m299" (sub_m299): cancelled: Stopped by its orchestrator');
		const listed = text.match(/^- "m\d+"/gm) ?? [];
		expect(listed.length).toBeLessThan(300);
		expect(text).toContain(`[${300 - listed.length} more not listed here: see the manifest.]`);
		const inlined = text.match(/^### "m\d+" \(sub_m\d+\): completed$/gm) ?? [];
		expect(inlined.length).toBeGreaterThan(0);
		expect(text).toContain(`[${298 - inlined.length} completed members' Reports not inlined: see the manifest.]`);
	});

	it("inlines every member and its whole Report when they fit", () => {
		const members = [member("a", "completed"), member("b", "failed")];
		const { text, truncated } = formatBatchAggregate("batch_y", members, "/m.md", 16 * 1024);

		expect(truncated).toBe(false);
		expect(text).toContain('- "a" (sub_a): completed\n- "b" (sub_b): failed: its model failed');
		expect(text).toContain(`### "a" (sub_a): completed\na: ${"finding ".repeat(200).trim()}`);
		expect(text).not.toContain("not inlined");
	});
	it("lists a long failure as one line, so it cannot crowd out the other statuses", () => {
		const failed = member("f", "failed");
		const error = `first line of the failure\n${"stderr noise ".repeat(2000)}`;
		const members = [
			{ ...failed, report: { ...failed.report!, outcome: { status: "failed" as const, error } } },
			member("a", "completed"),
		];
		const { text } = formatBatchAggregate("batch_z", members, "/m.md", 16 * 1024);

		expect(text).toContain('- "f" (sub_f): failed: first line of the failure […]\n- "a" (sub_a): completed');
		expect(text).not.toContain("stderr noise");
	});
});
