import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getInstancesPath } from "../daemon/config.ts";
import { loadActiveRuns, loadInstances, saveActiveRuns, saveInstances } from "../daemon/storage.ts";
import type { InstanceRecord } from "../daemon/types.ts";

describe("instances.json storage", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-orch-storage-"));
	});

	it("returns [] for a corrupt/half-written instances.json instead of throwing", () => {
		writeFileSync(getInstancesPath(dir), "{ this is not json");
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

	it("keeps none of a live row's pane, leaf, dialog, draft, wake time or turn start", () => {
		const live: InstanceRecord = {
			id: "a",
			status: "online",
			cwd: "/p",
			createdAt: "t",
			label: "fix CI",
			pane: "pi-1",
			leafId: "e1",
			dialog: { kind: "select", title: "Allow?" },
			draft: true,
			wakesAt: 1,
			turnStartedAt: "t",
		};
		saveInstances(dir, [live]);
		expect(JSON.parse(readFileSync(getInstancesPath(dir), "utf8"))).toEqual([
			{ id: "a", status: "online", cwd: "/p", createdAt: "t", label: "fix CI" },
		]);
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

describe("run-slots.json storage", () => {
	it("saves into a directory that does not exist yet, owner-only, without making the default one", () => {
		const configDir = mkdtempSync(join(tmpdir(), "bluclawd-config-"));
		vi.stubEnv("PI_SERVER_DIR", "");
		vi.stubEnv("PI_CONFIG_DIR", configDir);
		const dir = join(mkdtempSync(join(tmpdir(), "bluclawd-run-slots-")), "server");
		saveActiveRuns(dir, [{ run: "r1", parent: "p1", pid: 42 }]);
		expect(loadActiveRuns(dir).map((run) => run.run)).toEqual(["r1"]);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(existsSync(join(configDir, "server"))).toBe(false);
	});
});
