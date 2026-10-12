// test/remote-pairing.test.ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PORT, RemoteStore } from "../daemon/remote/pairing.ts";

describe("remote pairing", () => {
	let dir: string;
	let path: string;
	let store: RemoteStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-"));
		path = join(dir, "remote.json");
		store = new RemoteStore(path);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function pairDevice(name = "iPhone"): string {
		const { code } = store.createCode(0);
		const result = store.claim(code, name, 1);
		if (!("token" in result)) throw new Error(result.error);
		return result.token;
	}

	it("starts off, on the default port, with no devices", () => {
		expect(store.load()).toEqual({ enabled: false, port: DEFAULT_PORT, devices: [] });
	});

	it("exchanges a code for a token once, storing only the token's hash, owner-only", () => {
		const { code } = store.createCode(1000);
		expect(code).toMatch(/^\d{6}$/);
		const result = store.claim(code, "iPhone", 2000);
		if (!("token" in result)) throw new Error(result.error);
		expect(store.authenticate(result.token, 3000)?.name).toBe("iPhone");
		expect(store.claim(code, "iPhone", 2500)).toEqual({ error: "invalid_code" });
		expect(readFileSync(path, "utf8")).not.toContain(result.token);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("expires a code after five minutes", () => {
		const { code } = store.createCode(0);
		expect(store.claim(code, "iPhone", 5 * 60_000 + 1)).toEqual({ error: "expired_code" });
	});

	it("invalidates a code after five wrong attempts", () => {
		const { code } = store.createCode(0);
		const wrong = code === "000000" ? "111111" : "000000";
		for (let i = 0; i < 5; i++) expect(store.claim(wrong, "x", 1)).toEqual({ error: "invalid_code" });
		expect(store.claim(code, "x", 1)).toEqual({ error: "invalid_code" });
	});

	it("rejects an empty or unknown token and a revoked device", () => {
		const token = pairDevice();
		expect(store.authenticate("", 2)).toBeUndefined();
		expect(store.authenticate("nope", 2)).toBeUndefined();
		const [device] = store.load().devices;
		expect(store.revoke(device.id)).toBe(true);
		expect(store.authenticate(token, 3)).toBeUndefined();
		expect(store.revoke(device.id)).toBe(false);
	});

	it("names a device that sent no name", () => {
		pairDevice("");
		expect(store.load().devices[0].name).toBe("Phone");
	});

	it("keeps devices and the port when switching on and off", () => {
		pairDevice();
		store.setEnabled(true, 9000);
		expect(store.load()).toMatchObject({ enabled: true, port: 9000 });
		store.setEnabled(false);
		expect(store.load()).toMatchObject({ enabled: false, port: 9000 });
		expect(store.load().devices).toHaveLength(1);
	});

	it("treats a corrupt remote.json as empty", () => {
		store.setEnabled(true);
		writeFileSync(path, "{nope");
		expect(store.load()).toEqual({ enabled: false, port: DEFAULT_PORT, devices: [] });
	});
});
