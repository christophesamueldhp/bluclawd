import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	discoverAndLoadExtensions,
	type ExtensionCommandContext,
	getPackageDir,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("loads accounts through Pi from a Git-package layout without local node_modules", async () => {
	const directory = mkdtempSync(join(tmpdir(), "bluclawd-accounts-loading-"));
	directories.push(directory);
	for (const name of ["accounts", "_shared"]) {
		cpSync(new URL(`../ext/${name}`, import.meta.url), join(directory, "ext", name), { recursive: true });
	}
	const agentDir = join(directory, "agent");
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	expect(existsSync(join(directory, "node_modules"))).toBe(false);
	const extensionPath = join(directory, "ext/accounts/index.ts");
	const hostPackageDir = process.env.PI_TEST_HOST_PACKAGE_DIR ?? getPackageDir();
	const cli = await promisify(execFile)(
		process.execPath,
		[join(hostPackageDir, "dist/bundle/cli.js"), "-e", extensionPath, "--list-models"],
		{
			cwd: directory,
			env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir },
		},
	);
	expect(`${cli.stdout}\n${cli.stderr}`).not.toContain("Failed to load extension");
	const loaded = await discoverAndLoadExtensions([extensionPath], directory, agentDir);
	expect(loaded.errors).toEqual([]);
	const command = loaded.extensions[0]?.commands.get("accounts");
	expect(command).toBeDefined();
	if (!command) throw new Error("Accounts command was not registered");
	const select = vi.fn(async () => "Back");
	const notify = vi.fn();
	await command.handler("fixture", {
		hasUI: true,
		isIdle: () => true,
		ui: { select, notify },
		modelRegistry: {
			getAll: () => [],
			getRegisteredProviderIds: () => ["fixture"],
			getProvider: (id: string) => (id === "fixture" ? { id, name: "Fixture", auth: {} } : undefined),
		},
	} as unknown as ExtensionCommandContext);
	expect(select).toHaveBeenCalledWith("Fixture accounts (no saved accounts)", expect.any(Array));
	expect(notify).not.toHaveBeenCalled();
	expect(existsSync(join(agentDir, "auth.json"))).toBe(true);
});
