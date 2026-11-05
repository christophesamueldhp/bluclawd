import type { AuthType, Provider } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { agentTasks } from "../_shared/agent-tasks.ts";
import { chooseAccountOrModel, type ChooserView } from "./chooser.ts";
import { loginAccount } from "./login.ts";
import { AccountStore } from "./store.ts";

const authLabel = (type: AuthType) => (type === "oauth" ? "OAuth" : "API key");

function requireIdle(ctx: ExtensionCommandContext): boolean {
	if (
		!ctx.isIdle() ||
		agentTasks()
			?.list()
			.some((task) => task.state === "running")
	) {
		ctx.ui.notify("Wait for the agent and background subagents to finish before changing accounts.", "warning");
		return false;
	}
	return true;
}

function providers(ctx: ExtensionCommandContext): Provider[] {
	const ids = new Set([
		...getBuiltinProviders(),
		...ctx.modelRegistry.getAll().map((model) => model.provider),
		...ctx.modelRegistry.getRegisteredProviderIds(),
	]);
	return [...ids]
		.map((id) => ctx.modelRegistry.getProvider(id))
		.filter((provider): provider is Provider => provider !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function refresh(ctx: ExtensionCommandContext, provider: string): Promise<void> {
	try {
		const result = await ctx.modelRegistry.refresh({ providers: [provider], allowNetwork: true, force: true });
		if (result.aborted || result.errors.size > 0) throw new Error("Model refresh failed");
		const available = ctx.modelRegistry.getAvailable();
		const hasAccess = (model: { provider: string; id: string }) =>
			available.some((item) => item.provider === model.provider && item.id === model.id);
		if (ctx.model && !hasAccess(ctx.model)) {
			ctx.ui.notify(
				"The Active model is now unavailable. Choose a replacement in Models; the selection was kept.",
				"warning",
			);
		}
		if (ctx.scopedModels?.length && !ctx.scopedModels.some(({ model }) => hasAccess(model))) {
			ctx.ui.notify(
				"Every Scoped model is now unavailable. Scope was kept; use Show all to choose a model explicitly.",
				"warning",
			);
		}
	} catch {
		ctx.ui.notify(
			"Account saved, but model availability could not refresh. Run /reload before continuing.",
			"warning",
		);
	}
}

async function chooseAccount(
	ctx: ExtensionCommandContext,
	provider: Provider,
	store: AccountStore,
): Promise<"login" | undefined> {
	while (true) {
		const accounts = await store.list(provider.id);
		const labels = accounts.map(
			(account) => `${account.active ? "✓ " : ""}${account.name} · ${authLabel(account.type)}`,
		);
		const add = "Add account…";
		const save = "Save current login…";
		const remove = "Remove saved account…";
		const back = "Back";
		const choice = await ctx.ui.select(
			`${provider.name} accounts${accounts.length === 0 ? " (no saved accounts)" : ""}`,
			[...labels, add, save, ...(accounts.some((account) => !account.active) ? [remove] : []), back],
		);
		if (!choice || choice === back) return;
		if (!requireIdle(ctx)) return;
		const selected = accounts[labels.indexOf(choice)];
		if (selected) {
			await store.switchTo(selected.id);
			await refresh(ctx, provider.id);
			ctx.ui.notify(
				`Active account for ${provider.name}: ${selected.name}. Model and conversation unchanged.`,
				"info",
			);
			return;
		}
		if (choice === remove) {
			const inactive = accounts.filter((account) => !account.active);
			const name = await ctx.ui.select(
				"Remove which saved account?",
				inactive.map((account) => account.name),
			);
			const account = inactive.find((account) => account.name === name);
			if (
				account &&
				(await ctx.ui.confirm("Remove saved account?", `Remove ${account.name} from ${provider.name}?`)) &&
				requireIdle(ctx)
			) {
				await store.remove(account.id);
			}
			continue;
		}
		if (choice === add || choice === save) {
			const name = (await ctx.ui.input("Account name", "For example: Personal or Work"))?.trim();
			if (!name) continue;
			if (
				name.length > 80 ||
				/[\u0000-\u001f\u007f]/.test(name) ||
				accounts.some((account) => account.name === name)
			) {
				ctx.ui.notify("Use a unique account name of 1–80 characters, without control characters.", "warning");
				continue;
			}
			if (choice === save) {
				if (!requireIdle(ctx)) return;
				await store.saveCurrent(provider.id, name);
				ctx.ui.notify(`Current ${provider.name} login saved as ${name}.`, "info");
				continue;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"Adding an account requires Pi's terminal UI. Switching saved accounts works here.",
					"warning",
				);
				continue;
			}
			const methods: { type: AuthType; label: string }[] = [];
			if (provider.auth.oauth)
				methods.push({ type: "oauth", label: provider.auth.oauth.loginLabel ?? "Sign in with OAuth" });
			if (provider.auth.apiKey?.login) methods.push({ type: "api_key", label: "Sign in with an API key" });
			const methodLabel =
				methods.length === 1
					? methods[0]?.label
					: await ctx.ui.select(
							"Sign-in method",
							methods.map((m) => m.label),
						);
			const method = methods.find((item) => item.label === methodLabel);
			if (!method) {
				if (methods.length === 0)
					ctx.ui.notify("This provider uses ambient credentials. Save a stored login instead.", "warning");
				continue;
			}
			const credential = await loginAccount(ctx, provider, method.type, getAgentDir());
			if (!credential) continue;
			if (!requireIdle(ctx)) return;
			const account = await store.add(provider.id, name, credential);
			await store.switchTo(account.id);
			await refresh(ctx, provider.id);
			ctx.ui.notify(`Active account for ${provider.name}: ${name}. Your previous login was preserved.`, "info");
			return "login";
		}
	}
}

export default function accounts(pi: ExtensionAPI) {
	let open = false;
	pi.registerCommand("accounts", {
		description: "Manage named provider accounts and choose the Active model",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Use /accounts in interactive Pi to manage provider accounts.", "warning");
				return;
			}
			if (open || !requireIdle(ctx)) return;
			open = true;
			try {
				const all = providers(ctx);
				const id = args.trim();
				const store = new AccountStore(getAgentDir());
				if (ctx.mode !== "tui") {
					const labels = all.map((provider) => `${provider.name} (${provider.id})`);
					const choice = id ? undefined : await ctx.ui.select("Accounts — choose a provider", labels);
					const provider = id ? all.find((provider) => provider.id === id) : all[labels.indexOf(choice ?? "")];
					if (provider) await chooseAccount(ctx, provider, store);
					else if (id) ctx.ui.notify("Unknown provider. Run /accounts to choose one.", "warning");
					return;
				}
				const view: ChooserView = { section: "Accounts", scoped: false, query: "" };
				let provider = id ? all.find((item) => item.id === id) : undefined;
				if (id && !provider) {
					ctx.ui.notify("Unknown provider. Run /accounts to choose one.", "warning");
					return;
				}
				while (true) {
					if (provider) {
						const outcome = await chooseAccount(ctx, provider, store);
						if (outcome === "login") {
							view.section = "Models";
							view.provider = provider.id;
							view.scoped = false;
							view.query = "";
						}
						provider = undefined;
					}
					const choice = await chooseAccountOrModel(ctx, all, await store.list(), view);
					if (!choice) return;
					if ("provider" in choice) {
						provider = choice.provider;
						continue;
					}
					if (!requireIdle(ctx)) return;
					const model = ctx.modelRegistry
						.getAvailable()
						.find((item) => item.provider === choice.model.provider && item.id === choice.model.id);
					try {
						if (model && (await pi.setModel(model))) return;
					} catch {
						// Provider errors may contain credentials; show only the safe recovery message below.
					}
					ctx.ui.notify(
						"Could not use this model. Check provider access and choose an available model.",
						"warning",
					);
				}
			} catch {
				ctx.ui.notify(
					"Could not update accounts. Check that a current login exists and account storage is readable and writable.",
					"error",
				);
			} finally {
				open = false;
			}
		},
	});
}
