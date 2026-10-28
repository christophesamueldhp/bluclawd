import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const name = "@anthropic-ai/sandbox-runtime";
const version = "0.0.81-bluclawd.2";
const sourceCommit = "c40cf14a65d025e3cd27f071f13a73c12b3b1f92";
const sourceTree = "8b0c1f68ab58235d56bdac8db5d70ad7db6fef6d";
const officialSRI = "sha512-bjHDu87gjIR7+Oxy9jPiK3v8CvSELCzfpXa3fjqfSKdvlZET2iF51xcXILWPayTpowB3xtZeQVf2JR916nVW/w==";
const nodeHash = "2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0";
const npmHash = "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7";
const dependencies = {
	"@pondwader/socks5-server": "^1.0.10",
	commander: "^12.1.0",
	"node-forge": "^1.4.0",
	zod: "^3.25.0",
};
const stems = ["sandbox-config", "sandbox-manager", "macos-sandbox-utils", "sandbox-schemas"];
const patches = { mach: "mach-denial.patch", harness: "harness.patch", commandId: "command-id-ask.patch" };
const outputs = new Set(
	stems.flatMap((stem) => [".js", ".js.map", ".d.ts", ".d.ts.map"].map((suffix) => `dist/sandbox/${stem}${suffix}`)),
);
const sourcePaths = stems.map((stem) => `sandbox/${stem}.ts`).sort();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const requireMatch = (actual, expected, message) => {
	if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
};
const json = async (path) => JSON.parse(await fs.readFile(path, "utf8"));
const save = (path, value) => fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const project = (rows) => rows.map(({ path, sha256 }) => ({ path, sha256 }));
const readonlyEnv = {
	PATH: "/usr/bin:/bin",
	HOME: "/var/empty",
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	OPENSSL_CONF: "/dev/null",
};
const run = (command, args, options = {}) =>
	exec(command, args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: readonlyEnv, ...options });

export function assertArchiveIntegrity(bytes, expectedSRI) {
	if (sri(bytes) !== expectedSRI) throw new Error("Sandbox runtime archive integrity mismatch.");
}

export function assertArchiveMemberPaths(paths) {
	const seen = new Set();
	for (const path of paths) {
		const parts = path.split("/");
		if (
			parts[0] !== "package" ||
			parts.length < 2 ||
			parts.some(
				(part) =>
					!part || part === "." || part === ".." || [".env", ".git", ".npmrc", "node_modules"].includes(part),
			) ||
			/[\\\x00-\x1f\x7f]/.test(path) ||
			seen.has(path)
		)
			throw new Error("Unsafe or duplicate sandbox runtime archive member.");
		seen.add(path);
	}
}

async function inventory(root, path = "") {
	const full = join(root, path);
	let info;
	try {
		info = await fs.lstat(full);
	} catch (error) {
		if (error.code === "ENOENT" && !path) return [];
		throw error;
	}
	if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || path.split("/").includes(".env"))
		throw new Error("Unsafe sandbox runtime payload entry.");
	if (info.isFile()) return [{ path, sha256: sha(await fs.readFile(full)), mode: info.mode & 0o777 }];
	const rows = [];
	for (const child of (await fs.readdir(full)).sort())
		rows.push(...(await inventory(root, path ? `${path}/${child}` : child)));
	return rows;
}

export async function inspectRuntimeDelta(baselineDir, patchedDir) {
	const scan = async (root) =>
		(
			await Promise.all(
				["dist", "vendor"].map(async (dir) =>
					(await inventory(join(root, dir))).map((row) => ({ ...row, path: `${dir}/${row.path}` })),
				),
			)
		)
			.flat()
			.sort((a, b) => a.path.localeCompare(b.path, "en"));
	const before = await scan(baselineDir),
		after = await scan(patchedDir);
	const old = new Map(before.map((row) => [row.path, row]));
	const next = new Map(after.map((row) => [row.path, row]));
	const changes = [];
	for (const path of new Set([...old.keys(), ...next.keys()])) {
		const a = old.get(path),
			b = next.get(path);
		if (!a || !b || a.mode !== b.mode || (a.sha256 !== b.sha256 && !outputs.has(path)))
			throw new Error(`Unapproved sandbox runtime payload change: ${path}`);
		if (a.sha256 !== b.sha256) changes.push({ path, beforeHash: a.sha256, afterHash: b.sha256, mode: a.mode });
	}
	return changes;
}

export function privateRuntimeMetadata(basePackage) {
	if (
		basePackage.name !== name ||
		basePackage.version !== "0.0.81" ||
		!isDeepStrictEqual(basePackage.dependencies, dependencies)
	)
		throw new Error("Unapproved base runtime metadata.");
	const result = structuredClone(basePackage);
	Object.assign(result, {
		version,
		private: true,
		description: `${result.description} (bluclawd private build: Mach-lookup denial, command id in network asks)`,
		files: [
			"dist",
			"vendor/seccomp",
			"vendor/srt-win",
			"vendor/java-proxy-agent",
			"README.md",
			"LICENSE",
			"BLUCLAWD-NOTICE.txt",
		],
	});
	delete result.scripts;
	delete result.devDependencies;
	return result;
}

async function unpack(archive, directory) {
	const names = (await run("/usr/bin/tar", ["-tzf", archive])).stdout.trimEnd().split("\n");
	assertArchiveMemberPaths(names);
	const listing = (await run("/usr/bin/tar", ["-tvzf", archive])).stdout.trimEnd().split("\n");
	if (
		listing.length !== names.length ||
		listing.some((line) => !line.startsWith("-") || /[sStT]/.test(line.slice(0, 10)))
	)
		throw new Error("Unsafe non-regular archive member.");
	await fs.mkdir(directory, { mode: 0o700 });
	await run("/usr/bin/tar", ["-xzf", archive, "--no-same-owner", "-C", directory]);
	return join(directory, "package");
}

export async function buildPrivateSandboxRuntime(options) {
	const { baseArchive, baselineDir, patchedDir, baselineManifest, sourceDelta, npmCli, outputDir } = options;
	try {
		await fs.lstat(outputDir);
		throw new Error("Private sandbox runtime output already exists.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const originalBytes = await fs.readFile(baseArchive);
	assertArchiveIntegrity(originalBytes, officialSRI);
	if (
		process.version !== "v22.23.4" ||
		sha(await fs.readFile(process.execPath)) !== nodeHash ||
		sha(await fs.readFile(npmCli)) !== npmHash
	)
		throw new Error("Required verified Node22.23.4/npm10.9.9 maintainer toolchain unavailable.");
	const base = await json(baselineManifest),
		delta = await json(sourceDelta);
	requireMatch(
		[base.sourceCommit, base.sourceTree, base.archiveIntegrity, base.archiveSha256],
		[sourceCommit, sourceTree, officialSRI, sha(originalBytes)],
		"Unapproved baseline provenance.",
	);
	requireMatch(
		[delta.sourceCommit, delta.baselineTree, delta.toolVersions],
		[sourceCommit, sourceTree, { node: "22.23.4", npm: "10.9.9", bun: "1.4.2" }],
		"Unapproved source provenance.",
	);
	for (const label of [
		"baseline-build",
		"baseline-typecheck",
		"baseline-test-typecheck",
		"candidate-typecheck",
		"candidate-test-typecheck",
		"candidate-build",
		"candidate-lint",
		"candidate-format",
		"mach-green",
		"command-id-green",
		"official-broad",
		"patched-broad",
	])
		requireMatch(delta.verification?.[label], 0, `Source verification missing: ${label}`);
	for (const dir of [baselineDir, patchedDir]) {
		const git = [
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"diff.external=",
			"rev-parse",
			"HEAD",
			"HEAD^{tree}",
		];
		requireMatch(
			(await run("/usr/bin/git", git, { cwd: dir })).stdout.trim().split("\n"),
			[sourceCommit, sourceTree],
			"Source checkout identity changed.",
		);
		for (const [file, expected] of [
			["package.json", base.sourcePackageSha256],
			["package-lock.json", base.sourceLockSha256],
		])
			requireMatch(sha(await fs.readFile(join(dir, file))), expected, "Source package/lock drift.");
	}
	await run(
		"/usr/bin/git",
		[
			"-c",
			"core.fsmonitor=false",
			"diff",
			"--no-ext-diff",
			"--quiet",
			"HEAD",
			"--",
			"src",
			"package.json",
			"package-lock.json",
		],
		{ cwd: baselineDir },
	);
	const oldSrc = await inventory(join(baselineDir, "src")),
		newSrc = await inventory(join(patchedDir, "src"));
	requireMatch(project(oldSrc), project(base.sourceFiles), "Baseline source inventory changed.");
	requireMatch(
		oldSrc.map((row) => row.path),
		newSrc.map((row) => row.path),
		"Source files added or removed.",
	);
	const changedSrc = newSrc.filter((row, i) => row.sha256 !== oldSrc[i].sha256);
	requireMatch(changedSrc.map((row) => row.path).sort(), sourcePaths, "Unapproved production source delta.");
	requireMatch(
		Object.fromEntries(changedSrc.map((row) => [`src/${row.path}`, row.sha256])),
		delta.sourceHashes,
		"Reviewed source hashes changed.",
	);
	const cleanDist = (await inventory(join(baselineDir, "dist"))).map((row) => ({ ...row, path: `dist/${row.path}` }));
	requireMatch(project(cleanDist), project(base.distFiles), "Baseline build does not match published files.");
	const originalModes = new Map(base.files.map((row) => [row.path, row.mode]));
	const changes = (await inspectRuntimeDelta(baselineDir, patchedDir)).map((row) => ({
		...row,
		mode: originalModes.get(row.path),
	}));
	requireMatch(changes, delta.runtimeFileChanges, "Reviewed generated runtime delta changed.");
	const proofDir = dirname(sourceDelta);
	for (const [key, file] of Object.entries(patches))
		requireMatch(sha(await fs.readFile(join(proofDir, file))), delta[`${key}PatchSha256`], "Reviewed patch changed.");

	await fs.mkdir(outputDir, { mode: 0o700 });
	const original = await unpack(baseArchive, join(outputDir, "base"));
	requireMatch(await inventory(original), base.files, "Official payload inventory mismatch.");
	const basePackage = await json(join(original, "package.json"));
	requireMatch(basePackage, base.packageMetadata, "Official package metadata mismatch.");
	const stage = join(outputDir, "stage");
	await fs.cp(original, stage, { recursive: true, force: false, errorOnExist: true });
	for (const row of changes) await fs.copyFile(join(patchedDir, row.path), join(stage, row.path));
	for (const row of base.files) await fs.chmod(join(stage, row.path), row.mode);
	requireMatch(await inspectRuntimeDelta(original, stage), changes, "Staged native/runtime payload changed.");
	const metadata = privateRuntimeMetadata(basePackage);
	await fs.writeFile(join(stage, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	await fs.writeFile(
		join(stage, "BLUCLAWD-NOTICE.txt"),
		`bluclawd private sandbox runtime ${version}\nNot an Anthropic release or endorsement. Upstream copyright and Apache-2.0 license retained.\nUpstream: https://github.com/anthropics/sandbox-runtime at ${sourceCommit}\nModified source modules: ${stems.join(", ")}. Their JS/declarations/maps add explicit Mach-lookup denial and pass the requesting command's id to the network ask callback.\nPackage metadata removes development dependencies/build and lifecycle scripts; production ranges/public entries are unchanged.\nSee the accompanying provenance and source patch for reproducible maintenance.\n`,
	);
	for (const file of ["package.json", "BLUCLAWD-NOTICE.txt"]) await fs.chmod(join(stage, file), 0o644);
	const home = join(outputDir, "npm-home");
	await fs.mkdir(home, { mode: 0o700 });
	for (const file of ["user.npmrc", "global.npmrc"]) await fs.writeFile(join(home, file), "", { mode: 0o600 });
	const env = {
		...readonlyEnv,
		HOME: home,
		TMPDIR: home,
		npm_config_userconfig: join(home, "user.npmrc"),
		npm_config_globalconfig: join(home, "global.npmrc"),
		npm_config_cache: join(home, "cache"),
		npm_config_offline: "true",
		npm_config_ignore_scripts: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
	};
	requireMatch(
		(await run(process.execPath, [npmCli, "--version"], { cwd: stage, env })).stdout.trim(),
		"10.9.9",
		"Incorrect npm version.",
	);
	const packed = JSON.parse(
		(
			await run(
				process.execPath,
				[npmCli, "pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", outputDir],
				{ cwd: stage, env },
			)
		).stdout,
	);
	const filename = `anthropic-ai-sandbox-runtime-${version}.tgz`;
	if (packed.length !== 1 || packed[0].filename !== filename) throw new Error("Unexpected private archive output.");
	const tarball = join(outputDir, filename),
		bytes = await fs.readFile(tarball);
	const unpacked = await unpack(tarball, join(outputDir, "verified"));
	const payload = await inventory(unpacked);
	requireMatch(payload, await inventory(stage), "Packed payload differs from reviewed staging.");
	const manifestDiff = {};
	for (const key of new Set([...Object.keys(basePackage), ...Object.keys(metadata)]))
		if (!isDeepStrictEqual(basePackage[key], metadata[key]))
			manifestDiff[key] = { before: basePackage[key] ?? null, after: metadata[key] ?? null };
	const provenance = join(outputDir, "provenance.json");
	await save(provenance, {
		name,
		version,
		upstream: {
			commit: sourceCommit,
			tree: sourceTree,
			url: base.archiveUrl,
			integrity: officialSRI,
			sha256: sha(originalBytes),
		},
		artifact: { filename, bytes: bytes.length, sha256: sha(bytes), integrity: sri(bytes) },
		tools: { ...delta.toolVersions, nodeSha256: nodeHash, npmCliSha256: npmHash },
		patches: Object.fromEntries(Object.keys(patches).map((key) => [`${key}Sha256`, delta[`${key}PatchSha256`]])),
		sourceHashes: delta.sourceHashes,
		sourcePackageSha256: base.sourcePackageSha256,
		sourceLockSha256: base.sourceLockSha256,
		builderSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
		runtimeChanges: changes,
		manifestDiff,
		payload,
		verification: delta.verification,
	});
	for (const file of Object.values(patches)) await fs.copyFile(join(proofDir, file), join(outputDir, file));
	return { tarball, provenance, sha256: sha(bytes), integrity: sri(bytes) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const keys = ["base-archive", "baseline", "patched", "baseline-manifest", "source-delta", "npm-cli", "output"];
		const { values } = parseArgs({
			options: Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
			strict: true,
		});
		if (keys.some((key) => !values[key])) throw new Error("All fixed maintainer input paths are required.");
		const result = await buildPrivateSandboxRuntime({
			baseArchive: resolve(values["base-archive"]),
			baselineDir: resolve(values.baseline),
			patchedDir: resolve(values.patched),
			baselineManifest: resolve(values["baseline-manifest"]),
			sourceDelta: resolve(values["source-delta"]),
			npmCli: resolve(values["npm-cli"]),
			outputDir: resolve(values.output),
		});
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
