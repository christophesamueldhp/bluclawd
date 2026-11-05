import type { ApiKeyAuth, Credential, OAuthAuth, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../daemon/ansi.ts";
import { loginAccount } from "../ext/accounts/login.ts";
import { waitFor } from "./helpers/wait-for.ts";

beforeAll(() => initTheme("dark"));
const oauth: Credential = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 123 };

function harness(auth: { apiKey?: Partial<ApiKeyAuth>; oauth?: Partial<OAuthAuth> }) {
	let component: (Component & { dispose?(): void }) | undefined;
	const notify = vi.fn();
	const ctx = {
		cwd: "/fixture",
		ui: {
			notify,
			custom: (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) =>
				new Promise((done) => {
					const result = factory(
						{ requestRender: () => {} } as never,
						{ fg: (_color: string, text: string) => text } as never,
						undefined as never,
						done,
					);
					if (result instanceof Promise) throw new Error("Expected a synchronous component factory");
					component = result;
				}),
		},
	};
	const provider = { id: "fixture", name: "Fixture", auth } as unknown as Provider;
	const result = loginAccount(
		ctx as unknown as ExtensionCommandContext,
		provider,
		auth.oauth ? "oauth" : "api_key",
		"/unused",
	);
	return {
		result,
		notify,
		shown: () => component?.render(100).map(stripAnsi).join("\n") ?? "",
		type: (value: string) => component?.handleInput?.(value),
		dispose: () => component?.dispose?.(),
	};
}

describe("account sign-in UI", () => {
	it("masks keys and provider-scoped fields and returns the full provider credential", async () => {
		const h = harness({
			apiKey: {
				login: async ({ prompt }) => {
					const key = await prompt({ type: "secret", message: "API key" });
					const region = await prompt({ type: "text", message: "Region" });
					return { type: "api_key", key, env: { REGION: region } };
				},
			},
		});
		await waitFor(() => h.shown().includes("API key"));
		h.type("fixture-secret-key");
		expect(h.shown()).toContain("•••");
		expect(h.shown()).not.toContain("fixture-secret-key");
		h.type("\r");
		await waitFor(() => h.shown().includes("Region"));
		expect(h.shown()).not.toContain("fixture-secret-key");
		h.type("test-region");
		h.type("\r");
		expect(await h.result).toEqual({ type: "api_key", key: "fixture-secret-key", env: { REGION: "test-region" } });
		expect(JSON.stringify(h.notify.mock.calls)).not.toContain("fixture-secret-key");
		h.dispose();
	});

	it("cancels the entire login with Escape without saving or exposing entered text", async () => {
		let interaction: ProviderAuthInteraction | undefined;
		const h = harness({
			apiKey: {
				login: async (value) => {
					interaction = value;
					return { type: "api_key", key: await value.prompt({ type: "secret", message: "Key" }) };
				},
			},
		});
		await waitFor(() => h.shown().includes("Key"));
		h.type("fixture-cancelled-secret");
		h.type("\x1b");
		expect(await h.result).toBeUndefined();
		expect(interaction?.signal.aborted).toBe(true);
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("allows an OAuth callback to cancel only the manual-code prompt", async () => {
		const callback = new AbortController();
		const h = harness({
			oauth: {
				login: async ({ prompt, signal, notify }) => {
					notify({ type: "auth_url", url: "https://example.invalid/authorize" });
					await prompt({ type: "manual_code", message: "Paste code", signal: callback.signal }).catch(() => {});
					expect(signal.aborted).toBe(false);
					return oauth;
				},
			},
		});
		await waitFor(() => h.shown().includes("Paste code"));
		expect(h.shown()).toContain("https://example.invalid/authorize");
		callback.abort();
		expect(await h.result).toEqual(oauth);
		expect(h.notify).not.toHaveBeenCalled();
		h.dispose();
	});

	it("shows device-login information and supports provider-owned selection prompts", async () => {
		const h = harness({
			oauth: {
				login: async ({ prompt, notify }) => {
					notify({ type: "device_code", verificationUri: "https://example.invalid/device", userCode: "FIXTURE" });
					const choice = await prompt({
						type: "select",
						message: "Choose organization",
						options: [{ id: "org-id", label: "Test org" }],
					});
					expect(choice).toBe("org-id");
					return oauth;
				},
			},
		});
		await waitFor(() => h.shown().includes("Choose organization"));
		expect(h.shown()).toContain("FIXTURE");
		h.type("\r");
		expect(await h.result).toEqual(oauth);
		h.dispose();
	});

	it("does not display provider failures that might contain credentials", async () => {
		const h = harness({
			oauth: {
				login: async () => {
					throw new Error("fixture-secret-response");
				},
			},
		});
		expect(await h.result).toBeUndefined();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Sign-in failed"), "error");
		expect(JSON.stringify(h.notify.mock.calls)).not.toContain("fixture-secret-response");
		h.dispose();
	});
});
