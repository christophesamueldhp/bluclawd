import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BackgroundExec, BackgroundJobRegistry, jobOutcome } from "../ext/_shared/background-bash.ts";
import { taskExitSummary } from "../ext/_shared/monitor-events.ts";
import {
	deliverOrHold,
	heldNotifications,
	heldNotificationsLine,
	holdNotifications,
} from "../ext/_shared/notification-hold.ts";

describe("updates wait while the tasks panel is open (Claude Code 2.1.278)", () => {
	it("delivers at once without a hold, and on release with one", () => {
		const sent: string[] = [];
		deliverOrHold(() => sent.push("a"));
		expect(sent).toEqual(["a"]);
		const release = holdNotifications();
		deliverOrHold(() => sent.push("b"));
		deliverOrHold(() => sent.push("c"));
		expect(sent).toEqual(["a"]);
		expect(heldNotificationsLine(heldNotifications())).toBe(
			"2 background task updates waiting while this panel is open",
		);
		release();
		release();
		expect(sent).toEqual(["a", "b", "c"]);
		expect(heldNotifications()).toBe(0);
	});

	it("names a single update in the singular, and nothing when none waits", () => {
		expect(heldNotificationsLine(1)).toBe("Background task update waiting while this panel is open");
		expect(heldNotificationsLine(0)).toBeUndefined();
	});
});

describe("the 5 GB output cap", () => {
	it("stops writing past the cap, marks the file, and ends the job with 137", async () => {
		const root = mkdtempSync(join(tmpdir(), "bb-cap-"));
		try {
			const registry = new BackgroundJobRegistry({ outputRoot: root, maxFileBytes: 8 });
			const exec: BackgroundExec = (_c, _w, { onData, signal }) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
					onData(Buffer.from("12345"));
					onData(Buffer.from("67890"));
				});
			let done!: () => void;
			const exited = new Promise<void>((r) => {
				done = r;
			});
			const job = registry.start({ command: "yes", cwd: "/", exec, onExit: () => done() });
			await exited;
			await new Promise((r) => setTimeout(r, 20));
			const ended = registry.get(job.id)!;
			expect(ended.exit?.code).toBe(137);
			expect(jobOutcome(ended).state).toBe("failed");
			expect(taskExitSummary(ended)).toBe('Background command "yes" failed with exit code 137');
			expect(readFileSync(job.outputFile!, "utf-8")).toBe(
				"12345\n[output truncated: exceeded 5GB disk cap]\n\n[exited with code 137]\n",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
