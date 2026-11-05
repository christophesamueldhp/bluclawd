import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Provider } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { PANE_ENV, Tmux } from "../daemon/tmux.ts";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import accounts from "../ext/accounts/index.ts";
import { AccountStore } from "../ext/accounts/store.ts";
import { createSubagentsExtension } from "../ext/subagents/index.ts";
import { AccountsTerminal } from "./helpers/accounts-terminal.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import { waitFor } from "./helpers/wait-for.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
});

async function fixture(
	options: {
		unavailableAlpha?: boolean;
		unavailableBeta?: boolean;
		oauth?: boolean;
		refreshFails?: boolean;
		background?: boolean;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "accounts-interactive-"));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("PI_OFFLINE", "1");
	const store = new AccountStore(directory);
	const personal = await store.add("fixture-alpha", "Personal", { type: "api_key", key: "fixture-original" });
	await store.switchTo(personal.id);
	const work = await store.add("fixture-beta", "Work", { type: "api_key", key: "fixture-beta" });
	await store.switchTo(work.id);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: join(directory, "models.json"),
		modelsStorePath: join(directory, "models-store.json"),
		allowModelNetwork: false,
	});
	const alpha = fauxProvider({
		provider: "fixture-alpha",
		models: [
			{ id: "alpha-main", name: "Alpha Main" },
			{ id: "alpha-extra", name: "Alpha Extra" },
		],
	});
	const beta = fauxProvider({ provider: "fixture-beta", models: [{ id: "beta-main", name: "Beta Main" }] });
	const gamma = fauxProvider({ provider: "fixture-gamma", models: [{ id: "gamma-main", name: "Gamma Main" }] });
	for (const [faux, name] of [
		[alpha, "Fixture Alpha"],
		[beta, "Fixture Beta"],
		[gamma, "Fixture Gamma"],
	] as const) {
		const provider: Provider = {
			...faux.provider,
			name,
			refreshModels: async ({ allowNetwork }) => {
				if (allowNetwork && options.refreshFails) throw new Error("Fixture refresh failed");
			},
			filterModels: (models, credential) =>
				(options.unavailableAlpha && faux === alpha) ||
				(options.unavailableBeta && faux === beta) ||
				(credential?.type === "api_key" && credential.key === "fixture-limited")
					? []
					: models,
			auth: {
				oauth: options.oauth
					? {
							name: "Fixture OAuth",
							login: async ({ prompt }) => ({
								type: "oauth",
								access: await prompt({ type: "secret", message: "Fixture authorization code" }),
								refresh: "fixture-refresh",
								expires: Date.now() + 3_600_000,
							}),
							refresh: async (credential) => credential,
							toAuth: async (credential) => ({ apiKey: credential.access }),
						}
					: undefined,
				apiKey: {
					name: "Fixture key",
					check: async ({ credential }) => (credential?.key ? { type: "api_key" } : undefined),
					resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
					login: async ({ prompt }) => ({
						type: "api_key",
						key: await prompt({ type: "secret", message: "Fixture API key" }),
					}),
				},
			},
		};
		modelRuntime.registerNativeProvider(provider);
	}
	await modelRuntime.refresh({ allowNetwork: false });
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({
			compaction: { enabled: false },
			retry: { enabled: false },
			quietStartup: true,
			defaultProvider: "fixture-alpha",
			defaultModel: "alpha-main",
			enabledModels: ["fixture-alpha/alpha-main"],
		}),
	);
	await mkdir(join(directory, ".pi"));
	await writeFile(join(directory, ".pi/settings.json"), JSON.stringify({ theme: "dark" }));
	const settingsManager = SettingsManager.create(directory, directory, { projectTrusted: true });
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager,
				resourceLoaderOptions: {
					extensionFactories: [
						accounts,
						...(options.background ? [createSubagentsExtension({ agentDir: directory })] : []),
					],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: alpha.getModel(),
					scopedModels: [
						{ model: alpha.getModel() },
						...(options.unavailableBeta ? [{ model: beta.getModel() }] : []),
					],
					noTools: "builtin",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{
			cwd: directory,
			agentDir: directory,
			sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		},
	);
	const terminal = new AccountsTerminal();
	const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular", initialThemeSetting: "dark" });
	cleanups.push(async () => {
		terminal.send("\x1b");
		mode.stop();
		await runtime.dispose();
	});
	await mode.init();
	let runError: unknown;
	void mode.run().catch((error: unknown) => {
		runError = error;
	});
	const shown = async (text: string) =>
		waitFor(() => {
			if (runError) throw runError;
			expect(terminal.screen).toContain(text);
		});
	const command = (text = "/accounts") => {
		terminal.send(text);
		terminal.send("\r");
	};
	return { directory, terminal, runtime, settingsManager, store, alpha, beta, shown, command };
}

async function startAlphaLogin(h: Awaited<ReturnType<typeof fixture>>, name: string) {
	h.command("/accounts fixture-alpha");
	await h.shown("Fixture Alpha accounts");
	h.terminal.send("\x1b[B");
	h.terminal.send("\r");
	await h.shown("Account name");
	h.terminal.send(name);
	h.terminal.send("\r");
}

describe("interactive /accounts", () => {
	it("preserves native global and project settings on disk across all entry routes and explicit selection", async () => {
		const h = await fixture();
		const paths = [join(h.directory, "settings.json"), join(h.directory, ".pi/settings.json")];
		const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
		const sessionFile = h.runtime.session.sessionFile;
		expect(sessionFile).toEqual(expect.any(String));
		const scope = [...h.runtime.session.scopedModels];
		for (const [route, title] of [
			["/accounts", "[Accounts]"],
			["/accounts --scoped", "View: Scoped"],
		]) {
			h.command(route);
			await h.shown(title);
			h.terminal.send("\x1b");
			await waitFor(() => expect(h.terminal.screen).not.toContain(title));
		}
		h.command("/accounts --models");
		await h.shown("View: All");
		h.terminal.send("beta-main");
		await h.shown("› Beta Main");
		h.terminal.send("\r");
		await waitFor(() => expect(h.runtime.session.model?.id).toBe("beta-main"));
		expect(h.runtime.session.sessionFile).toBe(sessionFile);
		expect(h.runtime.session.scopedModels).toEqual(scope);
		expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
	});

	it(
		"opens Models directly across connected providers and selects the Active model",
		async () => {
			const h = await fixture();
			const scope = [...h.runtime.session.scopedModels];
			const defaults = h.settingsManager.getGlobalSettings();
			h.command("/accounts --models");
			await h.shown("Accounts  [Models]");
			expect(h.terminal.screen).toContain("View: All · Provider: All providers");
			expect(h.terminal.screen).toContain("Alpha Extra (alpha-extra)");
			expect(h.terminal.screen).toContain("Beta Main (beta-main)");
			expect(h.terminal.screen).not.toContain("Gamma Main (gamma-main)");
			h.terminal.send("beta-main");
			await h.shown("› Beta Main");
			h.terminal.send("\r");
			await waitFor(() => expect(h.runtime.session.model?.id).toBe("beta-main"));
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
		},
		readinessMs * 2,
	);

	it(
		"opens native Scoped membership read-only and navigates back to All and Accounts",
		async () => {
			const h = await fixture({ unavailableBeta: true });
			const scope = [...h.runtime.session.scopedModels];
			const defaults = h.settingsManager.getGlobalSettings();
			const savedAccounts = await h.store.list();
			h.command("/accounts --scoped");
			await h.shown("Accounts  [Models]");
			expect(h.terminal.screen).toContain("View: Scoped · Provider: All providers");
			expect(h.terminal.screen).toContain("Alpha Main (alpha-main) · Active model · Scoped");
			expect(h.terminal.screen).toContain("Beta Main (beta-main) · Scoped · Unavailable");
			expect(h.terminal.screen).not.toContain("Alpha Extra (alpha-extra)");
			expect(h.terminal.screen).not.toContain("Edit scope");
			h.terminal.send("\x13");
			await h.shown("View: All");
			expect(h.terminal.screen).toContain("Alpha Extra (alpha-extra)");
			h.terminal.send("\t");
			await h.shown("[Accounts]");
			h.terminal.send("\x1b");
			await waitFor(() => expect(h.terminal.screen).not.toContain("[Accounts]"));
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
			expect(await h.store.list()).toEqual(savedAccounts);
		},
		readinessMs * 2,
	);

	it.each([
		"--unknown",
		"--models --scoped",
		"--models --models",
		"--scoped --scoped",
		"--models fixture-alpha",
		"fixture-alpha --models",
		"--scoped fixture-alpha",
		"fixture-alpha --scoped",
		"--models=true",
		"fixture-alpha fixture-beta",
		"unknown-provider",
	])(
		"rejects %s with usage guidance without changing accounts, model, or scope",
		async (args) => {
			const h = await fixture();
			const savedAccounts = await h.store.list();
			const scope = [...h.runtime.session.scopedModels];
			const defaults = h.settingsManager.getGlobalSettings();
			h.command(`/accounts ${args}`);
			await h.shown("Usage: /accounts [provider-id] | /accounts --models | /accounts --scoped");
			expect(h.terminal.screen).not.toContain("[Accounts]");
			expect(h.terminal.screen).not.toContain("[Models]");
			expect(h.terminal.screen).not.toContain("Fixture Alpha accounts");
			expect(await h.store.list()).toEqual(savedAccounts);
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
		},
		readinessMs * 2,
	);

	it(
		"keeps native /login on pi's authentication flow",
		async () => {
			const h = await fixture();
			const savedAccounts = await h.store.list();
			h.command("/login");
			await h.shown("Select authentication method:");
			expect(h.terminal.screen).not.toContain("[Accounts]");
			h.terminal.send("\x1b[B");
			h.terminal.send("\r");
			await h.shown("Select provider to configure:");
			h.terminal.send("fixture-gamma");
			await h.shown("Fixture Gamma");
			expect(h.terminal.screen).toContain("not configured");
			h.terminal.send("\x1b");
			await h.shown("Select authentication method:");
			h.terminal.send("\x1b");
			await waitFor(() => expect(h.terminal.screen).not.toContain("Select authentication method:"));
			expect(await h.store.list()).toEqual(savedAccounts);
		},
		readinessMs * 2,
	);

	it.each(["/model", "Ctrl+L"])(
		"keeps %s on pi's native model selector",
		async (entry) => {
			const h = await fixture();
			const scope = [...h.runtime.session.scopedModels];
			const defaults = h.settingsManager.getGlobalSettings();
			if (entry === "/model") h.command(entry);
			else h.terminal.send("\x0c");
			await h.shown("Scope: all | scoped");
			expect(h.terminal.screen).not.toContain("[Models]");
			expect(h.terminal.screen).toContain("alpha-main");
			expect(h.terminal.screen).not.toContain("alpha-extra");
			expect(h.terminal.screen).not.toContain("beta-main");
			h.terminal.send("\t");
			await h.shown("alpha-extra");
			h.terminal.send("beta-main");
			await h.shown("beta-main");
			h.terminal.send("\r");
			await waitFor(() => expect(h.runtime.session.model?.id).toBe("beta-main"));
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
		},
		readinessMs * 2,
	);

	it(
		"keeps native model cycling and /scoped-models scope editing",
		async () => {
			const h = await fixture();
			const defaults = h.settingsManager.getGlobalSettings();
			h.terminal.send("\x10");
			await h.shown("Only one model in scope");
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			h.command("/scoped-models");
			await h.shown("Model Configuration");
			expect(h.terminal.screen).toContain("Session-only.");
			expect(h.terminal.screen).not.toContain("[Models]");
			h.terminal.send("beta-main");
			await h.shown("beta-main");
			h.terminal.send("\r");
			await waitFor(() =>
				expect(h.runtime.session.scopedModels.map(({ model }) => model.id)).toEqual(["alpha-main", "beta-main"]),
			);
			h.terminal.send("\x1b");
			await waitFor(() => expect(h.terminal.screen).not.toContain("Model Configuration"));
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
			h.terminal.send("\x10");
			await waitFor(() => expect(h.runtime.session.model?.id).toBe("beta-main"));
		},
		readinessMs * 2,
	);

	it(
		"opens Models from Accounts with provider groups and credential-aware availability",
		async () => {
			const h = await fixture();
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("Fixture");
			await h.shown("Fixture Gamma (fixture-gamma) · Disconnected");
			expect(h.terminal.screen).toContain("Fixture Alpha (fixture-alpha) · Connected");
			expect(h.terminal.screen).toContain("Fixture Beta (fixture-beta) · Connected");
			h.terminal.send("\t");
			await h.shown("Active model");
			expect(h.terminal.screen).toContain("Fixture Alpha");
			expect(h.terminal.screen).toContain("Fixture Beta");
			expect(h.terminal.screen).toContain("Alpha Main");
			expect(h.terminal.screen).toContain("Beta Main");
			expect(h.terminal.screen).toContain("View: All");
			expect(h.terminal.screen).toContain("Active account: Personal");
			expect(h.terminal.screen).toContain("Active account: Work");
			expect(h.terminal.screen).not.toContain("Gamma Main");
		},
		readinessMs * 2,
	);

	it(
		"selects an unscoped model without changing conversation, scope, or defaults",
		async () => {
			const h = await fixture();
			await h.runtime.session.sendCustomMessage({
				customType: "fixture",
				content: "Keep this conversation",
				display: false,
			});
			const sessionId = h.runtime.session.sessionId;
			const messages = structuredClone(h.runtime.session.messages);
			const scope = [...h.runtime.session.scopedModels];
			const defaults = h.settingsManager.getGlobalSettings();
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("View: All");
			h.terminal.send("Alpha");
			await h.shown("1/2");
			h.terminal.send("\x1b[B");
			await h.shown("› Alpha Main");
			h.terminal.send("\x1b[A");
			await h.shown("› Alpha Extra");
			h.terminal.send("\r");
			await waitFor(() => expect(h.runtime.session.model?.id).toBe("alpha-extra"));
			expect(h.runtime.session.sessionId).toBe(sessionId);
			expect(h.runtime.session.messages).toEqual(messages);
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
		},
		readinessMs * 2,
	);

	it(
		"explains an outside-scope Active model and Show all clears provider, scope view, and search",
		async () => {
			const h = await fixture();
			await h.runtime.session.setModel(h.beta.getModel());
			const scope = [...h.runtime.session.scopedModels];
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("Active model is outside scope");
			h.terminal.send("\x10");
			await h.shown("Provider: fixture-alpha");
			expect(h.terminal.screen).not.toContain("Beta Main (beta-main)");
			h.terminal.send("\x13");
			await h.shown("View: Scoped");
			expect(h.terminal.screen).not.toContain("Alpha Extra (alpha-extra)");
			h.terminal.send("no-such-model");
			await h.shown("No matches.");
			h.terminal.send("\x01");
			await h.shown("View: All · Provider: All providers");
			expect(h.terminal.screen).toContain("Alpha Extra (alpha-extra)");
			expect(h.terminal.screen).toContain("Beta Main (beta-main) · Active model");
			expect(h.terminal.screen).not.toContain("no-such-model");
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(h.runtime.session.model?.id).toBe("beta-main");
		},
		readinessMs * 2,
	);

	it(
		"keeps an unavailable Scoped model visible but cannot select it",
		async () => {
			const h = await fixture({ unavailableBeta: true });
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("View: All");
			h.terminal.send("\x13");
			await h.shown("View: Scoped");
			h.terminal.send("beta-main");
			await h.shown("Beta Main (beta-main) · Scoped · Unavailable");
			h.terminal.send("\r");
			h.terminal.send("\t");
			await h.shown("[Accounts]");
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			expect(h.runtime.session.scopedModels.map(({ model }) => model.id)).toEqual(["alpha-main", "beta-main"]);
		},
		readinessMs * 2,
	);

	it(
		"treats an empty host scope as unrestricted without reconstructing saved restrictions",
		async () => {
			const h = await fixture();
			h.runtime.session.setScopedModels([]);
			const defaults = h.settingsManager.getGlobalSettings();
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("View: All");
			expect(h.terminal.screen).toContain("Alpha Main (alpha-main) · Active model · Scoped");
			expect(h.terminal.screen).toContain("Alpha Extra (alpha-extra) · Scoped");
			expect(h.terminal.screen).toContain("Beta Main (beta-main) · Scoped");
			h.terminal.send("\x13");
			await h.shown("View: Scoped");
			expect(h.terminal.screen).toContain("Alpha Extra (alpha-extra) · Scoped");
			expect(h.terminal.screen).toContain("Beta Main (beta-main) · Scoped");
			expect(h.terminal.screen).not.toContain("outside scope");
			expect(h.terminal.screen).not.toContain("Gamma Main (gamma-main)");
			expect(h.runtime.session.scopedModels).toEqual([]);
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
		},
		readinessMs * 2,
	);

	it(
		"reopens with fresh native scope membership instead of the previous chooser snapshot",
		async () => {
			const h = await fixture();
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("Alpha Main (alpha-main) · Active model · Scoped");
			h.terminal.send("\x1b");
			await waitFor(() => expect(h.terminal.screen).not.toContain("Accounts  [Models]"));
			h.command("/scoped-models");
			await h.shown("Model Configuration");
			h.terminal.send("beta-main");
			await h.shown("Model Name: Beta Main");
			h.terminal.send("\r");
			await waitFor(() =>
				expect(h.runtime.session.scopedModels.map(({ model }) => model.id)).toEqual(["alpha-main", "beta-main"]),
			);
			h.terminal.send("\x1b");
			await waitFor(() => expect(h.terminal.screen).not.toContain("Model Configuration"));
			const scope = [...h.runtime.session.scopedModels];
			const defaults = h.settingsManager.getGlobalSettings();
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("Beta Main (beta-main) · Scoped");
			h.terminal.send("\x13");
			await h.shown("View: Scoped");
			expect(h.terminal.screen).toContain("Alpha Main (alpha-main) · Active model · Scoped");
			expect(h.terminal.screen).not.toContain("Alpha Extra (alpha-extra)");
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
		},
		readinessMs * 2,
	);

	it.each(["/reload", "/new"])(
		"reads a fresh command context after native %s",
		async (lifecycleCommand) => {
			const h = await fixture();
			h.runtime.session.setScopedModels([{ model: h.beta.getModel() }]);
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("Beta Main (beta-main) · Scoped");
			h.terminal.send("\x1b");
			await waitFor(() => expect(h.terminal.screen).not.toContain("Accounts  [Models]"));
			const previousSession = h.runtime.session;
			h.command(lifecycleCommand);
			await h.shown(lifecycleCommand === "/reload" ? "Reloaded keybindings" : "New session started");
			if (lifecycleCommand === "/new") expect(h.runtime.session).not.toBe(previousSession);
			h.runtime.session.setScopedModels([{ model: h.alpha.getModel() }]);
			const scope = [...h.runtime.session.scopedModels];
			const defaults = h.settingsManager.getGlobalSettings();
			const projectSettings = h.settingsManager.getProjectSettings();
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("Alpha Main (alpha-main) · Active model · Scoped");
			expect(h.terminal.screen).not.toContain("Beta Main (beta-main) · Scoped");
			h.terminal.send("\x13");
			await h.shown("View: Scoped");
			expect(h.terminal.screen).not.toContain("Beta Main (beta-main)");
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(h.settingsManager.getGlobalSettings()).toEqual(defaults);
			expect(h.settingsManager.getProjectSettings()).toEqual(projectSettings);
		},
		readinessMs * 2,
	);

	it(
		"explains when no restricted members are available without treating other models as Scoped",
		async () => {
			const h = await fixture({ unavailableAlpha: true });
			const scope = [...h.runtime.session.scopedModels];
			h.command();
			await h.shown("[Accounts]");
			h.terminal.send("\t");
			await h.shown("View: All");
			h.terminal.send("\x13");
			await h.shown("View: Scoped");
			await h.shown("No available Scoped models. Show all: Ctrl+A (scope unchanged).");
			expect(h.terminal.screen).toContain("Alpha Main (alpha-main) · Active model · Scoped · Unavailable");
			expect(h.terminal.screen).not.toContain("Beta Main (beta-main)");
			h.terminal.send("\r");
			h.terminal.send("\x01");
			await h.shown("View: All");
			expect(h.terminal.screen).toContain("Beta Main (beta-main)");
			expect(h.terminal.screen).not.toContain("Beta Main (beta-main) · Scoped");
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			expect(h.runtime.session.scopedModels).toEqual(scope);
		},
		readinessMs * 2,
	);

	it(
		"adds an API-key account then opens provider-filtered Models without choosing one",
		async () => {
			const h = await fixture();
			const before = await h.store.list("fixture-beta");
			await startAlphaLogin(h, "Office");
			await h.shown("Fixture API key");
			h.terminal.send("fixture-office");
			h.terminal.send("\r");
			await h.shown("View: All · Provider: fixture-alpha");
			expect(h.terminal.screen).toContain("Active account: Office");
			expect(h.terminal.screen).not.toContain("Beta Main (beta-main)");
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			expect((await h.store.list("fixture-alpha")).map(({ name, active }) => ({ name, active }))).toEqual([
				{ name: "Personal", active: false },
				{ name: "Office", active: true },
			]);
			expect(await h.store.list("fixture-beta")).toEqual(before);
		},
		readinessMs * 2,
	);

	it(
		"adds an OAuth account then opens provider-filtered Models without choosing one",
		async () => {
			const h = await fixture({ oauth: true });
			await startAlphaLogin(h, "Browser");
			await h.shown("Sign-in method");
			h.terminal.send("\r");
			await h.shown("Fixture authorization code");
			h.terminal.send("fixture-code");
			h.terminal.send("\r");
			await h.shown("View: All · Provider: fixture-alpha");
			expect(h.terminal.screen).toContain("Active account: Browser");
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			expect(await h.store.list("fixture-alpha")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "Personal", type: "api_key", active: false }),
					expect.objectContaining({ name: "Browser", type: "oauth", active: true }),
				]),
			);
		},
		readinessMs * 2,
	);

	it(
		"cancels login without changing accounts or the Active model",
		async () => {
			const h = await fixture();
			const accountsBefore = await h.store.list();
			await startAlphaLogin(h, "Cancelled");
			await h.shown("Fixture API key");
			h.terminal.send("unfinished-key");
			h.terminal.send("\x1b");
			await h.shown("Fixture Alpha accounts");
			expect(await h.store.list()).toEqual(accountsBefore);
			expect(h.runtime.session.model?.id).toBe("alpha-main");
		},
		readinessMs * 2,
	);

	it(
		"warns after switching saved accounts loses Active and all Scoped model access without replacing either",
		async () => {
			const h = await fixture();
			const limited = await h.store.add("fixture-alpha", "Limited", { type: "api_key", key: "fixture-limited" });
			const otherProvider = await h.store.list("fixture-beta");
			const scope = [...h.runtime.session.scopedModels];
			h.command("/accounts fixture-alpha");
			await h.shown("Limited · API key");
			h.terminal.send("\x1b[B");
			h.terminal.send("\r");
			await h.shown("The Active model is now unavailable");
			expect(h.terminal.screen).toContain("Every Scoped model is now unavailable");
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			expect(h.runtime.session.scopedModels).toEqual(scope);
			expect(await h.store.list("fixture-alpha")).toContainEqual(
				expect.objectContaining({ id: limited.id, active: true }),
			);
			expect(await h.store.list("fixture-beta")).toEqual(otherProvider);
		},
		readinessMs * 2,
	);

	it(
		"keeps a saved account switch when refresh fails and explains how to recover",
		async () => {
			const h = await fixture({ refreshFails: true });
			const office = await h.store.add("fixture-alpha", "Office", { type: "api_key", key: "fixture-office" });
			const scope = [...h.runtime.session.scopedModels];
			h.command("/accounts fixture-alpha");
			await h.shown("Office · API key");
			h.terminal.send("\x1b[B");
			h.terminal.send("\r");
			await h.shown("Account saved, but model availability could not refresh. Run /reload");
			expect(await h.store.list("fixture-alpha")).toContainEqual(
				expect.objectContaining({ id: office.id, active: true }),
			);
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			expect(h.runtime.session.scopedModels).toEqual(scope);
		},
		readinessMs * 2,
	);

	it(
		"refuses account changes while a subagent run is open after the parent becomes idle",
		async () => {
			// The orchestrator runs in a pane, and its run is a pane that never runs a pi.
			vi.stubEnv(PANE_ENV, "pi-orchestrator");
			vi.spyOn(Tmux.prototype, "newSession").mockReturnValue("pi-run1");
			vi.spyOn(Tmux.prototype, "end").mockImplementation(() => {});
			vi.spyOn(Tmux.prototype, "hasSession").mockReturnValue(true);
			vi.spyOn(OrchestratorClient.prototype, "send").mockResolvedValue(undefined);
			cleanups.push(async () => {
				vi.restoreAllMocks();
			});
			const h = await fixture({ background: true });
			const accountsBefore = await h.store.list();
			let parentTurns = 0;
			const reply = async () => {
				if (parentTurns++ === 0)
					return fauxAssistantMessage([
						fauxToolCall(
							"subagent",
							{ agent: "explorer", task: "Hold fixture background task", background: true },
							{ id: "fixture-background" },
						),
					]);
				return fauxAssistantMessage("Fixture parent is idle.");
			};
			h.alpha.setResponses([reply, reply]);
			h.command("Start fixture background task");
			await h.shown("Fixture parent is idle.");
			await waitFor(() => {
				expect(h.runtime.session.isStreaming).toBe(false);
				expect(agentTasks()?.list(h.runtime.session.sessionId)).toEqual(
					expect.arrayContaining([expect.objectContaining({ state: "running" })]),
				);
			});
			h.command();
			await h.shown("Wait for the agent and background subagents to finish");
			expect(await h.store.list()).toEqual(accountsBefore);
			expect(h.runtime.session.model?.id).toBe("alpha-main");
			agentTasks()?.closeAll({ owner: h.runtime.session.sessionId });
			await waitFor(() =>
				expect(
					agentTasks()
						?.list(h.runtime.session.sessionId)
						.filter((task) => task.state === "running"),
				).toEqual([]),
			);
		},
		readinessMs * 3,
	);
});
