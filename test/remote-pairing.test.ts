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
		writeFileSync(path, JSON.stringify({ enabled: true, devices: [null, { id: "x" }] }));
		expect(store.load().devices).toEqual([]);
		expect(store.authenticate("anything", 1)).toBeUndefined();
		writeFileSync(path, "{nope");
		expect(store.load()).toEqual({ enabled: false, port: DEFAULT_PORT, devices: [] });
	});

	it("keeps a corrupt remote.json from a heartbeat's launch, and writes one where there is none", () => {
		const launch = { command: ["node", "pi.js"] };
		writeFileSync(path, "{nope");
		expect(() => store.setLaunch(launch)).toThrow();
		expect(readFileSync(path, "utf8")).toBe("{nope");
		store.setEnabled(false);
		store.setLaunch(launch);
		expect(store.load().launch).toEqual(launch);
		rmSync(path);
		store.setLaunch(launch);
		expect(store.load().launch).toEqual(launch);
	});

	const subscription = (endpoint = "https://web.push.apple.com/abc") => ({
		endpoint,
		keys: {
			p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url"),
			auth: "AAAAAAAAAAAAAAAAAAAAAA",
		},
	});

	it("makes the VAPID keys once and keeps them", () => {
		const keys = store.vapidKeys();
		expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
		expect(new RemoteStore(path).vapidKeys()).toEqual(keys);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("does not replace an unreadable remote.json to make VAPID keys", () => {
		writeFileSync(path, "{nope");
		expect(() => store.vapidKeys()).toThrow();
		expect(readFileSync(path, "utf8")).toBe("{nope");
	});

	it("keeps one push subscription per device, dropped with the device", () => {
		pairDevice("iPhone");
		pairDevice("iPad");
		const [phone, pad] = store.load().devices;
		expect(store.setPush(phone.id, subscription("https://web.push.apple.com/1"))).toBe(true);
		expect(store.setPush(phone.id, subscription("https://web.push.apple.com/2"))).toBe(true);
		expect(store.setPush(pad.id, subscription("https://web.push.apple.com/3"))).toBe(true);
		expect(store.setPush("nope", subscription())).toBe(false);
		expect(store.load().devices.map((d) => d.push?.endpoint)).toEqual([
			"https://web.push.apple.com/2",
			"https://web.push.apple.com/3",
		]);
		store.setPush(pad.id, undefined);
		expect(store.load().devices[1]).not.toHaveProperty("push");
		store.revoke(phone.id);
		expect(store.load().devices.some((d) => d.push)).toBe(false);
	});

	it("drops a malformed push subscription from remote.json", () => {
		pairDevice();
		const raw = JSON.parse(readFileSync(path, "utf8"));
		raw.devices[0].push = { endpoint: "http://insecure.test", keys: { p256dh: "x", auth: "y" } };
		writeFileSync(path, JSON.stringify(raw));
		expect(store.load().devices[0]).not.toHaveProperty("push");
	});
});
