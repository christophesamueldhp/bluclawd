import { createECDH } from "node:crypto";

export function validP256dh(): string {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return ecdh.getPublicKey().toString("base64url");
}
