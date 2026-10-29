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

/** base64url: `publicKey` the uncompressed P-256 point, `privateKey` the JWK `d`. */
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
// The daemon posts to this URL, so it must be a push service and not an address on the Mac's network.
const PUSH_HOSTS = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"];
const BASE64URL = /^[\w-]+=*$/;

function decoded(text: unknown, length: number): Buffer | undefined {
	if (typeof text !== "string" || !BASE64URL.test(text)) return undefined;
	const bytes = Buffer.from(text, "base64url");
	return bytes.length === length ? bytes : undefined;
}

/** What a browser's `PushSubscription.toJSON()` gives, or undefined if it is not one. */
export function parseSubscription(value: unknown): WebPushSubscription | undefined {
	const { endpoint, keys } = (value ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	if (typeof endpoint !== "string" || endpoint.length > 2048) return undefined;
	try {
		const { protocol, hostname } = new URL(endpoint);
		if (protocol !== "https:") return undefined;
		if (!PUSH_HOSTS.includes(hostname) && !hostname.endsWith(".notify.windows.com")) return undefined;
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
	const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
	return { publicKey: point.toString("base64url"), privateKey: jwk.d! };
}

/** The `Authorization` header for a push to `endpoint`. */
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

/**
 * One record, and the whole request must stay within the 4096 bytes every push service accepts. `fixed` replaces the random salt and the
 * ephemeral key, for RFC 8291's test vector only.
 */
export function encryptPayload(
	plaintext: Buffer,
	p256dh: string,
	auth: string,
	fixed?: { salt: Buffer; privateKey: Buffer },
): Buffer {
	if (plaintext.length > MAX_PLAINTEXT) throw new Error("push payload too large");
	const uaPublic = Buffer.from(p256dh, "base64url");
	const ecdh = createECDH("prime256v1");
	if (fixed) ecdh.setPrivateKey(fixed.privateKey);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const salt = fixed?.salt ?? randomBytes(16);
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

/** "gone": the push service no longer knows this subscription, which should be dropped. */
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
