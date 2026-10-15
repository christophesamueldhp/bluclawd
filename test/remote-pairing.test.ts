// test/remote-pairing.test.ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PORT, RemoteStore } from "../daemon/remote/pairing.ts";
import { validP256dh } from "./support/push.ts";

/** The store's own reads, counted. */
const reads = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (actual) => {
	const fs = await actual<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			reads(args[0]);
			return fs.readFileSync(...args);
		},
	};
});

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

	it("expires a code after ten minutes", () => {
		const { code } = store.createCode(0);
		expect(store.claim(code, "iPhone", 10 * 60_000 + 1)).toEqual({ error: "expired_code" });
		const { code: again } = store.createCode(0);
		expect("token" in store.claim(again, "iPhone", 10 * 60_000)).toBe(true);
	});

	it("pairs by the QR code's secret once, within ten minutes, however many wrong secrets came first", () => {
		const { secret, expiresAt } = store.createCode(0);
		expect(secret).toMatch(/^[\w-]{22}$/);
		expect(expiresAt).toBe(10 * 60_000);
		for (let i = 0; i < 20; i++)
			expect(store.claimSecret(`${i}`.padEnd(22, "x"), "x", 1)).toEqual({ error: "invalid_code" });
		const result = store.claimSecret(secret, "iPhone", 2);
		if (!("token" in result)) throw new Error(result.error);
		expect(store.authenticate(result.token, 3)?.name).toBe("iPhone");
		expect(store.claimSecret(secret, "iPhone", 4)).toEqual({ error: "invalid_code" });
		expect(readFileSync(path, "utf8")).not.toContain(secret);
		const later = store.createCode(0).secret;
		expect(store.claimSecret(later, "iPhone", 10 * 60_000 + 1)).toEqual({ error: "expired_code" });
	});

	it("pairs one device per QR code: the secret and the code end together", () => {
		const first = store.createCode(0);
		expect("token" in store.claimSecret(first.secret, "iPhone", 1)).toBe(true);
		expect(store.claim(first.code, "iPad", 1)).toEqual({ error: "invalid_code" });
		const second = store.createCode(0);
		expect("token" in store.claim(second.code, "iPad", 1)).toBe(true);
		expect(store.claimSecret(second.secret, "iPhone", 1)).toEqual({ error: "invalid_code" });
		expect(store.load().devices.map((d) => d.name)).toEqual(["iPhone", "iPad"]);
	});

	it("keeps the QR code's secret once wrong codes have used up the code's attempts", () => {
		const { code, secret } = store.createCode(0);
		const wrong = code === "000000" ? "111111" : "000000";
		for (let i = 0; i < 5; i++) store.claim(wrong, "x", 1);
		expect(store.claim(code, "x", 1)).toEqual({ error: "invalid_code" });
		expect("token" in store.claimSecret(secret, "iPhone", 1)).toBe(true);
	});

	it("hands a paired device's pairing to its Home Screen app once, as a device of its own, within 30 minutes", () => {
		const token = pairDevice("iPhone");
		const device = store.authenticate(token, 2)!;
		const handoff = store.issueHandoff(device.id, 0);
		expect(handoff).toMatch(/^[\w-]{22}$/);
		expect(store.exchangeHandoff("x".repeat(22), "iPhone (Home Screen)", 1)).toEqual({ error: "invalid_handoff" });
		const result = store.exchangeHandoff(handoff, "iPhone (Home Screen)", 1);
		if (!("token" in result)) throw new Error(result.error);
		expect(store.authenticate(result.token, 2)?.name).toBe("iPhone (Home Screen)");
		expect(store.authenticate(token, 2)?.id).toBe(device.id);
		expect(store.exchangeHandoff(handoff, "iPhone (Home Screen)", 2)).toEqual({ error: "invalid_handoff" });
		expect(readFileSync(path, "utf8")).not.toContain(handoff);
		const late = store.issueHandoff(device.id, 0);
		expect(store.exchangeHandoff(late, "x", 30 * 60_000 + 1)).toEqual({ error: "invalid_handoff" });
	});

	it("gives a device the same handoff until it is used or expires, and none once the device is removed", () => {
		const device = store.authenticate(pairDevice("iPhone"), 2)!;
		const first = store.issueHandoff(device.id, 0);
		expect(store.issueHandoff(device.id, 30 * 60_000)).toBe(first);
		const fresh = store.issueHandoff(device.id, 30 * 60_000 + 1);
		expect(fresh).not.toBe(first);
		expect(store.exchangeHandoff(first, "x", 30 * 60_000 + 2)).toEqual({ error: "invalid_handoff" });
		expect("token" in store.exchangeHandoff(fresh, "x", 30 * 60_000 + 2)).toBe(true);
		const next = store.issueHandoff(device.id, 30 * 60_000 + 3);
		expect(next).not.toBe(fresh);
		store.revoke(device.id);
		expect(store.exchangeHandoff(next, "x", 30 * 60_000 + 4)).toEqual({ error: "invalid_handoff" });
		expect(store.load().devices.map((d) => d.name)).toEqual(["x"]);
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

	it("reads remote.json again only once it changed, its own writes and anyone else's", () => {
		const token = pairDevice("iPhone");
		expect(store.authenticate(token, 2)?.name).toBe("iPhone");
		reads.mockClear();
		for (let i = 0; i < 10; i++) {
			expect(store.authenticate(token, 3)?.name).toBe("iPhone");
			expect(store.load().devices).toHaveLength(1);
		}
		expect(reads.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
		store.setEnabled(true, 9000);
		expect(store.load()).toMatchObject({ enabled: true, port: 9000 });
		// Another writer: a different length, so not hidden by a write in the same millisecond.
		const edited = { ...JSON.parse(readFileSync(path, "utf8")), devices: [], port: 9001 };
		writeFileSync(path, JSON.stringify(edited));
		expect(store.load()).toMatchObject({ enabled: true, port: 9001, devices: [] });
		expect(store.authenticate(token, 4)).toBeUndefined();
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
			p256dh: validP256dh(),
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
