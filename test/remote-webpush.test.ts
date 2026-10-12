import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	encryptPayload,
	generateVapidKeys,
	sendPush,
	vapidAuthorization,
	type WebPushSubscription,
} from "../daemon/remote/webpush.ts";

const b64 = (bytes: Buffer) => bytes.toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");

/** A browser's side of RFC 8291 / RFC 8188 (one record), written independently of webpush.ts. */
function decrypt(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
	const salt = body.subarray(0, 16);
	expect(body.readUInt32BE(16)).toBe(4096);
	const idlen = body[20];
	expect(idlen).toBe(65);
	const asPublic = body.subarray(21, 21 + idlen);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(uaPrivate);
	const uaPublic = ecdh.getPublicKey();
	const secret = ecdh.computeSecret(asPublic);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
	const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
	const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
	const record = body.subarray(21 + idlen);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(record.subarray(record.length - 16));
	const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
	// The last record ends in 0x02 then zero padding.
	let end = padded.length - 1;
	while (padded[end] === 0) end--;
	expect(padded[end]).toBe(2);
	return padded.subarray(0, end);
}

function receiver(): { subscription: WebPushSubscription; privateKey: Buffer; auth: Buffer } {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = randomBytes(16);
	return {
		subscription: {
			endpoint: "https://push.example.test/send/abc?x=1",
			keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) },
		},
		privateKey: ecdh.getPrivateKey(),
		auth,
	};
}

describe("web push", () => {
	it("encrypts a payload the subscribed browser can decrypt", () => {
		const { subscription, privateKey, auth } = receiver();
		const body = encryptPayload(Buffer.from('{"title":"pi"}'), subscription.keys.p256dh, subscription.keys.auth);
		expect(decrypt(body, privateKey, auth).toString()).toBe('{"title":"pi"}');
		const again = encryptPayload(Buffer.from('{"title":"pi"}'), subscription.keys.p256dh, subscription.keys.auth);
		expect(again.subarray(0, 16).equals(body.subarray(0, 16))).toBe(false);
	});

	it("matches RFC 8291's worked example given its salt and server key", () => {
		const uaPrivate = unb64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
		const ua = createECDH("prime256v1");
		ua.setPrivateKey(uaPrivate);
		expect(b64(ua.getPublicKey())).toBe(
			"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		);
		const body = encryptPayload(
			unb64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
			b64(ua.getPublicKey()),
			"BTBZMqHH6r4Tts7J_aSIgg",
			{ salt: unb64("DGv6ra1nlYgDCS1FRnbzlw"), privateKey: unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
		);
		expect(b64(body)).toBe(
			"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
				"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
				"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
		);
		expect(decrypt(body, uaPrivate, unb64("BTBZMqHH6r4Tts7J_aSIgg")).toString()).toBe(
			"When I grow up, I want to be a watermelon",
		);
	});

	it("signs a VAPID token for the push service's origin, valid for 12 hours", () => {
		const keys = generateVapidKeys();
		const publicKey = unb64(keys.publicKey);
		expect(publicKey).toHaveLength(65);
		expect(publicKey[0]).toBe(4);
		const now = Date.UTC(2026, 9, 13);
		const header = vapidAuthorization(
			"https://web.push.apple.com/abc/def",
			keys,
			"https://github.com/christophesamueldhp/bluclawd",
			now,
		);
		const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
		if (!match) throw new Error(header);
		const [, head, claims, signature, k] = match;
		expect(k).toBe(keys.publicKey);
		expect(JSON.parse(unb64(head).toString())).toEqual({ typ: "JWT", alg: "ES256" });
		expect(JSON.parse(unb64(claims).toString())).toEqual({
			aud: "https://web.push.apple.com",
			exp: now / 1000 + 12 * 3600,
			sub: "https://github.com/christophesamueldhp/bluclawd",
		});
		const key = createPublicKey({
			key: { kty: "EC", crv: "P-256", x: b64(publicKey.subarray(1, 33)), y: b64(publicKey.subarray(33)) },
			format: "jwk",
		});
		const data = Buffer.from(`${head}.${claims}`);
		expect(unb64(signature)).toHaveLength(64);
		expect(verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, unb64(signature))).toBe(true);
		expect(verify("sha256", Buffer.from("tampered"), { key, dsaEncoding: "ieee-p1363" }, unb64(signature))).toBe(
			false,
		);
	});

	it("posts the encrypted payload with the push headers, and maps the service's answer", async () => {
		const keys = generateVapidKeys();
		const { subscription, privateKey, auth } = receiver();
		const calls: Array<{ url: string; init: RequestInit }> = [];
		let status = 201;
		const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return new Response(null, { status });
		};
		expect(await sendPush(subscription, "hello", keys, "https://example.test", fetchImpl)).toBe("ok");
		const [{ url, init }] = calls;
		expect(url).toBe(subscription.endpoint);
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers).toMatchObject({
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: "3600",
			urgency: "high",
		});
		expect(headers.authorization).toMatch(/^vapid t=.+, k=/);
		expect(decrypt(Buffer.from(init.body as Uint8Array), privateKey, auth).toString()).toBe("hello");
		status = 410;
		expect(await sendPush(subscription, "hello", keys, "https://example.test", fetchImpl)).toBe("gone");
		status = 404;
		expect(await sendPush(subscription, "hello", keys, "https://example.test", fetchImpl)).toBe("gone");
		status = 500;
		expect(await sendPush(subscription, "hello", keys, "https://example.test", fetchImpl)).toBe("error");
		const offline = async () => {
			throw new TypeError("fetch failed");
		};
		expect(await sendPush(subscription, "hello", keys, "https://example.test", offline)).toBe("error");
		const broken = { ...subscription, keys: { ...subscription.keys, p256dh: b64(Buffer.alloc(65, 4)) } };
		expect(await sendPush(broken, "hello", keys, "https://example.test", fetchImpl)).toBe("error");
	});
});
