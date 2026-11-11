import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openRunInbox, postToRun, sealRunInbox, unsealRunInbox } from "../ext/subagents/run-mailbox.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import { waitFor } from "./helpers/wait-for.ts";

const MAILBOX = fileURLToPath(new URL("../ext/subagents/run-mailbox.ts", import.meta.url));

describe("a run's inbox", () => {
	let runDir: string | undefined;
	let children: ChildProcess[] = [];
	afterEach(() => {
		for (const child of children) child.kill("SIGKILL");
		children = [];
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
						while (!existsSync(inbox) && !existsSync(inbox + ".sealed")) if (!existsSync(dir)) process.exit(1);
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
			children.push(poster);
			let output = "";
			poster.stdout.on("data", (chunk) => {
				output += chunk;
			});
			return new Promise<string>((resolve) => poster.on("exit", () => resolve(output)));
		});

		const sealed: string[] = [];
		for (let generation = 0; generation < generations; generation++) {
			openRunInbox(dir, generation);
			const inbox = join(dir, "inbox", String(generation));
			if (generation === 0) await waitFor(() => expect(readdirSync(inbox).length).toBeGreaterThan(20));
			else {
				const deadline = Date.now() + readinessMs;
				while (readdirSync(inbox).length < 4)
					if (Date.now() > deadline) throw new Error("the posters stopped posting");
			}
			sealed.push(...sealRunInbox(dir, generation).map(({ id }) => id));
		}
		const ids: (string | null)[] = (await Promise.all(posters)).flatMap((output) => JSON.parse(output));
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

	it("takes a message relayed again, by its key, once, in the order it first landed", () => {
		const dir = mkdtempSync(join(tmpdir(), "bc-inbox-"));
		runDir = dir;
		openRunInbox(dir, 1);
		const first = postToRun(dir, 1, "Finding.", "sub_a/0/1");
		postToRun(dir, 1, "From the user.");
		expect(postToRun(dir, 1, "Finding.", "sub_a/0/1")).toEqual(first);
		expect(sealRunInbox(dir, 1).map(({ text }) => text)).toEqual(["Finding.", "From the user."]);
		// Sealed, it still holds what landed before.
		expect(postToRun(dir, 1, "Finding.", "sub_a/0/1")).toEqual(first);
		expect(postToRun(dir, 1, "Later.", "sub_a/0/2")).toEqual({ accepted: false });
	});
});
