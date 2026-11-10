// Exercise a normal Git-package install and typed commands on an independently installed stock pi.
// Usage: node scripts/verify-accounts-package.ts /absolute/path/to/@earendil-works/pi-coding-agent
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { AccountsTerminal } from "../test/helpers/accounts-terminal.ts";
import { readinessMs } from "../test/helpers/heartbeats.ts";
import { piHost } from "../test/helpers/pi-host.ts";

const hostArgument = process.argv[2];
if (!hostArgument) throw new Error("Pass the package directory of an independently installed stock pi.");
const host = resolve(hostArgument);
// A mixed install is refused here: its result would not be evidence for any one pi version.
const hostSet = piHost(host);
const pi: typeof import("@earendil-works/pi-coding-agent") = await import(
	pathToFileURL(join(host, "dist/index.js")).href
);
const aiManifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(host, "package.json")));
if (!aiManifest) throw new Error("Cannot locate the stock host's pi-ai package.");
const ai: typeof import("@earendil-works/pi-ai") = await import(
	pathToFileURL(join(dirname(aiManifest), "dist/index.js")).href
);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "bluclawd-package-check-"));
const source = join(directory, "source");
const agentDir = join(directory, "agent");
const cwd = join(directory, "project");
const execute = promisify(execFile);
const gitUrl = "https://fixture.invalid/bluclawd/package";
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: agentDir,
	PI_SERVER_DIR: join(directory, "server"),
	PI_OFFLINE: "1",
	npm_config_cache: join(directory, "npm-cache"),
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: `url.${pathToFileURL(source).href}.insteadOf`,
	GIT_CONFIG_VALUE_0: gitUrl,
};
const run = async (command: string, args: string[], workdir = cwd) => {
	try {
		return await execute(command, args, { cwd: workdir, env, timeout: readinessMs * 6, maxBuffer: 4 * 1024 * 1024 });
	} catch (error) {
		// This fixture contains no real credentials; preserve install diagnostics on failure.
		console.error(error);
		throw error;
	}
};
let mode: InstanceType<typeof pi.InteractiveMode> | undefined;
let runtime: Awaited<ReturnType<typeof pi.createAgentSessionRuntime>> | undefined;
try {
	await mkdir(source);
	await mkdir(cwd);
	await mkdir(agentDir);
	await mkdir(join(agentDir, "bluclawd"));
	await writeFile(join(agentDir, "bluclawd/prompt-assist.json"), JSON.stringify({ enabled: false }));
	const files = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)).stdout
		.split("\0")
		.filter(Boolean);
	for (const file of files) {
		await mkdir(dirname(join(source, file)), { recursive: true });
		await cp(join(root, file), join(source, file));
	}
	await run("git", ["init", "--quiet"], source);
	await run("git", ["add", "."], source);
	await run(
		"git",
		[
			"-c",
			"user.name=Package fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"-m",
			"Package fixture",
		],
		source,
	);
	const cli = join(host, "dist/bundle/cli.js");
	await run(process.execPath, [cli, "install", `git:${gitUrl}`]);
	const cliLoad = await run(process.execPath, [cli, "--list-models"]);
	assert(!`${cliLoad.stdout}\n${cliLoad.stderr}`.includes("Failed to load extension"), cliLoad.stderr);
	const installed = join(agentDir, "git", "fixture.invalid", "bluclawd", "package");
	await assert.rejects(readFile(join(installed, "node_modules/typescript/package.json")));
	await assert.rejects(readFile(join(installed, "node_modules/@earendil-works/pi-coding-agent/package.json")));
	const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
	console.log(`Installed Git package with ${manifest.pi.extensions.length} extensions; no local pi or TypeScript.`);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_SERVER_DIR = env.PI_SERVER_DIR;
	process.env.PI_OFFLINE = "1";
	await writeFile(
		join(agentDir, "auth.json"),
		JSON.stringify({ "fixture-package": { type: "api_key", key: "fake-only" } }),
		{ mode: 0o600 },
	);
	const settings = pi.SettingsManager.create(cwd, agentDir);
	const loader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	for (const file of manifest.pi.extensions)
		assert(
			loaded.extensions.some((extension) => extension.path === resolve(installed, file)),
			`Not loaded: ${file}`,
		);
	// All extensions loaded above. Limit the interactive smoke to Accounts through pi's
	// supported package filter: agent view otherwise hands the terminal to its tmux launcher.
	settings.setPackages([{ source: `git:${gitUrl}`, extensions: ["ext/accounts/index.ts"], themes: [] }]);
	const modelRuntime = await pi.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
	const faux = ai.fauxProvider({
		provider: "fixture-package",
		models: [
			{ id: "one", name: "Package One" },
			{ id: "two", name: "Package Two" },
		],
	});
	modelRuntime.registerNativeProvider({
		...faux.provider,
		name: "Package Fixture",
		auth: {
			apiKey: {
				name: "Fixture key",
				check: async ({ credential }) => (credential?.key ? { type: "api_key" } : undefined),
				resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
			},
		},
	});
	await modelRuntime.refresh({ allowNetwork: false });
	runtime = await pi.createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await pi.createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager: settings,
				resourceLoaderOptions: { noContextFiles: true },
			});
			assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
			return {
				...(await pi.createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
					scopedModels: [{ model: faux.getModel() }],
					noTools: "builtin",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd, agentDir, sessionManager: pi.SessionManager.create(cwd, join(agentDir, "sessions")) },
	);
	const terminal = new AccountsTerminal();
	mode = new pi.InteractiveMode(runtime, { terminal, tuiMode: "regular", initialThemeSetting: "dark" });
	await mode.init();
	let runError: unknown;
	void mode.run().catch((error: unknown) => {
		runError = error;
	});
	const shown = async (text: string, present = true) => {
		const deadline = Date.now() + readinessMs;
		while (terminal.screen.includes(text) !== present) {
			if (runError) throw runError;
			assert(Date.now() < deadline, `Expected ${present ? "" : "absence of "}${text}\n${terminal.screen}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};
	const command = (text: string) => {
		terminal.send(text);
		terminal.send("\r");
	};
	const close = async (text: string) => {
		terminal.send("\x1b");
		await shown(text, false);
	};
	const defaults = await readFile(join(agentDir, "settings.json"), "utf8");
	const scopeSnapshot = () =>
		runtime?.session.scopedModels.map(({ model, thinkingLevel }) => ({
			provider: model.provider,
			id: model.id,
			thinkingLevel,
		}));
	const scope = scopeSnapshot();
	for (const [route, title] of [
		["/accounts", "[Accounts]"],
		["/accounts --models", "View: All"],
		["/accounts --scoped", "View: Scoped"],
		["/accounts fixture-package", "Package Fixture accounts"],
	]) {
		command(route);
		await shown(title);
		await close(title);
		// Provider Back returns to the shared chooser.
		if (route === "/accounts fixture-package") {
			await shown("[Accounts]");
			await close("[Accounts]");
		}
	}
	command("/accounts --models");
	await shown("Package Two (two)");
	terminal.send("two");
	await shown("› Package Two");
	terminal.send("\r");
	await shown("Accounts  [Models]", false);
	assert.equal(runtime.session.model?.id, "two");
	for (const [route, title] of [
		["/login", "Select authentication method:"],
		["/model", "Scope: all | scoped"],
		["/scoped-models", "Model Configuration"],
	]) {
		command(route);
		await shown(title);
		assert(!terminal.screen.includes("[Accounts]") && !terminal.screen.includes("[Models]"));
		await close(title);
	}
	terminal.send("\x0c");
	await shown("Scope: all | scoped");
	await close("Scope: all | scoped");
	assert.deepEqual(scopeSnapshot(), scope);
	assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), defaults);
	console.log(
		`PASS: stock pi ${pi.VERSION} (${Object.keys(hostSet.siblings).length} @earendil-works packages, all ${hostSet.version}); full package loaded, four Accounts routes, explicit model selection, native commands and Ctrl+L, unchanged scope/settings.`,
	);
} finally {
	mode?.stop();
	await runtime?.dispose();
	await rm(directory, { recursive: true, force: true });
}
