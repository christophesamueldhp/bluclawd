import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AccountMetadata } from "./store.ts";

export interface ChooserView {
	section: "Accounts" | "Models";
	provider?: string;
	scoped: boolean;
	query: string;
}

type Choice = { provider: Provider } | { model: Model<Api> };
const modelKey = (model: Model<Api>) => JSON.stringify([model.provider, model.id]);

/** One browsing surface; account dialogs and model mutations run after it closes. */
export function chooseAccountOrModel(
	ctx: ExtensionCommandContext,
	providers: Provider[],
	accounts: AccountMetadata[],
	view: ChooserView,
): Promise<Choice | undefined> {
	return ctx.ui.custom<Choice | undefined>((tui, theme, keys, done) => {
		const search = new Input({ placeholder: "Search…" });
		search.setValue(view.query);
		let selected = 0;
		let focused = false;
		const available = ctx.modelRegistry.getAvailable();
		const availableKeys = new Set(available.map(modelKey));
		const scope = ctx.scopedModels.map(({ model }) => model);
		const scopeKeys = new Set(scope.map(modelKey));
		const restricted = scope.length > 0;
		const catalog = new Map(
			[...ctx.modelRegistry.getAll(), ...scope, ...(ctx.model ? [ctx.model] : [])].map((model) => [
				modelKey(model),
				model,
			]),
		);
		const activeAccount = (id: string) => accounts.find((account) => account.provider === id && account.active)?.name;
		const accountLabel = (id: string) => `Active account: ${activeAccount(id) ?? "No named account"}`;
		const outsideScope = ctx.model && restricted && !scopeKeys.has(modelKey(ctx.model));

		function rows(): { choice: Choice; label: string; group?: string; available?: boolean }[] {
			const query = search.getValue().toLowerCase();
			if (view.section === "Accounts") {
				return providers.flatMap((provider) => {
					const status = ctx.modelRegistry.getProviderAuthStatus(provider.id);
					const connection = status.configured ? "Connected" : "Disconnected";
					const external = status.source && status.source !== "stored" ? " · external/configured credentials" : "";
					const label = `${provider.name} (${provider.id}) · ${connection} · ${accountLabel(provider.id)}${external}`;
					return label.toLowerCase().includes(query) ? [{ choice: { provider }, label }] : [];
				});
			}
			return providers.flatMap((provider) => {
				if (view.provider && provider.id !== view.provider) return [];
				const connected = ctx.modelRegistry.getProviderAuthStatus(provider.id).configured;
				return [...catalog.values()]
					.filter((model) => {
						const key = modelKey(model);
						return (
							model.provider === provider.id &&
							(connected || scopeKeys.has(key) || key === (ctx.model && modelKey(ctx.model))) &&
							(!view.scoped || (restricted ? scopeKeys.has(key) : availableKeys.has(key))) &&
							`${provider.name} ${provider.id} ${model.name} ${model.id}`.toLowerCase().includes(query)
						);
					})
					.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
					.map((model) => {
						const key = modelKey(model);
						const isAvailable = availableKeys.has(key);
						const labels = [
							ctx.model && key === modelKey(ctx.model) ? "Active model" : "",
							(restricted ? scopeKeys.has(key) : isAvailable) ? "Scoped" : "",
							isAvailable ? "" : "Unavailable",
						].filter(Boolean);
						return {
							choice: { model },
							label: `${model.name} (${model.id})${labels.length ? ` · ${labels.join(" · ")}` : ""}`,
							group: `${provider.name} (${provider.id}) · ${accountLabel(provider.id)}`,
							available: isAvailable,
						};
					});
			});
		}

		return {
			get focused() {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				search.focused = value;
			},
			render(width: number): string[] {
				const items = rows();
				selected = Math.max(0, Math.min(selected, items.length - 1));
				const lines = [
					theme.fg("accent", view.section === "Accounts" ? "[Accounts]  Models" : "Accounts  [Models]"),
				];
				if (view.section === "Models") {
					lines.push(`View: ${view.scoped ? "Scoped" : "All"} · Provider: ${view.provider ?? "All providers"}`);
					if (outsideScope)
						lines.push(theme.fg("warning", "Active model is outside scope. Show all: Ctrl+A (scope unchanged)."));
				}
				lines.push(...search.render(width));
				// Keep groups together in a bounded window, repeating the heading when scrolling into a group.
				const count = Math.max(1, Math.min(8, Math.floor((tui.terminal.rows - 10) / 2)));
				const start = Math.max(0, selected - count + 1);
				let group: string | undefined;
				for (let i = start; i < Math.min(items.length, start + count); i++) {
					const item = items[i];
					if (!item) continue;
					if (item.group && item.group !== group) {
						group = item.group;
						lines.push(theme.fg("accent", group));
					}
					const label = `${i === selected ? "› " : "  "}${item.label}`;
					lines.push(i === selected ? theme.fg("accent", label) : label);
				}
				if (!items.length) lines.push("No matches.");
				else lines.push(theme.fg("dim", `${selected + 1}/${items.length}`));
				lines.push(theme.fg("dim", "Tab Accounts/Models · ↑↓ move · Enter select · Esc close"));
				if (view.section === "Models")
					lines.push(theme.fg("dim", "Ctrl+P provider · Ctrl+S All/Scoped · Ctrl+A Show all"));
				else
					lines.push(
						theme.fg(
							"dim",
							"Named accounts manage shared stored logins; external credentials may take precedence.",
						),
					);
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {
				search.invalidate();
			},
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.cancel")) return done(undefined);
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
					view.section = view.section === "Accounts" ? "Models" : "Accounts";
					search.setValue("");
					selected = 0;
				} else if (view.section === "Models" && matchesKey(data, Key.ctrl("p"))) {
					const ids = providers
						.filter(
							(provider) =>
								ctx.modelRegistry.getProviderAuthStatus(provider.id).configured ||
								scope.some((model) => model.provider === provider.id) ||
								ctx.model?.provider === provider.id,
						)
						.map((provider) => provider.id);
					view.provider = ids[(view.provider ? ids.indexOf(view.provider) : -1) + 1];
					selected = 0;
				} else if (view.section === "Models" && matchesKey(data, Key.ctrl("s"))) {
					view.scoped = !view.scoped;
					selected = 0;
				} else if (view.section === "Models" && matchesKey(data, Key.ctrl("a"))) {
					view.provider = undefined;
					view.scoped = false;
					search.setValue("");
					selected = 0;
				} else if (keys.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
				else if (keys.matches(data, "tui.select.down")) selected = Math.min(rows().length - 1, selected + 1);
				else if (keys.matches(data, "tui.select.confirm")) {
					const item = rows()[selected];
					if (item && item.available !== false) return done(item.choice);
				} else {
					const before = search.getValue();
					search.handleInput(data);
					if (search.getValue() !== before) selected = 0;
				}
				view.query = search.getValue();
				tui.requestRender();
			},
		};
	});
}
