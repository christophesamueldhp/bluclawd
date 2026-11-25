/**
 * Web Push with no library: a VAPID token (RFC 8292) and the payload encrypted for the browser
 * (RFC 8291, `aes128gcm` of RFC 8188). The push service (Apple's, for an iPhone) relays it
 * without being able to read it.
 */
import {
	createCipheriv,
	createECDH,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	sign,
} from "node:crypto";

export interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

export interface WebPushSubscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export type PushResult = "ok" | "gone" | "error";

const RECORD_SIZE = 4096;
const TOKEN_LIFETIME_S = 12 * 3600;
const SEND_TIMEOUT_MS = 10_000;
// Push services accept a body of 4096 bytes: the 86-byte header, the plaintext, the delimiter and the 16-byte tag.
const HEADER_SIZE = 86;
const MAX_PLAINTEXT = RECORD_SIZE - HEADER_SIZE - 16 - 1;
const ALLOWED_PUSH_SERVICE_HOSTS =
	/^(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|.*\.notify\.windows\.com)$/;
const BASE64URL = /^[\w-]+=*$/;

function decoded(text: unknown, length: number): Buffer | undefined {
	if (typeof text !== "string" || !BASE64URL.test(text)) return undefined;
	const bytes = Buffer.from(text, "base64url");
	return bytes.length === length ? bytes : undefined;
}

export function parseSubscription(value: unknown): WebPushSubscription | undefined {
	const { endpoint, keys } = (value ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	if (typeof endpoint !== "string" || endpoint.length > 2048) return undefined;
	try {
		const { protocol, hostname } = new URL(endpoint);
		if (protocol !== "https:") return undefined;
		if (!ALLOWED_PUSH_SERVICE_HOSTS.test(hostname)) return undefined;
	} catch {
		return undefined;
	}
	const p256dh = decoded(keys?.p256dh, 65);
	if (!keys || !p256dh || p256dh[0] !== 4 || !decoded(keys.auth, 16)) return undefined;
	try {
		createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: p256dh.subarray(1, 33).toString("base64url"),
				y: p256dh.subarray(33).toString("base64url"),
			},
			format: "jwk",
		});
	} catch {
		return undefined;
	}
	return { endpoint, keys: { p256dh: keys.p256dh as string, auth: keys.auth as string } };
}

export function generateVapidKeys(): VapidKeys {
	const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
	const { x, y, d } = jwk;
	if (!x || !y || !d) throw new Error("a P-256 private key exported as a JWK has x, y and d");
	const point = Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]);
	return { publicKey: point.toString("base64url"), privateKey: d };
}

export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: number): string {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + TOKEN_LIFETIME_S, sub: subject };
	const data = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
	const point = Buffer.from(keys.publicKey, "base64url");
	const key = createPrivateKey({
		key: {
			kty: "EC",
			crv: "P-256",
			d: keys.privateKey,
			x: point.subarray(1, 33).toString("base64url"),
			y: point.subarray(33).toString("base64url"),
		},
		format: "jwk",
	});
	const signature = sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
	return `vapid t=${data}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer | string, length: number): Buffer {
	return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), length));
}

export function encryptPayload(
	plaintext: Buffer,
	p256dh: string,
	auth: string,
	rfc8291TestVector?: { salt: Buffer; privateKey: Buffer },
): Buffer {
	if (plaintext.length > MAX_PLAINTEXT) throw new Error("push payload too large");
	const uaPublic = Buffer.from(p256dh, "base64url");
	const ecdh = createECDH("prime256v1");
	if (rfc8291TestVector) ecdh.setPrivateKey(rfc8291TestVector.privateKey);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const salt = rfc8291TestVector?.salt ?? randomBytes(16);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
	const ikm = hkdf(ecdh.computeSecret(uaPublic), Buffer.from(auth, "base64url"), keyInfo, 32);
	const cek = hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16);
	const nonce = hkdf(ikm, salt, "Content-Encoding: nonce\0", 12);
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()]);
	const header = Buffer.alloc(21);
	salt.copy(header);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header[20] = asPublic.length;
	return Buffer.concat([header, asPublic, record, cipher.getAuthTag()]);
}

export async function sendPush(
	subscription: WebPushSubscription,
	payload: string,
	keys: VapidKeys,
	subject: string,
	fetchImpl: typeof fetch = fetch,
	now: number = Date.now(),
): Promise<PushResult> {
	try {
		const body = encryptPayload(Buffer.from(payload), subscription.keys.p256dh, subscription.keys.auth);
		const res = await fetchImpl(subscription.endpoint, {
			method: "POST",
			headers: {
				authorization: vapidAuthorization(subscription.endpoint, keys, subject, now),
				"content-encoding": "aes128gcm",
				"content-type": "application/octet-stream",
				ttl: "3600",
				urgency: "high",
			},
			body: new Uint8Array(body),
			redirect: "error",
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		// Unread, the body would hold its connection.
		await res.body?.cancel();
		if (res.ok) return "ok";
		return res.status === 404 || res.status === 410 ? "gone" : "error";
	} catch {
		return "error";
	}
}
