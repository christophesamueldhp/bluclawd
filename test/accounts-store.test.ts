import { execFile } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountStore } from "../ext/accounts/store.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const { AuthStorage } = await import(
	new URL("core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);
const execute = promisify(execFile);
const key = (value: string): Credential => ({ type: "api_key", key: value });
const oauth = (value: string): Credential => ({
	type: "oauth",
	access: `fake-access-${value}`,
	refresh: `fake-refresh-${value}`,
	expires: 1_900_000_000_000,
	accountId: "fake-account",
});

let agentDir: string;
let store: AccountStore;
const authPath = () => join(agentDir, "auth.json");
const vaultPath = () => join(agentDir, "bluclawd", "accounts.json");
const readAuth = () => JSON.parse(readFileSync(authPath(), "utf8"));
const readVault = () => JSON.parse(readFileSync(vaultPath(), "utf8"));
const seedAuth = (auth: Record<string, Credential>) => writeFileSync(authPath(), JSON.stringify(auth), { mode: 0o600 });

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bluclawd-accounts-"));
	store = new AccountStore(agentDir);
});

afterEach(() => {
	vi.mocked(renameSync).mockReset();
	rmSync(agentDir, { recursive: true, force: true });
});

// Restore the real atomic rename for each test, including after injected failures.
beforeEach(async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(renameSync).mockImplementation(actual.renameSync);
});

describe("named provider accounts", () => {
	it("switches two keys for one provider and returns metadata only", async () => {
		const first = await store.add("example", "First", key("fake-first"));
		const second = await store.add("example", "Second", key("fake-second"));
		expect(first).toEqual({
			id: expect.any(String),
			provider: "example",
			name: "First",
			type: "api_key",
			active: false,
		});
		expect(await store.switchTo(first.id)).toEqual({ ...first, active: true });
		expect(readAuth()).toEqual({ example: key("fake-first") });
		await store.switchTo(second.id);
		expect(readAuth()).toEqual({ example: key("fake-second") });
		expect(await store.list()).toEqual([first, { ...second, active: true }]);
		await expect(store.remove(second.id)).rejects.toThrow("active");
		await store.remove(first.id);
		expect(await store.list()).toEqual([{ ...second, active: true }]);
	});

	it("isolates providers and preserves unrelated auth entries", async () => {
		seedAuth({ untouched: key("fake-untouched") });
		const one = await store.add("one", "Work", key("fake-one"));
		const two = await store.add("two", "Work", oauth("two"));
		await store.switchTo(one.id);
		await store.switchTo(two.id);
		expect(readAuth()).toEqual({ untouched: key("fake-untouched"), one: key("fake-one"), two: oauth("two") });
		expect(await store.list("one")).toEqual([{ ...one, active: true }]);
		expect(await store.list("two")).toEqual([{ ...two, active: true }]);
		expect(readVault().active).toEqual({ one: one.id, two: two.id });
	});

	it("imports an unnamed current login only when switching", async () => {
		seedAuth({ example: oauth("original") });
		expect(await store.list()).toEqual([]);
		expect(existsSync(vaultPath())).toBe(false);
		const target = await store.add("example", "Other", key("fake-other"));
		expect(await store.list()).toEqual([target]);
		await store.switchTo(target.id);
		const original = (await store.list()).find((account) => account.name === "Original login");
		expect(original).toMatchObject({ provider: "example", type: "oauth", active: false });
		if (!original) throw new Error("Expected imported original account");
		await store.switchTo(original.id);
		expect(readAuth().example).toEqual(oauth("original"));
		expect(await store.list()).toHaveLength(2);
	});

	it("preserves an original login even when its default name is taken", async () => {
		seedAuth({ example: key("fake-original") });
		const target = await store.add("example", "Original login", key("fake-target"));
		await store.switchTo(target.id);
		expect((await store.list()).map((account) => account.name)).toEqual(["Original login", "Original login (2)"]);
	});

	it("saves raw current credentials without resolving commands or environment", async () => {
		const credential = { type: "api_key" as const, key: "!this-command-must-not-run", env: { FAKE: "$MISSING_ENV" } };
		seedAuth({ example: credential });
		const saved = await store.saveCurrent("example", " Current ");
		expect(saved).toMatchObject({ name: "Current", active: true });
		expect(readVault().accounts[0].credential).toEqual(credential);
		expect(readAuth().example).toEqual(credential);
		await expect(store.saveCurrent("absent", "Missing")).rejects.toThrow("No stored login");
	});

	it("captures a refreshed OAuth credential through AuthStorage.modify before switching", async () => {
		seedAuth({ example: oauth("old") });
		const saved = await store.saveCurrent("example", "Main");
		const other = await store.add("example", "Other", oauth("other"));
		const auth = AuthStorage.create(authPath());
		await auth.modify("example", async () => oauth("refreshed"));
		await store.switchTo(other.id);
		expect(readVault().accounts.find((account: { id: string }) => account.id === saved.id).credential).toEqual(
			oauth("refreshed"),
		);
		await new AccountStore(agentDir).switchTo(saved.id);
		expect(readAuth().example).toEqual(oauth("refreshed"));
		expect(await new AccountStore(agentDir).list()).toEqual([{ ...saved, active: true }, other]);
	});

	it("serializes a switch behind an in-progress OAuth refresh", async () => {
		seedAuth({ example: oauth("old") });
		const saved = await store.saveCurrent("example", "Main");
		const other = await store.add("example", "Other", oauth("other"));
		const auth = AuthStorage.create(authPath());
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let finish: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const refresh = auth.modify("example", async () => {
			entered();
			await barrier;
			return oauth("rotated");
		});
		await started;
		const switching = new AccountStore(agentDir).switchTo(other.id);
		finish();
		await Promise.all([refresh, switching]);
		await store.switchTo(saved.id);
		expect(readAuth().example).toEqual(oauth("rotated"));
	});

	it("renames a tracked login instead of duplicating a rotating OAuth grant", async () => {
		seedAuth({ example: oauth("old") });
		const old = await store.saveCurrent("example", "Old");
		await AuthStorage.create(authPath()).modify("example", async () => oauth("fresh"));
		const fresh = await store.saveCurrent("example", "Fresh");
		expect(fresh.id).toBe(old.id);
		expect(await store.list()).toEqual([fresh]);
		await AuthStorage.create(authPath()).modify("example", async () => oauth("rotated-again"));
		const other = await store.add("example", "Other", oauth("other"));
		await store.switchTo(other.id);
		await store.switchTo(fresh.id);
		expect(readAuth().example).toEqual(oauth("rotated-again"));
	});

	it("does not rename the current login over another account", async () => {
		seedAuth({ example: key("current") });
		const current = await store.saveCurrent("example", "Current");
		const other = await store.add("example", "Other", key("other"));
		await expect(store.saveCurrent("example", "Other")).rejects.toThrow("already exists");
		expect(await store.list()).toEqual([current, other]);
	});

	it("rejects duplicate and invalid names without changing stored state", async () => {
		await store.add("example", "Work", key("fake-key"));
		const before = readFileSync(vaultPath(), "utf8");
		await expect(store.add("example", " Work ", key("fake-other"))).rejects.toThrow("already exists");
		for (const name of ["", "  ", "a".repeat(81), "bad\nname", "bad\u0000name", "bad\u200bname"]) {
			await expect(store.add("example", name, key("fake-key"))).rejects.toThrow("name");
		}
		expect(readFileSync(vaultPath(), "utf8")).toBe(before);
		await store.add("other", "Work", key("fake-other"));
	});

	it.each([
		"not json",
		"null",
		'{"accounts":[],"active":{"example":"missing"}}',
		'{"accounts":[{"id":"x","name":"Work","provider":"example","credential":{"type":"oauth"}}],"active":{}}',
		'{"accounts":{},"active":{}}',
	])("fails closed on corrupt vault: %s", async (content) => {
		seedAuth({ example: key("fake-live") });
		mkdirSync(join(agentDir, "bluclawd"));
		writeFileSync(vaultPath(), content);
		await expect(store.list()).rejects.toThrow();
		await expect(store.add("example", "Work", key("fake-new"))).rejects.toThrow();
		await expect(store.saveCurrent("example", "Work")).rejects.toThrow();
		await expect(store.switchTo("missing")).rejects.toThrow();
		await expect(store.remove("missing")).rejects.toThrow();
		expect(readFileSync(vaultPath(), "utf8")).toBe(content);
		expect(readAuth()).toEqual({ example: key("fake-live") });
	});

	it("writes a private vault and repairs directory permissions on replacement", async () => {
		const account = await store.add("example", "First", key("fake-first"));
		expect(statSync(join(agentDir, "bluclawd")).mode & 0o777).toBe(0o700);
		expect(statSync(vaultPath()).mode & 0o777).toBe(0o600);
		chmodSync(join(agentDir, "bluclawd"), 0o755);
		chmodSync(vaultPath(), 0o644);
		await store.switchTo(account.id);
		expect(statSync(join(agentDir, "bluclawd")).mode & 0o777).toBe(0o700);
		expect(statSync(vaultPath()).mode & 0o777).toBe(0o600);
		expect(statSync(authPath()).mode & 0o777).toBe(0o600);
	});

	it("retains live auth when the snapshot cannot be persisted", async () => {
		seedAuth({ example: oauth("live") });
		const target = await store.add("example", "Other", oauth("other"));
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw new Error("Fake vault write failure");
		});
		await expect(store.switchTo(target.id)).rejects.toThrow("Fake vault write failure");
		expect(readAuth().example).toEqual(oauth("live"));
		expect(await store.list()).toEqual([target]);
	});

	it("retains refreshed snapshots and previous metadata if auth replacement fails", async () => {
		seedAuth({ example: oauth("live") });
		const previous = await store.saveCurrent("example", "Main");
		const target = await store.add("example", "Other", oauth("other"));
		await AuthStorage.create(authPath()).modify("example", async () => oauth("fresh"));
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.mocked(renameSync).mockImplementation((source, destination) => {
			if (destination === authPath()) throw new Error("Fake auth write failure");
			actual.renameSync(source, destination);
		});
		await expect(store.switchTo(target.id)).rejects.toThrow("Fake auth write failure");
		expect(readAuth().example).toEqual(oauth("fresh"));
		expect(readVault().accounts.find((account: { id: string }) => account.id === previous.id).credential).toEqual(
			oauth("fresh"),
		);
		expect(await store.list()).toEqual([previous, target]);
	});

	it("rolls auth back if final active metadata replacement fails", async () => {
		seedAuth({ example: oauth("live") });
		const previous = await store.saveCurrent("example", "Main");
		const target = await store.add("example", "Other", oauth("other"));
		const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
		let vaultWrites = 0;
		vi.mocked(renameSync).mockImplementation((source, destination) => {
			if (destination === vaultPath() && ++vaultWrites === 2) throw new Error("Fake final metadata failure");
			actual.renameSync(source, destination);
		});
		await expect(store.switchTo(target.id)).rejects.toThrow("Fake final metadata failure");
		expect(readAuth().example).toEqual(oauth("live"));
		expect(await store.list()).toEqual([previous, target]);
	});

	it("serializes concurrent switches across independent processes", async () => {
		const accounts = await Promise.all(
			["a", "b", "c"].map((name) => store.add("example", name, key(`fake-${name}`))),
		);
		const moduleUrl = new URL("../ext/accounts/store.ts", import.meta.url).href;
		await Promise.all(
			accounts.map((account) =>
				execute(process.execPath, [
					"--input-type=module",
					"-e",
					`
			const { AccountStore } = await import(${JSON.stringify(moduleUrl)});
			const store = new AccountStore(${JSON.stringify(agentDir)});
			for (let i = 0; i < 3; i++) await store.switchTo(${JSON.stringify(account.id)});
		`,
				]),
			),
		);
		const vault = readVault();
		expect(vault.accounts).toHaveLength(3);
		const active = vault.accounts.find((account: { id: string }) => account.id === vault.active.example);
		expect(readAuth().example).toEqual(active.credential);
		for (const account of vault.accounts) expect(account.credential).toEqual(key(`fake-${account.name}`));
	});
});
