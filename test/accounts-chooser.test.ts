import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type ChooserView, chooseAccountOrModel } from "../ext/accounts/chooser.ts";
import type { AccountMetadata } from "../ext/accounts/store.ts";

type Component = { render(width: number): string[]; handleInput(data: string): void };
const down = "\x1b[B";
const enter = "\r";
const up = "\x1b[A";
const keyNames: Record<string, string> = {
	[up]: "tui.select.up",
	[down]: "tui.select.down",
	[enter]: "tui.select.confirm",
};

function accountsView(
	configured: string[],
	view: ChooserView = { section: "Accounts", query: "", scoped: false },
	accounts: AccountMetadata[] = [],
) {
	let component: Component | undefined;
	const chosen: unknown[] = [];
	const ctx = {
		model: undefined,
		scopedModels: [],
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			getProviderAuthStatus: (id: string) => ({ configured: configured.includes(id) }),
		},
		ui: {
			custom: (factory: (...args: unknown[]) => Component) => {
				component = factory(
					{ terminal: { rows: 40 }, requestRender: () => {} },
					{ fg: (color: string, text: string) => `[${color}]${text}[/]` },
					{ matches: (data: string, name: string) => keyNames[data] === name },
					(choice: unknown) => chosen.push(choice),
				);
				return new Promise(() => {});
			},
		},
	};
	const providers = [
		{ id: "alpha", name: "Alpha" },
		{ id: "beta", name: "Beta" },
		{ id: "delta", name: "Delta" },
		{ id: "gamma", name: "Gamma" },
	] as Provider[];
	void chooseAccountOrModel(ctx as unknown as ExtensionCommandContext, providers, accounts, view);
	if (!component) throw new Error("Chooser did not open");
	return { view: component, chosen, state: view };
}

const row = (name: string, status: "Connected" | "Disconnected") =>
	`${name} (${name.toLowerCase()}) · ${status} · Active account: No named account`;

describe("Accounts chooser", () => {
	it("lists connected providers first, marked like pi's /login, and hides disconnected ones", () => {
		const { view } = accountsView(["alpha", "gamma"]);
		const lines = view.render(200);
		expect(lines).toContain(`[accent]› ✓ ${row("Alpha", "Connected")}[/]`);
		expect(lines).toContain(`  [success]✓ [/]${row("Gamma", "Connected")}`);
		expect(lines).toContain("[muted]  ▸ Show 2 disconnected providers[/]");
		expect(lines.join("\n")).not.toContain("Beta");
		expect(lines.join("\n")).not.toContain("Delta");
	});

	it("expands and collapses disconnected providers from the toggle row, remembering the choice", () => {
		const { view, chosen, state } = accountsView(["alpha"]);
		view.handleInput(down);
		view.handleInput(enter);
		let lines = view.render(200);
		expect(chosen).toEqual([]);
		expect(state.expanded).toBe(true);
		expect(lines).toContain("[accent]› ▾ Hide disconnected providers[/]");
		expect(lines).toContain(`[muted]  • ${row("Beta", "Disconnected")}[/]`);
		expect(lines).toContain(`[muted]  • ${row("Delta", "Disconnected")}[/]`);
		view.handleInput(down);
		view.handleInput(enter);
		expect(chosen).toEqual([{ provider: { id: "beta", name: "Beta" } }]);
		view.handleInput(up);
		view.handleInput(enter);
		lines = view.render(200);
		expect(state.expanded).toBe(false);
		expect(lines.join("\n")).not.toContain("Beta");
	});

	it("opens already expanded when the view remembers it", () => {
		const { view } = accountsView(["alpha"], { section: "Accounts", query: "", scoped: false, expanded: true });
		expect(view.render(200).join("\n")).toContain(row("Beta", "Disconnected"));
	});

	it("flags an active account whose live login changed outside /accounts", () => {
		const changed = { id: "a", name: "Work", provider: "alpha", type: "oauth", active: true, changed: true } as const;
		const { view } = accountsView(["alpha"], undefined, [changed]);
		expect(view.render(200).join("\n")).toContain(
			"Alpha (alpha) · Connected · Active account: Work (login changed outside /accounts)",
		);
	});

	it("finds a hidden disconnected provider by search, without the toggle row", () => {
		const { view } = accountsView(["alpha"]);
		for (const char of "bet") view.handleInput(char);
		const lines = view.render(200);
		expect(lines).toContain(`[accent]› • ${row("Beta", "Disconnected")}[/]`);
		expect(lines.join("\n")).not.toContain("disconnected providers");
	});
});
