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

	it("gives its seal every message other processes posted before it, and refuses every one after", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bc-inbox-"));
		runDir = dir;
		// Several posters against many seals: a post in flight across a seal is rare, so one seal rarely meets one.
		const generations = 100;
		const posters = Array.from({ length: 4 }, () => {
			const poster = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import { existsSync } from "node:fs";
					import { join } from "node:path";
					import { postToRun } from ${JSON.stringify(MAILBOX)};
					const [dir, generations] = [process.argv[1], Number(process.argv[2])];
					const posted = [];
					for (let generation = 0; generation < generations; generation++) {
						const inbox = join(dir, "inbox", String(generation));
						while (!existsSync(inbox) && !existsSync(inbox + ".sealed")) {}
						// Posts until refused: its last post is always one after the seal.
						for (;;) {
							const sent = postToRun(dir, generation, "m");
							posted.push(sent.accepted ? sent.id : null);
							if (!sent.accepted) break;
						}
					}
					process.stdout.write(JSON.stringify(posted));`,
					dir,
					String(generations),
				],
				{ stdio: ["ignore", "pipe", "inherit"] },
			);
			let output = "";
			poster.stdout.on("data", (chunk) => {
				output += chunk;
			});
			return new Promise<(string | null)[]>((resolve) => poster.on("exit", () => resolve(JSON.parse(output))));
		});

		const sealed: string[] = [];
		for (let generation = 0; generation < generations; generation++) {
			openRunInbox(dir, generation);
			const inbox = join(dir, "inbox", String(generation));
			if (generation === 0) await waitFor(() => expect(readdirSync(inbox).length).toBeGreaterThan(20));
			else while (readdirSync(inbox).length < 4) {}
			sealed.push(...sealRunInbox(dir, generation).map(({ id }) => id));
		}
		const ids = (await Promise.all(posters)).flat();
		expect(ids.filter((id) => id === null).length).toBe(4 * generations);
		expect(sealed.sort()).toEqual(ids.filter((id) => id !== null).sort());
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
