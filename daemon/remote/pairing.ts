import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripAnsi } from "../ansi.ts";
import type { PaneLaunch } from "../ipc/protocol.ts";
import { getServerDir } from "../paths.ts";
import { generateVapidKeys, parseSubscription, type VapidKeys, type WebPushSubscription } from "./webpush.ts";

export const DEFAULT_PORT = 7878;
const PAIRING_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const DEVICE_NAME_MAX = 64;
const LAST_USED_RESOLUTION_MS = 60_000;

export interface RemoteDevice {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
	lastUsedAt?: string;
	push?: WebPushSubscription;
}

export interface RemoteState {
	enabled: boolean;
	port: number;
	devices: RemoteDevice[];
	launch?: PaneLaunch;
	vapid?: VapidKeys;
}

export type ClaimResult = { token: string; deviceId: string } | { error: "invalid_code" | "code_attempts_exhausted" };

function getRemotePath(): string {
	return join(getServerDir(), "remote.json");
}

function isLaunch(value: unknown): value is PaneLaunch {
	const command = (value as Partial<PaneLaunch> | undefined)?.command;
	return Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string");
}

function isDevice(value: unknown): value is RemoteDevice {
	const device = value as Partial<RemoteDevice> | undefined;
	return typeof device?.id === "string" && typeof device.tokenHash === "string";
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

function cleanDeviceName(value: unknown): string {
	const name = typeof value === "string" ? value : "";
	const clean = stripAnsi(name)
		.replace(/\p{Cc}/gu, "")
		.trim();
	return [...clean].slice(0, DEVICE_NAME_MAX).join("").trimEnd() || "Phone";
}

/** Timing-safe whatever was sent, because their hashes are the same length. */
function same(sent: string, secret: string): boolean {
	return timingSafeEqual(Buffer.from(hashToken(sent), "hex"), Buffer.from(hashToken(secret), "hex"));
}

export class RemoteStore {
	private readonly path: string;
	private pairing: { secret: string; code?: string; expiresAt: number; attempts: number } | undefined;
	private cached: { key: string; state: RemoteState; byToken?: Map<string, RemoteDevice> } | undefined;

	constructor(path: string = getRemotePath()) {
		this.path = path;
	}

	load(): Readonly<RemoteState> {
		return this.edit();
	}

	private edit(): RemoteState {
		const read = this.readRaw();
		return typeof read === "object" ? read.state : { enabled: false, port: DEFAULT_PORT, devices: [] };
	}

	private editWithoutResetting(): RemoteState {
		const read = this.readRaw();
		if (read === "unreadable") throw new Error(`${this.path} is unreadable`);
		return read === "missing" ? this.edit() : read.state;
	}

	private forgetParsed(): void {
		this.cached = undefined;
	}

	private readRaw(): { state: RemoteState } | "missing" | "unreadable" {
		let key: string;
		try {
			const stat = statSync(this.path);
			key = `${stat.size}:${stat.mtimeMs}`;
		} catch (error) {
			this.forgetParsed();
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		}
		if (this.cached?.key === key) return { state: this.cached.state };
		this.forgetParsed();
		let raw: Partial<RemoteState>;
		try {
			raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RemoteState>;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
		}
		if (!raw || typeof raw !== "object") return "unreadable";
		const state: RemoteState = {
			enabled: raw.enabled === true,
			port: Number.isInteger(raw.port) ? (raw.port as number) : DEFAULT_PORT,
			devices: Array.isArray(raw.devices)
				? raw.devices.filter(isDevice).map(({ name, push, ...device }) => ({
						...device,
						name: cleanDeviceName(name),
						...(parseSubscription(push) ? { push } : {}),
					}))
				: [],
			launch: isLaunch(raw.launch) ? raw.launch : undefined,
			vapid: isVapid(raw.vapid) ? raw.vapid : undefined,
		};
		this.cached = { key, state };
		return { state };
	}

	private save(state: RemoteState): void {
		this.forgetParsed();
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
		renameSync(tmp, this.path);
	}

	setEnabled(enabled: boolean, port?: number): RemoteState {
		const state = this.edit();
		state.enabled = enabled;
		if (port !== undefined) state.port = port;
		this.save(state);
		return state;
	}

	setLaunch(launch: PaneLaunch): void {
		const state = this.editWithoutResetting();
		if (JSON.stringify(state.launch) === JSON.stringify(launch)) return;
		state.launch = launch;
		this.save(state);
	}

	vapidKeys(): VapidKeys {
		const state = this.editWithoutResetting();
		if (state.vapid) return state.vapid;
		state.vapid = generateVapidKeys();
		this.save(state);
		return state.vapid;
	}

	setPush(deviceId: string, push: WebPushSubscription | undefined): boolean {
		const state = this.edit();
		const device = state.devices.find((d) => d.id === deviceId);
		if (!device) return false;
		if (JSON.stringify(device.push) === JSON.stringify(push)) return true;
		if (push) device.push = push;
		else delete device.push;
		this.save(state);
		return true;
	}

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
			return { error: "invalid_code" };
		}
		if (!same(code, current.code)) {
			current.attempts++;
			if (current.attempts >= CODE_ATTEMPTS) {
				current.code = undefined;
				return { error: "code_attempts_exhausted" };
			}
			return { error: "invalid_code" };
		}
		this.pairing = undefined;
		return this.addDevice(deviceName, now);
	}

	claimSecret(secret: string, deviceName: string, now: number = Date.now()): ClaimResult {
		const current = this.pairing;
		if (!current) return { error: "invalid_code" };
		if (now > current.expiresAt) {
			this.pairing = undefined;
			return { error: "invalid_code" };
		}
		if (!same(secret, current.secret)) return { error: "invalid_code" };
		this.pairing = undefined;
		return this.addDevice(deviceName, now);
	}

	private addDevice(deviceName: string, now: number): ClaimResult {
		const token = randomBytes(32).toString("base64url");
		const device: RemoteDevice = {
			id: randomUUID(),
			name: cleanDeviceName(deviceName),
			tokenHash: hashToken(token),
			createdAt: new Date(now).toISOString(),
		};
		const state = this.edit();
		state.devices.push(device);
		this.save(state);
		return { token, deviceId: device.id };
	}

	authenticate(token: string, now: number = Date.now()): RemoteDevice | undefined {
		if (!token) return undefined;
		const state = this.edit();
		const device = this.devicesByTokenHash(state).get(hashToken(token));
		if (!device) return undefined;
		const lastUsed = device.lastUsedAt ? Date.parse(device.lastUsedAt) : 0;
		if (now - lastUsed > LAST_USED_RESOLUTION_MS) {
			device.lastUsedAt = new Date(now).toISOString();
			this.save(state);
		}
		return device;
	}

	private devicesByTokenHash(state: RemoteState): Map<string, RemoteDevice> {
		const cached = this.cached?.state === state ? this.cached : undefined;
		const byToken = cached?.byToken ?? new Map(state.devices.map((d) => [d.tokenHash, d]));
		if (cached) cached.byToken = byToken;
		return byToken;
	}

	revoke(deviceId: string): boolean {
		const state = this.load();
		const devices = state.devices.filter((device) => device.id !== deviceId);
		if (devices.length === state.devices.length) return false;
		this.saveRevocation({ ...state, devices });
		return true;
	}

	revokeAll(): void {
		const state = this.editWithoutResetting();
		this.saveRevocation({ ...state, devices: [] });
	}

	private saveRevocation(state: RemoteState): void {
		this.save(state);
		this.pairing = undefined;
	}
}
