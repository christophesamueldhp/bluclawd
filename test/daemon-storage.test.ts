import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getInstancesPath } from "../daemon/config.ts";
import { loadInstances, saveInstances } from "../daemon/storage.ts";

describe("instances.json storage", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-orch-storage-"));
	});

	it("returns [] for a corrupt/half-written instances.json instead of throwing", () => {
		writeFileSync(getInstancesPath(dir), "{ this is not json");
		// Must not throw — a corrupt file would otherwise brick every daemon op incl. startup recover.
		expect(loadInstances(dir)).toEqual([]);
	});

	it("returns [] when the JSON is valid but not an array", () => {
		writeFileSync(getInstancesPath(dir), '{"not":"an array"}');
		expect(loadInstances(dir)).toEqual([]);
	});

	it("tightens permissions on an existing server directory before writing", () => {
		chmodSync(dir, 0o755);
		saveInstances(dir, []);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	it("round-trips saved instances and leaves no .tmp file behind (atomic write)", () => {
		saveInstances(dir, [
			{ id: "a", status: "online", cwd: "/p", createdAt: "t", lastSeenAt: "t" },
			{ id: "b", status: "stopped", cwd: "/q", createdAt: "t", lastSeenAt: "t" },
		]);
		expect(loadInstances(dir).map((i) => i.id)).toEqual(["a", "b"]);
		expect(existsSync(getInstancesPath(dir))).toBe(true);
		expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
	});
});
