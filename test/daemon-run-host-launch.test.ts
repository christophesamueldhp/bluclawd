import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunHostLaunch } from "../daemon/run-queue.ts";
import { hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

const RUN_ID = "sub_00000000-0000-4000-8000-000000000000";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasTmux)("the daemon's launch of a run's host", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	/** A granted run of this test's orchestrator, with its directory. */
	async function grantedRun(real: RealPi, generation = 0) {
		const runDir = join(real.agentDir, "bluclawd", "subagents", "session", RUN_ID);
		mkdirSync(runDir, { recursive: true });
		const run = `${RUN_ID}/${generation}`;
		expect(await real.client.claimRun(run, "session", new AbortController().signal)).toBe(true);
		return { run, runDir };
	}

	it("starts its own run host in the run's directory, whatever program, directory or helper a client names", async () => {
		const real = await startRealPi();
		pi = real;
		const { run, runDir } = await grantedRun(real);
		const touched = join(real.cwd, "touched");
		const helper = join(real.cwd, "helper.sh");
		writeFileSync(helper, `#!/bin/sh\ntouch ${join(real.cwd, "helped")}\n`);
		chmodSync(helper, 0o755);
		// What a client of the daemon's socket could send: its own program, directory and helper.
		const host = {
			runDir,
			env: { PATH: process.env.PATH ?? "" },
			command: ["/bin/sh", "-c", `touch ${touched}`],
			cwd: real.cwd,
			contained: { helper, marker: `bluclawd.run.${RUN_ID}` },
		};
		await real.client.launchRun(run, host as unknown as RunHostLaunch);

		// The host finds no spec in the run's directory, says so there, and ends; nothing of the client's ran.
		await waitFor(() => expect(readFileSync(join(runDir, "rpc-host.error"), "utf8")).toMatch(/rpc-spec\.json/));
		await sleep(2000);
		expect(existsSync(touched)).toBe(false);
		expect(existsSync(join(real.cwd, "helped"))).toBe(false);
	});

	it("starts nothing but pi for a run, whatever program its spec names", async () => {
		const real = await startRealPi();
		pi = real;
		const { run, runDir } = await grantedRun(real);
		const touched = join(real.cwd, "touched");
		writeFileSync(
			join(runDir, "rpc-spec.json"),
			JSON.stringify({
				command: ["/bin/sh", "-c", `touch ${touched}`],
				cwd: real.cwd,
				agentDir: real.agentDir,
				prompt: "Hello.",
				model: { provider: "faux", id: "faux-1", thinkingLevel: "off" },
				generation: 0,
			}),
		);
		await real.client.launchRun(run, {
			runDir,
			env: { PATH: process.env.PATH ?? "" },
			// As a client built before the daemon chose the program.
			...{ command: [process.execPath, join(import.meta.dirname, "../ext/subagents/rpc-host.ts"), runDir] },
			cwd: runDir,
		} as RunHostLaunch);

		await waitFor(() => expect(readFileSync(join(runDir, "rpc-host.error"), "utf8")).toMatch(/not a run's spec/));
		await sleep(1000);
		expect(existsSync(touched)).toBe(false);
	});
});
