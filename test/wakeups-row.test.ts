import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { rowFromSummary, stateBandOf } from "../daemon/rows.ts";
import { WAKEUP_ENTRY, type WakeupRecord } from "../ext/background-bash/wakeups.ts";
import { DEFAULT_EXTENSIONS, type FauxStep, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The wake-ups a session file records scheduled, earliest first. */
function scheduledWakeups(sessionFile: string): WakeupRecord[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; customType?: string; data?: WakeupRecord })
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === WAKEUP_ENTRY && entry.data ? [entry.data] : [],
		)
		.sort((a, b) => a.dueAt - b.dueAt);
}

describe.skipIf(!hasTmux)("a session's row with wake-ups pending", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it("is Idle and shows when it next wakes, the next one once the earliest is cancelled, and none once none is pending", async () => {
		const real = await startRealPi({
			extensions: [...DEFAULT_EXTENSIONS, "background-bash"],
			defaultTools: ["+schedule_wakeup"],
		});
		pi = real;
		const steps: FauxStep[] = [
			{ tool: "schedule_wakeup", args: { prompt: "Check CI later.", delay: 1200 } },
			{ tool: "schedule_wakeup", args: { prompt: "Check CI.", delay: 600 } },
			{ text: "scheduled" },
		];
		real.script("main", steps);
		const pane = real.start(["--", "watch CI"]);
		await real.waitForRequests("main", 3);
		const row = async () => {
			const summary = (await real.rows()).find((instance) => instance.pane === pane);
			if (!summary) throw new Error("The pane is not listed.");
			return { summary, row: rowFromSummary(summary, undefined) };
		};
		const sessionFile = await waitFor(async () => {
			const file = (await row()).summary.sessionFile;
			if (!file) throw new Error("Its row has no session file yet.");
			return file;
		});
		const [earliest, later] = await waitFor(() => {
			const records = scheduledWakeups(sessionFile);
			expect(records).toHaveLength(2);
			return records;
		});

		await waitFor(async () => {
			const listed = await row();
			expect(listed.summary.activity).toBe("idle");
			expect(stateBandOf(listed.row)).toBe("idle");
			expect(listed.row.wakesAt).toBe(earliest.dueAt);
		});

		/** Has the agent cancel wake-up `id` in a turn of its own. */
		const cancel = async (id: string) => {
			steps.push({ tool: "task_stop", args: { task_id: id } }, { text: "cancelled" });
			real.script("main", steps);
			await real.client.send(pane, { type: "prompt", text: `cancel ${id}` });
			await real.waitForRequests("main", steps.length);
		};

		await cancel(earliest.id);
		await waitFor(async () => {
			const listed = await row();
			expect(stateBandOf(listed.row)).toBe("idle");
			expect(listed.row.wakesAt).toBe(later.dueAt);
		});

		await cancel(later.id);
		await waitFor(async () => {
			const listed = await row();
			expect(stateBandOf(listed.row)).toBe("idle");
			expect(listed.row.wakesAt).toBeUndefined();
			expect(listed.row.detail).toBe("cancelled");
		});
	});
});
