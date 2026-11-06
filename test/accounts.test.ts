import type { Credential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	add: vi.fn(),
	saveCurrent: vi.fn(),
	switchTo: vi.fn(),
	remove: vi.fn(),
	rename: vi.fn(),
	replaceCredential: vi.fn(),
	login: vi.fn(),
	tasks: vi.fn(),
}));
vi.mock("../ext/accounts/store.ts", () => ({
	AccountStore: class {
		list = mocks.list;
		add = mocks.add;
		saveCurrent = mocks.saveCurrent;
		switchTo = mocks.switchTo;
		remove = mocks.remove;
		rename = mocks.rename;
		replaceCredential = mocks.replaceCredential;
	},
}));
vi.mock("../ext/accounts/login.ts", () => ({ loginAccount: mocks.login }));
vi.mock("../ext/_shared/agent-tasks.ts", () => ({ agentTasks: mocks.tasks }));

import accounts from "../ext/accounts/index.ts";

const personal = { id: "one", name: "Personal", provider: "example", type: "api_key", active: true };
const work = { id: "two", name: "Work", provider: "example", type: "api_key", active: false };
const provider = {
	id: "example",
	name: "Example",
	auth: {
		apiKey: { name: "Example API key", login: vi.fn() },
		oauth: { name: "Example subscription", login: vi.fn() },
	},
} as unknown as Provider;

function harness(choices: (string | undefined)[] = []) {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	accounts({
		registerCommand: (_name: string, command: { handler: typeof handler }) => {
			handler = command.handler;
		},
	} as unknown as ExtensionAPI);
	const ctx = {
		hasUI: true,
		mode: "tui" as "tui" | "rpc",
		cwd: "/test",
		isIdle: vi.fn(() => true),
		ui: {
			select: vi.fn(async () => choices.shift()),
			input: vi.fn(async () => "New account"),
			confirm: vi.fn(async () => true),
			custom: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
		modelRegistry: {
			getAll: () => [{ provider: "example" }],
			getRegisteredProviderIds: () => ["example"],
			getProvider: (id: string) => (id === "example" ? provider : undefined),
			getAvailable: () => [],
			refresh: vi.fn(async () => ({ errors: new Map(), aborted: false })),
		},
	};
	return {
		ctx,
		run: async (args = "example") => {
			if (!handler) throw new Error("Command not registered");
			await handler(args, ctx as unknown as ExtensionCommandContext);
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue([personal, work]);
	mocks.add.mockResolvedValue({ id: "three" });
	mocks.login.mockResolvedValue({ type: "api_key", key: "fixture-key" } satisfies Credential);
	mocks.tasks.mockReturnValue(undefined);
});

describe("/accounts", () => {
	it("lists extension providers and opens the selected provider in RPC", async () => {
		const { ctx, run } = harness(["Example (example)", "Back"]);
		ctx.mode = "rpc";
		await run("");
		expect(ctx.ui.select.mock.calls[0]).toEqual(["Accounts — choose a provider", ["Example (example)"]]);
		expect(mocks.list).toHaveBeenCalledWith("example");
	});

	it("switches a saved account and refreshes that provider without replacing the conversation", async () => {
		const { ctx, run } = harness(["Work · API key"]);
		await run();
		expect(mocks.switchTo).toHaveBeenCalledWith("two");
		expect(ctx.modelRegistry.refresh).toHaveBeenCalledWith({
			providers: ["example"],
			allowNetwork: true,
			force: true,
		});
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Model and conversation unchanged"), "info");
	});

	it("saves the current login under a user-provided name", async () => {
		const { run } = harness(["Save current login…", "Back"]);
		await run();
		expect(mocks.saveCurrent).toHaveBeenCalledWith("example", "New account");
		expect(mocks.login).not.toHaveBeenCalled();
	});

	it("adds an API key using the provider login and activates it only after success", async () => {
		const { run } = harness(["Add account…", "Sign in with an API key"]);
		await run();
		expect(mocks.login).toHaveBeenCalledWith(expect.anything(), provider, "api_key", expect.any(String));
		expect(mocks.add).toHaveBeenCalledWith("example", "New account", { type: "api_key", key: "fixture-key" });
		expect(mocks.switchTo).toHaveBeenCalledWith("three");
	});

	it("uses the same account workflow for OAuth", async () => {
		const { run } = harness(["Add account…", "Sign in with OAuth"]);
		await run();
		expect(mocks.login).toHaveBeenCalledWith(expect.anything(), provider, "oauth", expect.any(String));
	});

	it("does not mutate accounts when sign-in is cancelled", async () => {
		mocks.login.mockResolvedValue(undefined);
		const { run } = harness(["Add account…", "Sign in with OAuth", "Back"]);
		await run();
		expect(mocks.add).not.toHaveBeenCalled();
		expect(mocks.switchTo).not.toHaveBeenCalled();
	});

	it("confirms removal and only offers inactive accounts", async () => {
		const { ctx, run } = harness(["Remove saved account…", "Work", "Back"]);
		await run();
		expect(ctx.ui.select.mock.calls[1]).toEqual(["Remove which saved account?", ["Work"]]);
		expect(ctx.ui.confirm).toHaveBeenCalled();
		expect(mocks.remove).toHaveBeenCalledWith("two");
	});

	it("leaves accounts intact when removal is declined", async () => {
		const { ctx, run } = harness(["Remove saved account…", "Work", "Back"]);
		ctx.ui.confirm.mockResolvedValue(false);
		await run();
		expect(mocks.remove).not.toHaveBeenCalled();
	});

	it("renames a saved account, allowing it to keep its own name but not take another", async () => {
		const { ctx, run } = harness([
			"Edit saved account…",
			"Work",
			"Rename…",
			"Edit saved account…",
			"Work",
			"Rename…",
			"Back",
		]);
		ctx.ui.input.mockResolvedValueOnce(" Office ").mockResolvedValueOnce("Personal");
		await run();
		expect(ctx.ui.select.mock.calls[1]).toEqual(["Edit which saved account?", ["Personal", "Work"]]);
		expect(mocks.rename).toHaveBeenCalledTimes(1);
		expect(mocks.rename).toHaveBeenCalledWith("two", "Office");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("unique account name"), "warning");
	});

	it("signs an inactive account in again without switching or refreshing", async () => {
		const { ctx, run } = harness(["Edit saved account…", "Work", "Sign in again…", "Sign in with OAuth", "Back"]);
		await run();
		expect(mocks.login).toHaveBeenCalledWith(expect.anything(), provider, "oauth", expect.any(String));
		expect(mocks.replaceCredential).toHaveBeenCalledWith("two", { type: "api_key", key: "fixture-key" });
		expect(mocks.switchTo).not.toHaveBeenCalled();
		expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
	});

	it("refreshes models after signing the active account in again", async () => {
		const { ctx, run } = harness([
			"Edit saved account…",
			"Personal",
			"Sign in again…",
			"Sign in with an API key",
			"Back",
		]);
		await run();
		expect(mocks.replaceCredential).toHaveBeenCalledWith("one", { type: "api_key", key: "fixture-key" });
		expect(ctx.modelRegistry.refresh).toHaveBeenCalledWith({
			providers: ["example"],
			allowNetwork: true,
			force: true,
		});
	});

	it("keeps the saved login when signing in again is cancelled or outside the terminal UI", async () => {
		mocks.login.mockResolvedValue(undefined);
		const { ctx, run } = harness(["Edit saved account…", "Work", "Sign in again…", "Sign in with OAuth", "Back"]);
		await run();
		const rpc = harness(["Edit saved account…", "Work", "Sign in again…", "Back"]);
		rpc.ctx.mode = "rpc";
		await rpc.run();
		expect(mocks.login).toHaveBeenCalledTimes(1);
		expect(mocks.replaceCredential).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(rpc.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("terminal UI"), "warning");
	});

	it("labels accounts with their email and flags a live login changed outside /accounts", async () => {
		mocks.list.mockResolvedValue([
			{ ...personal, type: "oauth", email: "me@example.com", changed: true },
			{ ...work, type: "oauth", email: "work@example.com" },
		]);
		const { ctx, run } = harness(["Back"]);
		await run();
		expect(ctx.ui.select.mock.calls[0]).toEqual([
			"Example accounts",
			expect.arrayContaining([
				"✓ Personal · OAuth · me@example.com · login changed outside /accounts",
				"Work · OAuth · work@example.com",
			]),
		]);
	});

	it("does not offer editing when no account is saved", async () => {
		mocks.list.mockResolvedValue([]);
		const { ctx, run } = harness(["Back"]);
		await run();
		expect(JSON.stringify(ctx.ui.select.mock.calls)).not.toContain("Edit saved account");
	});

	it("rejects changes while the parent or a background subagent is running", async () => {
		const { ctx, run } = harness();
		ctx.isIdle.mockReturnValue(false);
		await run();
		ctx.isIdle.mockReturnValue(true);
		mocks.tasks.mockReturnValue({ list: () => [{ state: "running" }] });
		await run();
		expect(mocks.list).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
	});

	it("rechecks idleness after the user chooses an account", async () => {
		const { ctx, run } = harness(["Work · API key"]);
		ctx.isIdle.mockReturnValueOnce(true).mockReturnValue(false);
		await run();
		expect(mocks.switchTo).not.toHaveBeenCalled();
	});

	it("reports model refresh failure without undoing a successful credential switch", async () => {
		const { ctx, run } = harness(["Work · API key"]);
		ctx.modelRegistry.refresh.mockRejectedValue(new Error("fixture"));
		await run();
		expect(mocks.switchTo).toHaveBeenCalledWith("two");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/reload"), "warning");
	});

	it("never includes credential error payloads in notifications", async () => {
		mocks.switchTo.mockRejectedValueOnce(new Error("secret-fixture-token"));
		const { ctx, run } = harness(["Work · API key"]);
		await run();
		expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain("secret-fixture-token");
	});
});
