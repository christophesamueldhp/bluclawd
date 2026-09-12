import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, resolveSandboxConfig, strictRefusalReason } from "../ext/sandbox/config.ts";

describe("default denyRead", () => {
	const authPath = join(getAgentDir(), "auth.json");

	it("covers the agent's own credential file", () => {
		expect(resolveSandboxConfig(undefined).filesystem.denyRead).toContain(authPath);
	});

	it("keeps it when the user adds their own denyRead entries", () => {
		const denyRead = resolveSandboxConfig({ filesystem: { denyRead: ["~/secrets"] } }).filesystem.denyRead;
		expect(denyRead).toContain(authPath);
		expect(denyRead).toContain("~/secrets");
	});
});

describe("sandbox.failIfUnavailable resolution", () => {
	it("defaults to the historical unsandboxed fallback", () => {
		expect(DEFAULT_SANDBOX_CONFIG.failIfUnavailable).toBe(false);
		expect(resolveSandboxConfig(undefined).failIfUnavailable).toBe(false);
	});

	it("reads failIfUnavailable from settings", () => {
		expect(resolveSandboxConfig({ enabled: true, failIfUnavailable: true }).failIfUnavailable).toBe(true);
	});

	it("still honours the former name, strict", () => {
		expect(resolveSandboxConfig({ enabled: true, strict: true }).failIfUnavailable).toBe(true);
		expect(resolveSandboxConfig({ enabled: true, strict: true, failIfUnavailable: false }).failIfUnavailable).toBe(
			false,
		);
	});
});

describe("strictRefusalReason", () => {
	const enabledStrict = { enabled: true, failIfUnavailable: true };

	it("refuses when the sandbox was asked for but is not active", () => {
		const reason = strictRefusalReason(enabledStrict, false, "bubblewrap not found");
		expect(reason).toContain("Refusing to run");
		expect(reason).toContain("bubblewrap not found");
	});

	it("still refuses when there is no recorded error to name", () => {
		expect(strictRefusalReason(enabledStrict, false)).toContain("Refusing to run");
	});

	it("allows the call once the sandbox is actually active", () => {
		expect(strictRefusalReason(enabledStrict, true, "stale")).toBeUndefined();
	});

	it("never refuses when failIfUnavailable is off — that is the unsandboxed fallback", () => {
		expect(strictRefusalReason({ enabled: true, failIfUnavailable: false }, false, "boom")).toBeUndefined();
	});

	it("never refuses when the sandbox was not enabled at all", () => {
		expect(strictRefusalReason({ enabled: false, failIfUnavailable: true }, false, "boom")).toBeUndefined();
	});
});
