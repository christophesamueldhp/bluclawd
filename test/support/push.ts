import { createECDH } from "node:crypto";

/** A p256dh a browser could have made: a point on the P-256 curve. */
export function validP256dh(): string {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return ecdh.getPublicKey().toString("base64url");
}
