import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Credential } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

export interface AccountMetadata {
	id: string;
	name: string;
	provider: string;
	type: Credential["type"];
	active: boolean;
}

interface Account {
	id: string;
	name: string;
	provider: string;
	credential: Credential;
}

interface Vault {
	accounts: Account[];
	active: Record<string, string>;
}

interface AuthBackend {
	withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T }>): Promise<T>;
}

// Resolve from the host: Git-installed extensions have no local copy of Pi to resolve.
const { FileAuthStorageBackend } = (await import(
	pathToFileURL(join(getPackageDir(), "dist/core/auth-storage.js")).href
)) as { FileAuthStorageBackend: new (path: string) => AuthBackend };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCredential(value: unknown): value is Credential {
	if (!isObject(value)) return false;
	if (value.type === "api_key") {
		return (
			(value.key === undefined || typeof value.key === "string") &&
			(value.env === undefined ||
				(isObject(value.env) && Object.values(value.env).every((entry) => typeof entry === "string")))
		);
	}
	return (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function normalizeName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) {
		throw new Error("Account name must be 1–80 characters without control characters");
	}
	return trimmed;
}

function metadata(account: Account, vault: Vault): AccountMetadata {
	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		type: account.credential.type,
		active: vault.active[account.provider] === account.id,
	};
}

function replaceFile(path: string, content: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		try {
			writeFileSync(fd, content, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} catch (error) {
		unlinkSync(temporary);
		throw error;
	}
}

export class AccountStore {
	private readonly backend: AuthBackend;
	private readonly authPath: string;
	private readonly directory: string;
	private readonly vaultPath: string;

	constructor(agentDir: string) {
		this.authPath = join(agentDir, "auth.json");
		this.directory = join(agentDir, "bluclawd");
		this.vaultPath = join(this.directory, "accounts.json");
		this.backend = new FileAuthStorageBackend(this.authPath);
	}

	private readVault(): Vault {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.vaultPath, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [], active: {} };
			throw new Error("Cannot read account vault", { cause: error });
		}
		if (!isObject(raw) || !Array.isArray(raw.accounts) || !isObject(raw.active)) {
			throw new Error("Invalid account vault");
		}
		const ids = new Set<string>();
		const names = new Set<string>();
		for (const account of raw.accounts) {
			if (
				!isObject(account) ||
				typeof account.id !== "string" ||
				!account.id ||
				typeof account.name !== "string" ||
				normalizeName(account.name) !== account.name ||
				typeof account.provider !== "string" ||
				!account.provider ||
				!isCredential(account.credential) ||
				ids.has(account.id) ||
				names.has(JSON.stringify([account.provider, account.name]))
			) {
				throw new Error("Invalid account vault");
			}
			ids.add(account.id);
			names.add(JSON.stringify([account.provider, account.name]));
		}
		const vault = raw as unknown as Vault;
		for (const [provider, id] of Object.entries(vault.active)) {
			if (!vault.accounts.some((account) => account.provider === provider && account.id === id)) {
				throw new Error("Invalid account vault active account");
			}
		}
		return vault;
	}

	private writeVault(vault: Vault): void {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		chmodSync(this.directory, 0o700);
		replaceFile(this.vaultPath, JSON.stringify(vault, null, 2));
	}

	private currentCredential(current: string | undefined, provider: string): Credential | undefined {
		const auth: unknown = JSON.parse((current ?? "{}").replace(/^\uFEFF/, ""));
		if (!isObject(auth)) throw new Error("Invalid auth.json");
		const credential = Object.hasOwn(auth, provider) ? auth[provider] : undefined;
		if (credential !== undefined && !isCredential(credential)) throw new Error("Invalid stored credential");
		return credential;
	}

	private create(vault: Vault, provider: string, name: string, credential: Credential): Account {
		if (!provider.trim()) throw new Error("Provider must not be empty");
		const normalized = normalizeName(name);
		if (vault.accounts.some((account) => account.provider === provider && account.name === normalized)) {
			throw new Error("An account with this name already exists for this provider");
		}
		if (!isCredential(credential)) throw new Error("Invalid account credential");
		const account = { id: randomUUID(), provider, name: normalized, credential: structuredClone(credential) };
		vault.accounts.push(account);
		return account;
	}

	async list(provider?: string): Promise<AccountMetadata[]> {
		return this.backend.withLockAsync(async () => {
			const vault = this.readVault();
			return {
				result: vault.accounts
					.filter((account) => provider === undefined || account.provider === provider)
					.map((account) => metadata(account, vault)),
			};
		});
	}

	async add(provider: string, name: string, credential: Credential): Promise<AccountMetadata> {
		const snapshot = structuredClone(credential);
		return this.backend.withLockAsync(async () => {
			const vault = this.readVault();
			const account = this.create(vault, provider, name, snapshot);
			this.writeVault(vault);
			return { result: metadata(account, vault) };
		});
	}

	async saveCurrent(provider: string, name: string): Promise<AccountMetadata> {
		return this.backend.withLockAsync(async (current) => {
			const vault = this.readVault();
			const credential = this.currentCredential(current, provider);
			if (!credential) throw new Error("No stored login for this provider");
			const previous = vault.accounts.find((account) => account.id === vault.active[provider]);
			if (previous) {
				const normalized = normalizeName(name);
				if (
					vault.accounts.some(
						(account) =>
							account.provider === provider && account.id !== previous.id && account.name === normalized,
					)
				) {
					throw new Error("An account with this name already exists for this provider");
				}
				// A second snapshot of the same OAuth grant would retain a stale rotated refresh token.
				previous.name = normalized;
				previous.credential = credential;
				this.writeVault(vault);
				return { result: metadata(previous, vault) };
			}
			const account = this.create(vault, provider, name, credential);
			vault.active = { ...vault.active, [provider]: account.id };
			this.writeVault(vault);
			return { result: metadata(account, vault) };
		});
	}

	async switchTo(id: string): Promise<AccountMetadata> {
		return this.backend.withLockAsync(async (current) => {
			const vault = this.readVault();
			const target = vault.accounts.find((account) => account.id === id);
			if (!target) throw new Error("Account not found");
			const credential = this.currentCredential(current, target.provider);
			const previous = vault.accounts.find((account) => account.id === vault.active[target.provider]);
			if (previous && credential) previous.credential = credential;
			if (!previous && credential) {
				let name = "Original login";
				let suffix = 2;
				while (vault.accounts.some((account) => account.provider === target.provider && account.name === name)) {
					name = `Original login (${suffix++})`;
				}
				const original = this.create(vault, target.provider, name, credential);
				vault.active = { ...vault.active, [target.provider]: original.id };
			}
			// Persist refreshed tokens before touching live auth; keep this snapshot on failure.
			this.writeVault(vault);
			const auth = { ...JSON.parse((current ?? "{}").replace(/^\uFEFF/, "")), [target.provider]: target.credential };
			replaceFile(this.authPath, JSON.stringify(auth, null, 2));
			vault.active = { ...vault.active, [target.provider]: target.id };
			try {
				this.writeVault(vault);
			} catch (error) {
				try {
					replaceFile(this.authPath, current ?? "{}");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Account switch and auth rollback failed");
				}
				throw error;
			}
			return { result: metadata(target, vault) };
		});
	}

	async remove(id: string): Promise<void> {
		return this.backend.withLockAsync(async () => {
			const vault = this.readVault();
			const account = vault.accounts.find((entry) => entry.id === id);
			if (!account) throw new Error("Account not found");
			if (vault.active[account.provider] === id) throw new Error("Cannot remove an active account");
			vault.accounts = vault.accounts.filter((entry) => entry.id !== id);
			this.writeVault(vault);
			return { result: undefined };
		});
	}
}
