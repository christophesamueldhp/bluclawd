import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openRunInbox, postToRun, sealRunInbox, unsealRunInbox } from "../ext/subagents/run-mailbox.ts";
import { waitFor } from "./helpers/wait-for.ts";

const MAILBOX = fileURLToPath(new URL("../ext/subagents/run-mailbox.ts", import.meta.url));

describe("a run's inbox", () => {
	let runDir: string | undefined;
	afterEach(() => {
		if (runDir) rmSync(runDir, { recursive: true, force: true });
		runDir = undefined;
	});

	it("gives its seal every message another process posted before it, and refuses every one after", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bc-inbox-"));
		runDir = dir;
		openRunInbox(dir, 0);
		const poster = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { postToRun } from ${JSON.stringify(MAILBOX)};
				const ids = [];
				for (let i = 0; i < 400; i++) {
					const posted = postToRun(process.argv[1], 0, "m" + i);
					ids.push(posted.accepted ? posted.id : null);
				}
				process.stdout.write(JSON.stringify(ids));`,
				dir,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		let output = "";
		poster.stdout.on("data", (chunk) => {
			output += chunk;
		});
		const exited = new Promise((resolve) => poster.on("exit", resolve));
		await waitFor(() => expect(readdirSync(join(dir, "inbox", "0")).length).toBeGreaterThan(20));

		const sealed = sealRunInbox(dir, 0);
		await exited;
		const ids: (string | null)[] = JSON.parse(output);
		expect(ids.filter((id) => id === null).length).toBeGreaterThan(0);
		expect(sealed.map(({ id }) => id).sort()).toEqual(ids.filter((id) => id !== null).sort());
		// Nothing half posted is left behind by a refused message.
		expect(readdirSync(dir).filter((file) => file.endsWith(".inbox"))).toEqual([]);
	});

	it("takes messages again once unsealed, after those it held", () => {
		const dir = mkdtempSync(join(tmpdir(), "bc-inbox-"));
		runDir = dir;
		openRunInbox(dir, 1);
		postToRun(dir, 1, "first");
		expect(sealRunInbox(dir, 1).map(({ text }) => text)).toEqual(["first"]);
		expect(postToRun(dir, 1, "refused")).toEqual({ accepted: false });
		unsealRunInbox(dir, 1);
		expect(postToRun(dir, 1, "second").accepted).toBe(true);
		expect(sealRunInbox(dir, 1).map(({ text }) => text)).toEqual(["first", "second"]);
	});
});
