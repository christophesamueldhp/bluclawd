/**
 * Who may use remote control: paired devices, each holding a random token of which only the
 * SHA-256 hash is kept, in remote.json next to the daemon's socket (owner-only). A device pairs
 * by exchanging a short-lived 6-digit code that `/remote-control` shows; the code lives only in
 * the daemon's memory.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getServerDir } from "../paths.ts";

export const DEFAULT_PORT = 7878;
const CODE_TTL_MS = 5 * 60_000;
const CODE_ATTEMPTS = 5;
/** `lastUsedAt` is rewritten at most this often, not on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface RemoteDevice {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
	lastUsedAt?: string;
}

export interface RemoteState {
	enabled: boolean;
	port: number;
	devices: RemoteDevice[];
}

export type ClaimResult = { token: string; deviceId: string } | { error: "invalid_code" | "expired_code" };

function getRemotePath(): string {
	return join(getServerDir(), "remote.json");
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export class RemoteStore {
	private readonly path: string;
	private code: { value: string; expiresAt: number; attempts: number } | undefined;

	constructor(path: string = getRemotePath()) {
		this.path = path;
	}

	load(): RemoteState {
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RemoteState>;
			return {
				enabled: raw.enabled === true,
				port: Number.isInteger(raw.port) ? (raw.port as number) : DEFAULT_PORT,
				// A hand-edited entry without a token hash would make every authenticate() throw.
				devices: Array.isArray(raw.devices)
					? raw.devices.filter((d) => typeof d?.id === "string" && typeof d.tokenHash === "string")
					: [],
			};
		} catch {
			return { enabled: false, port: DEFAULT_PORT, devices: [] };
		}
	}

	private save(state: RemoteState): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
		renameSync(tmp, this.path);
	}

	setEnabled(enabled: boolean, port?: number): RemoteState {
		const state = this.load();
		state.enabled = enabled;
		if (port !== undefined) state.port = port;
		this.save(state);
		return state;
	}

	/** A new code replaces any earlier one. */
	createCode(now: number = Date.now()): { code: string; expiresAt: number } {
		const value = String(randomInt(0, 1_000_000)).padStart(6, "0");
		this.code = { value, expiresAt: now + CODE_TTL_MS, attempts: 0 };
		return { code: value, expiresAt: this.code.expiresAt };
	}

	claim(code: string, deviceName: string, now: number = Date.now()): ClaimResult {
		const current = this.code;
		if (!current) return { error: "invalid_code" };
		if (now > current.expiresAt) {
			this.code = undefined;
			return { error: "expired_code" };
		}
		if (code !== current.value) {
			current.attempts++;
			if (current.attempts >= CODE_ATTEMPTS) this.code = undefined;
			return { error: "invalid_code" };
		}
		this.code = undefined;
		const token = randomBytes(32).toString("base64url");
		const device: RemoteDevice = {
			id: randomUUID(),
			name: deviceName.trim().slice(0, 60) || "Phone",
			tokenHash: hashToken(token),
			createdAt: new Date(now).toISOString(),
		};
		const state = this.load();
		state.devices.push(device);
		this.save(state);
		return { token, deviceId: device.id };
	}

	authenticate(token: string, now: number = Date.now()): RemoteDevice | undefined {
		if (!token) return undefined;
		const hash = Buffer.from(hashToken(token), "hex");
		const state = this.load();
		const device = state.devices.find((d) => {
			const stored = Buffer.from(d.tokenHash, "hex");
			return stored.length === hash.length && timingSafeEqual(stored, hash);
		});
		if (!device) return undefined;
		const lastUsed = device.lastUsedAt ? Date.parse(device.lastUsedAt) : 0;
		if (now - lastUsed > LAST_USED_RESOLUTION_MS) {
			device.lastUsedAt = new Date(now).toISOString();
			this.save(state);
		}
		return device;
	}

	revoke(deviceId: string): boolean {
		const state = this.load();
		const devices = state.devices.filter((device) => device.id !== deviceId);
		if (devices.length === state.devices.length) return false;
		this.save({ ...state, devices });
		return true;
	}
}
