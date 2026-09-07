import { describe, expect, it } from "vitest";
import type { BackgroundExec } from "../ext/_shared/background-bash.ts";

type Registry = typeof import("../ext/_shared/background-bash.ts");

/** Two separately-loaded copies of the module, as pi's loader gives two top-level extensions. */
async function twoCopies(): Promise<[Registry, Registry]> {
	const path = new URL("../ext/_shared/background-bash.ts", import.meta.url).pathname;
	const a = (await import(`${path}?copy=a`)) as Registry;
	const b = (await import(`${path}?copy=b`)) as Registry;
	expect(a.BackgroundJobRegistry).not.toBe(b.BackgroundJobRegistry);
	return [a, b];
}

/** An exec that never produces output and resolves when `finish` is called. */
function pendingExec(): { exec: BackgroundExec; finish: (code: number) => void } {
	let resolve!: (r: { exitCode: number | null }) => void;
	const done = new Promise<{ exitCode: number | null }>((r) => {
		resolve = r;
	});
	return { exec: () => done, finish: (code) => resolve({ exitCode: code }) };
}

describe("backgroundBashJobs across module copies", () => {
	it("is the same registry in both copies", async () => {
		const [a, b] = await twoCopies();
		const { exec } = pendingExec();
		const job = a.backgroundBashJobs.start({ command: "sleep 1", cwd: "/", exec });
		expect(b.backgroundBashJobs.get(job.id)?.command).toBe("sleep 1");
	});
});
