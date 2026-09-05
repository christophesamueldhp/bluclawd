import { describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_CONFIG, resolveSandboxConfig, strictRefusalReason } from "../ext/sandbox/config.ts";

describe("sandbox.strict resolution", () => {
	it("defaults to the historical unsandboxed fallback", () => {
		expect(DEFAULT_SANDBOX_CONFIG.strict).toBe(false);
		expect(resolveSandboxConfig(undefined).strict).toBe(false);
	});

	it("reads strict from settings", () => {
		expect(resolveSandboxConfig({ enabled: true, strict: true }).strict).toBe(true);
	});
});

describe("strictRefusalReason", () => {
	const enabledStrict = { enabled: true, strict: true };

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

	it("never refuses when strict is off — that is the unsandboxed fallback", () => {
		expect(strictRefusalReason({ enabled: true, strict: false }, false, "boom")).toBeUndefined();
	});

	it("never refuses when the sandbox was not enabled at all", () => {
		expect(strictRefusalReason({ enabled: false, strict: true }, false, "boom")).toBeUndefined();
	});
});
