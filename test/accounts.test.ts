import type { Credential, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	add: vi.fn(),
	saveCurrent: vi.fn(),
	switchTo: vi.fn(),
	remove: vi.fn(),
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
