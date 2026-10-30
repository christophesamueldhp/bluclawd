import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertArchiveIntegrity,
	assertArchiveMemberPaths,
	buildPrivateSandboxRuntime,
	inspectRuntimeDelta,
	privateRuntimeMetadata,
} from "../scripts/build-private-sandbox-runtime.ts";

const script = fileURLToPath(new URL("../scripts/build-private-sandbox-runtime.ts", import.meta.url));
const officialSRI = "sha512-bjHDu87gjIR7+Oxy9jPiK3v8CvSELCzfpXa3fjqfSKdvlZET2iF51xcXILWPayTpowB3xtZeQVf2JR916nVW/w==";
const basePackage = {
	name: "@anthropic-ai/sandbox-runtime",
	version: "0.0.81",
	description: "Anthropic Sandbox Runtime",
	type: "module",
	main: "./dist/index.js",
	types: "./dist/index.d.ts",
	bin: { srt: "dist/cli.js" },
	engines: { node: ">=22.12.0" },
	author: "Anthropic PBC",
	license: "Apache-2.0",
	files: ["dist", "vendor/seccomp", "vendor/srt-win", "vendor/java-proxy-agent", "README.md", "LICENSE"],
	dependencies: {
		"@pondwader/socks5-server": "^1.0.10",
		commander: "^12.1.0",
		"node-forge": "^1.4.0",
		zod: "^3.25.0",
	},
	scripts: { prepare: "husky", install: "exit 99", prepublishOnly: "exit 99" },
	devDependencies: { typescript: "^5.6.3" },
};

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bluclawd-package-test-"));
	const before = join(root, "before");
	const after = join(root, "after");
	mkdirSync(before);
	mkdirSync(after);
	return { root, before, after };
}
function put(root: string, path: string, text: string, mode = 0o644) {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	chmodSync(file, mode);
}
function options(root: string) {
	return {
		baseArchive: join(root, "base.tgz"),
		baselineDir: join(root, "before"),
		patchedDir: join(root, "after"),
		baselineManifest: join(root, "baseline.json"),
		sourceDelta: join(root, "delta.json"),
		npmCli: join(root, "npm-cli.js"),
		outputDir: join(root, "output"),
	};
}

describe("private sandbox runtime preparation", () => {
	it("rejects a tampered official archive before creating output", async () => {
		const { root } = fixture();
		writeFileSync(join(root, "base.tgz"), "tampered");
		expect(() => assertArchiveIntegrity(Buffer.from("tampered"), officialSRI)).toThrow(/integrity/i);
		await expect(buildPrivateSandboxRuntime(options(root))).rejects.toThrow(/integrity/i);
		expect(existsSync(join(root, "output"))).toBe(false);
	});

	it("accepts a hand-checked SHA512 fixture without weakening the fixed official identity", () => {
		const abc =
			"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";
		expect(() =>
			assertArchiveIntegrity(Buffer.from("abc"), `sha512-${Buffer.from(abc, "hex").toString("base64")}`),
		).not.toThrow();
	});

	it.each([
		"/package/a",
		"package/../outside",
		"package/a/../../outside",
		"other/a",
		"package//a",
		"package/./a",
		"package/a\\b",
		"package/a\nsecond",
		"package/.env",
	])("rejects unsafe archive path %j", (path) => {
		expect(() => assertArchiveMemberPaths([path])).toThrow(/unsafe/i);
	});
	it("rejects duplicate archive members", () => {
		expect(() => assertArchiveMemberPaths(["package/dist/a.js", "package/dist/a.js"])).toThrow(/duplicate|unsafe/i);
	});
	it("accepts ordinary public and native payload paths", () => {
		expect(() =>
			assertArchiveMemberPaths([
				"package/dist/index.js",
				"package/vendor/seccomp/arm64/apply-seccomp",
				"package/LICENSE",
			]),
		).not.toThrow();
	});

	it("rejects an unrelated SOCKS JavaScript change", async () => {
		const { before, after } = fixture();
		put(before, "dist/sandbox/socks-proxy.js", "old");
		put(after, "dist/sandbox/socks-proxy.js", "new");
		await expect(inspectRuntimeDelta(before, after)).rejects.toThrow(/unapproved/i);
	});
	it.each(["sandbox-config.js", "macos-sandbox-utils.js"])(
		"rejects a change to %s, which no patch touches",
		async (file) => {
			const { before, after } = fixture();
			put(before, `dist/sandbox/${file}`, "old");
			put(after, `dist/sandbox/${file}`, "new");
			await expect(inspectRuntimeDelta(before, after)).rejects.toThrow(/unapproved/i);
		},
	);
	it("rejects symlinked payload entries instead of following them", async () => {
		const { before, after } = fixture();
		put(before, "dist/index.js", "same");
		mkdirSync(join(after, "dist"));
		symlinkSync(join(before, "dist/index.js"), join(after, "dist/index.js"));
		await expect(inspectRuntimeDelta(before, after)).rejects.toThrow(/unsafe/i);
	});
	it("reports the real reviewed module delta while leaving unchanged files out", async () => {
		const { before, after } = fixture();
		for (const dir of [before, after]) put(dir, "dist/index.js", "same");
		put(before, "dist/sandbox/sandbox-manager.js", "old");
		put(after, "dist/sandbox/sandbox-manager.js", "new");
		put(before, "dist/sandbox/sandbox-schemas.d.ts", "old");
		put(after, "dist/sandbox/sandbox-schemas.d.ts", "new");
		const changes = await inspectRuntimeDelta(before, after);
		expect(changes.map((change) => change.path)).toEqual([
			"dist/sandbox/sandbox-manager.js",
			"dist/sandbox/sandbox-schemas.d.ts",
		]);
		expect(changes[0].beforeHash).not.toBe(changes[0].afterHash);
	});
	it.each(["missing", "bytes", "mode"])("rejects native asset %s drift", async (kind) => {
		const { before, after } = fixture();
		put(before, "vendor/seccomp/arm64/apply-seccomp", "native", 0o755);
		if (kind !== "missing")
			put(
				after,
				"vendor/seccomp/arm64/apply-seccomp",
				kind === "bytes" ? "changed" : "native",
				kind === "mode" ? 0o644 : 0o755,
			);
		await expect(inspectRuntimeDelta(before, after)).rejects.toThrow(/unapproved/i);
	});

	it("labels a private fork without changing production resolution, public entries or authorship", () => {
		const copy = structuredClone(basePackage);
		const result = privateRuntimeMetadata(basePackage);
		expect(result).toMatchObject({
			name: "@anthropic-ai/sandbox-runtime",
			version: "0.0.81-bluclawd.3",
			private: true,
			author: "Anthropic PBC",
			license: "Apache-2.0",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			bin: { srt: "dist/cli.js" },
			engines: { node: ">=22.12.0" },
		});
		expect(result.dependencies).toEqual({
			"@pondwader/socks5-server": "^1.0.10",
			commander: "^12.1.0",
			"node-forge": "^1.4.0",
			zod: "^3.25.0",
		});
		expect(result.description).toBe("Anthropic Sandbox Runtime (bluclawd private build: command id in network asks)");
		expect(result.files).toContain("BLUCLAWD-NOTICE.txt");
		expect(basePackage).toEqual(copy);
	});
	it.each(["name", "version", "dependencies"])("refuses base metadata %s drift", (key) => {
		const changed = {
			...basePackage,
			[key]: key === "dependencies" ? { ...basePackage.dependencies, zod: "*" } : "different",
		};
		expect(() => privateRuntimeMetadata(changed)).toThrow(/base|unapproved/i);
	});
	it("removes all lifecycle/build scripts and development installation requirements", () => {
		const result = privateRuntimeMetadata(basePackage);
		expect(result.scripts).toBeUndefined();
		expect(result.devDependencies).toBeUndefined();
	});

	it("refuses an existing output without altering it", async () => {
		const { root } = fixture();
		mkdirSync(join(root, "output"));
		writeFileSync(join(root, "output", "keep"), "preserve");
		await expect(buildPrivateSandboxRuntime(options(root))).rejects.toThrow(/already exists/i);
		expect(readFileSync(join(root, "output", "keep"), "utf8")).toBe("preserve");
	});
	it("refuses an alternate CLI integrity instead of authorizing arbitrary package bytes", () => {
		const result = spawnSync(process.execPath, [script, "--integrity", "sha512-alternate"], { encoding: "utf8" });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/unknown|unexpected/i);
	});
	it("can be imported in an empty directory without invoking the CLI or making files", () => {
		const { root } = fixture();
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", `await import(${JSON.stringify(new URL(`file://${resolve(script)}`).href)});`],
			{ cwd: root, encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		expect(existsSync(join(root, "output"))).toBe(false);
	});
});
