/**
 * Who may use remote control: paired devices, each holding a random token of which only the
 * SHA-256 hash is kept, in remote.json next to the daemon's socket (owner-only). A device pairs
 * with the secret in the link of the QR code `/remote-control` shows, or the 6-digit code under
 * it; a paired browser hands its pairing to the Home Screen app it adds with a handoff secret.
 * Secrets and codes live only in the daemon's memory.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PaneLaunch } from "../ipc/protocol.ts";
import { getServerDir } from "../paths.ts";
import { generateVapidKeys, parseSubscription, type VapidKeys, type WebPushSubscription } from "./webpush.ts";

export const DEFAULT_PORT = 7878;
const PAIRING_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const HANDOFF_TTL_MS = 30 * 60_000;
/** A pairing or handoff secret: 128 random bits, base64url. */
export const SECRET_PATTERN = /^[\w-]{22}$/;
/** `lastUsedAt` is rewritten at most this often, not on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface RemoteDevice {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
	lastUsedAt?: string;
	/** Where this device's notifications go, once it enabled them. */
	push?: WebPushSubscription;
}

export interface RemoteState {
	enabled: boolean;
	port: number;
	devices: RemoteDevice[];
	/** How the latest pane's pi was started, so the phone can start panes with none running. */
	launch?: PaneLaunch;
	/** The daemon's key pair for signing push requests, made on first use. */
	vapid?: VapidKeys;
}

export type ClaimResult =
	| { token: string; deviceId: string }
	| { error: "invalid_code" | "expired_code" | "invalid_handoff" };

function getRemotePath(): string {
	return join(getServerDir(), "remote.json");
}

function isLaunch(value: unknown): value is PaneLaunch {
	const command = (value as Partial<PaneLaunch> | undefined)?.command;
	return Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string");
}

function isVapid(value: unknown): value is VapidKeys {
	const keys = value as Partial<VapidKeys> | undefined;
	return typeof keys?.publicKey === "string" && typeof keys.privateKey === "string";
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function newSecret(): string {
	return randomBytes(16).toString("base64url");
}

/** Timing-safe whatever was sent: their hashes are the same length. */
function same(sent: string, secret: string): boolean {
	return timingSafeEqual(Buffer.from(hashToken(sent), "hex"), Buffer.from(hashToken(secret), "hex"));
}

export class RemoteStore {
	private readonly path: string;
	/** The QR code's secret and the code under it, both for one device. `code` goes once guessed too often. */
	private pairing: { secret: string; code?: string; expiresAt: number; attempts: number } | undefined;
	/** Each paired device's latest handoff. */
	private readonly handoffs = new Map<string, { secret: string; expiresAt: number }>();

	constructor(path: string = getRemotePath()) {
		this.path = path;
	}

	load(): RemoteState {
		const read = this.readRaw();
		return typeof read === "object" ? read.state : { enabled: false, port: DEFAULT_PORT, devices: [] };
	}

	private readRaw(): { state: RemoteState } | "missing" | "unreadable" {
		let raw: Partial<RemoteState>;
		try {
			raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RemoteState>;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		}
		if (!raw || typeof raw !== "object") return "unreadable";
		return {
			state: {
				enabled: raw.enabled === true,
				port: Number.isInteger(raw.port) ? (raw.port as number) : DEFAULT_PORT,
				// A hand-edited entry without a token hash would make every authenticate() throw.
				devices: Array.isArray(raw.devices)
					? raw.devices
							.filter((d) => typeof d?.id === "string" && typeof d.tokenHash === "string")
							.map(({ push, ...device }) => (parseSubscription(push) ? { ...device, push } : device))
					: [],
				launch: isLaunch(raw.launch) ? raw.launch : undefined,
				vapid: isVapid(raw.vapid) ? raw.vapid : undefined,
			},
		};
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

	/** Written only when it changed. Throws over an unreadable file: only the user's own command resets it. */
	setLaunch(launch: PaneLaunch): void {
		const read = this.readRaw();
		if (read === "unreadable") throw new Error(`${this.path} is unreadable`);
		const state = read === "missing" ? this.load() : read.state;
		if (JSON.stringify(state.launch) === JSON.stringify(launch)) return;
		state.launch = launch;
		this.save(state);
	}

	/** Made on first use. Throws over an unreadable file, as setLaunch does: a phone's request must not reset it. */
	vapidKeys(): VapidKeys {
		const read = this.readRaw();
		if (read === "unreadable") throw new Error(`${this.path} is unreadable`);
		const state = read === "missing" ? this.load() : read.state;
		if (state.vapid) return state.vapid;
		state.vapid = generateVapidKeys();
		this.save(state);
		return state.vapid;
	}

	/** Replaces the device's subscription; undefined drops it. False for an unknown device. */
	setPush(deviceId: string, push: WebPushSubscription | undefined): boolean {
		const state = this.load();
		const device = state.devices.find((d) => d.id === deviceId);
		if (!device) return false;
		if (JSON.stringify(device.push) === JSON.stringify(push)) return true;
		if (push) device.push = push;
		else delete device.push;
		this.save(state);
		return true;
	}

	/** A new secret and code replace any earlier ones. */
	createCode(now: number = Date.now()): { code: string; secret: string; expiresAt: number } {
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		const secret = newSecret();
		this.pairing = { secret, code, expiresAt: now + PAIRING_TTL_MS, attempts: 0 };
		return { code, secret, expiresAt: this.pairing.expiresAt };
	}

	claim(code: string, deviceName: string, now: number = Date.now()): ClaimResult {
		const current = this.pairing;
		if (!current?.code) return { error: "invalid_code" };
		if (now > current.expiresAt) {
			this.pairing = undefined;
			return { error: "expired_code" };
		}
		if (!same(code, current.code)) {
			current.attempts++;
			if (current.attempts >= CODE_ATTEMPTS) current.code = undefined;
			return { error: "invalid_code" };
		}
		this.pairing = undefined;
		return this.addDevice(deviceName, now);
	}

	/** No attempt limit: 128 bits are not guessed. */
	claimSecret(secret: string, deviceName: string, now: number = Date.now()): ClaimResult {
		const current = this.pairing;
		if (!current) return { error: "invalid_code" };
		if (now > current.expiresAt) {
			this.pairing = undefined;
			return { error: "expired_code" };
		}
		if (!same(secret, current.secret)) return { error: "invalid_code" };
		this.pairing = undefined;
		return this.addDevice(deviceName, now);
	}

	/** For the Home Screen app this device's browser adds, which may not share its storage. The same
	 *  one until it expires or is used: iOS keeps the one it read when the app was added. */
	issueHandoff(deviceId: string, now: number = Date.now()): string {
		const current = this.handoffs.get(deviceId);
		if (current && now <= current.expiresAt) return current.secret;
		const secret = newSecret();
		this.handoffs.set(deviceId, { secret, expiresAt: now + HANDOFF_TTL_MS });
		return secret;
	}

	/** A device of its own, so the browser that handed over stays paired. */
	exchangeHandoff(handoff: string, deviceName: string, now: number = Date.now()): ClaimResult {
		for (const [deviceId, entry] of this.handoffs) {
			if (!same(handoff, entry.secret)) continue;
			this.handoffs.delete(deviceId);
			if (now > entry.expiresAt || !this.load().devices.some((d) => d.id === deviceId)) break;
			return this.addDevice(deviceName, now);
		}
		return { error: "invalid_handoff" };
	}

	private addDevice(deviceName: string, now: number): ClaimResult {
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
		this.handoffs.delete(deviceId);
		const state = this.load();
		const devices = state.devices.filter((device) => device.id !== deviceId);
		if (devices.length === state.devices.length) return false;
		this.save({ ...state, devices });
		return true;
	}
}
