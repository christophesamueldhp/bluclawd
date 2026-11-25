import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeHelperPath } from "../daemon/run-members.ts";
import { agentDirs, parseSandbox, runtimeConfig } from "../ext/sandbox/config.ts";
import { sandboxStatus, setSandboxEngine, startSandbox, stopSandbox, wrapExec } from "../ext/sandbox/runtime.ts";

const supported =
	(process.platform === "darwin" || process.platform === "linux") &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

const SETTINGS = '{"sandbox":{"enabled":true}}\n';
/** `.pi` links to the next name, and so on; the last name the layout reaches is the real directory. */
const CHAIN = [".pi", "dotfiles/pi", "elsewhere/pi"];

describe.skipIf(!supported).each([
	["no symlink", 0],
	["a symlink", 1],
	["two symlinks", 2],
])("the sandbox, started in a directory that holds pi's agent directory through %s", (_, links) => {
	let home: string;
	let agentDir: string;
	// srt on Linux binds a deny path by its real path, which leaves each symlink on the way swappable.
	const refused = process.platform === "linux" && links > 0;
	const agentDirBefore = process.env.PI_CODING_AGENT_DIR;
	const exec = wrapExec(
		(command, cwd, options) => createLocalBashOperations().exec(command, cwd, options),
		() => undefined,
	);

	async function run(command: string): Promise<number | null> {
		const { exitCode } = await exec(command, home, { onData: () => {} });
		return exitCode;
	}

	beforeAll(async () => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-sandbox-home-")));
		agentDir = join(home, ".pi", "agent");
		const chain = CHAIN.slice(0, links).map((path) => join(home, path));
		const realPi = join(home, CHAIN[links] ?? "");
		mkdirSync(join(realPi, "agent", "bluclawd", "reaper"), { recursive: true });
		chain.forEach((link, i) => {
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(join(home, CHAIN[i + 1] ?? ""), link);
		});
		writeFileSync(join(agentDir, "settings.json"), SETTINGS);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		setSandboxEngine(undefined);
		const setting = parseSandbox({ enabled: true, filesystem: { allowWrite: ["~"] } });
		if (setting.kind !== "on") throw new Error(setting.kind);
		const config = runtimeConfig(setting.settings, [], home, home, tmpdir(), [], agentDirs());
		const status = await startSandbox(config, async () => false);
		expect(status.kind).toBe(refused ? "unavailable" : "ready");
	}, 60_000);

	afterAll(async () => {
		await stopSandbox();
		if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
		rmSync(home, { recursive: true, force: true });
	});

	it.runIf(refused).each(CHAIN.slice(0, links))("refuses to start on Linux, naming the symlink %s", (link) => {
		const status = sandboxStatus();
		expect(status.kind === "unavailable" && status.reason).toContain(join(home, link));
	});

	it.runIf(refused)("refuses every command on Linux", async () => {
		await expect(run("true")).rejects.toThrow("The sandbox is on but cannot run");
	});

	it.skipIf(refused)("cannot rewrite pi's settings", async () => {
		const settings = join(agentDir, "settings.json");
		expect(await run(`echo '{"sandbox":{"enabled":false}}' > ${settings}`)).not.toBe(0);
		expect(readFileSync(settings, "utf8")).toBe(SETTINGS);
	});

	it.skipIf(refused)("cannot plant a reaper helper, which runs outside the sandbox", async () => {
		const helper = nativeHelperPath("reaper", agentDir).path;
		expect(await run(`printf '#!/bin/sh\\n' > ${helper}`)).not.toBe(0);
		expect(existsSync(helper) ? readFileSync(helper, "utf8") : "").not.toBe("#!/bin/sh\n");
	});

	async function replace(moved: string, made: string): Promise<void> {
		await run(
			`mv ${moved} moved-${moved.replaceAll("/", "-")}; mkdir -p ${made} && echo '{"sandbox":{"enabled":false}}' > ${made}/settings.json`,
		);
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(SETTINGS);
	}

	it.skipIf(refused)("cannot move the agent directory aside and make its own", () =>
		replace(".pi/agent", ".pi/agent"),
	);

	it.skipIf(refused).each(
		CHAIN.slice(0, links)
			.reverse()
			.map((link) => [link, `${link}/agent`]),
	)("cannot swap the symlink %s for a directory and make %s its own", replace);
});
