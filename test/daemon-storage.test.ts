import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getInstancesPath } from "../daemon/config.ts";
import { loadInstances, saveInstances } from "../daemon/storage.ts";

describe("instances.json storage", () => {
	let dir: string;
	let prevEnv: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-orch-storage-"));
		prevEnv = process.env.PI_SERVER_DIR;
		process.env.PI_SERVER_DIR = dir;
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.PI_SERVER_DIR;
		else process.env.PI_SERVER_DIR = prevEnv;
	});

	it("returns [] for a corrupt/half-written instances.json instead of throwing", () => {
		writeFileSync(getInstancesPath(), "{ this is not json");
		// Must not throw — a corrupt file would otherwise brick every daemon op incl. startup recover.
		expect(loadInstances()).toEqual([]);
	});

	it("returns [] when the JSON is valid but not an array", () => {
		writeFileSync(getInstancesPath(), '{"not":"an array"}');
		expect(loadInstances()).toEqual([]);
	});

	it("round-trips saved instances and leaves no .tmp file behind (atomic write)", () => {
		saveInstances([
			{ id: "a", status: "online", cwd: "/p", createdAt: "t", lastSeenAt: "t" },
			{ id: "b", status: "stopped", cwd: "/q", createdAt: "t", lastSeenAt: "t" },
		]);
		expect(loadInstances().map((i) => i.id)).toEqual(["a", "b"]);
		expect(existsSync(getInstancesPath())).toBe(true);
		expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
	});
});
