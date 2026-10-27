import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as executionFixture from "./helpers/subagent-execution-fixture.ts";
import {
	createExecutionFixture,
	nativeExecutionCandidate,
	type ProbeOperation,
} from "./helpers/subagent-execution-fixture.ts";

const fixtures: Awaited<ReturnType<typeof createExecutionFixture>>[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const f of fixtures.splice(0)) await f.cleanup();
});
async function fixture(denyRules: string[] = []) {
	const f = await createExecutionFixture(denyRules);
	fixtures.push(f);
	return f;
}
function nodeCommand(source: string) {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

const brokerJson = (securityd: number, securityServer: number) =>
	JSON.stringify({
		version: 1,
		lookups: [
			{ service: "com.apple.securityd.xpc", kr: securityd },
			{ service: "com.apple.SecurityServer", kr: securityServer },
		],
	});

// These cases catch false denial from malformed, uncontrolled or non-denial return codes.
describe("broker lookup oracle", () => {
	it.each([
		"not-json",
		"null",
		"[]",
		brokerJson(0, 0).replace('"version":1', '"version":2'),
		brokerJson(0, 0).replace('"version":1', '"version":"1"'),
		JSON.stringify({ version: 1, lookups: [] }),
		brokerJson(0.5, 0),
		brokerJson(Number.NaN, 0),
		brokerJson(0, 0).replace('"kr":0', '"kr":"0"'),
		brokerJson(0, 0).replace("com.apple.SecurityServer", "com.apple.securityd.xpc"),
		brokerJson(0, 0).replace("com.apple.SecurityServer", "unexpected.service"),
		brokerJson(0, 0).replace(',"kr":0', ""),
	])("rejects malformed probe JSON (%s)", (bad) => {
		for (const triple of [
			[bad, brokerJson(1100, 1100), brokerJson(0, 0)],
			[brokerJson(0, 0), bad, brokerJson(0, 0)],
			[brokerJson(0, 0), brokerJson(1100, 1100), bad],
		])
			expect(() => executionFixture.classifyBrokerLookups(...(triple as [string, string, string]))).toThrow(
				"Invalid broker lookup probe response.",
			);
	});

	it("classifies independently controlled services and normalizes reversed input order", () => {
		const inside = JSON.parse(brokerJson(1100, 1102));
		inside.lookups.reverse();
		expect(
			executionFixture.classifyBrokerLookups(brokerJson(0, 0), JSON.stringify(inside), brokerJson(0, 0)),
		).toEqual([
			{ service: "com.apple.securityd.xpc", status: "denied" },
			{ service: "com.apple.SecurityServer", status: "denied" },
		]);
	});
	it("does not classify kr=5 as denied", () => {
		expect(executionFixture.classifyBrokerLookups(brokerJson(0, 0), brokerJson(5, 1100), brokerJson(0, 0))).toEqual([
			{ service: "com.apple.securityd.xpc", status: "unknown" },
			{ service: "com.apple.SecurityServer", status: "denied" },
		]);
		expect(() =>
			executionFixture.requireBrokerLookupDenial(brokerJson(0, 0), brokerJson(5, 1100), brokerJson(0, 0)),
		).toThrow("Native broker lookup denial was not demonstrated.");
	});
	it("does not classify missing outside controls as denied", () => {
		expect(
			executionFixture.classifyBrokerLookups(brokerJson(1102, 0), brokerJson(1100, 1100), brokerJson(0, 1102)),
		).toEqual([
			{ service: "com.apple.securityd.xpc", status: "unknown" },
			{ service: "com.apple.SecurityServer", status: "unknown" },
		]);
	});
	it("treats inside success as reachable even if outside controls are unavailable", () => {
		expect(
			executionFixture.classifyBrokerLookups(brokerJson(1102, 0), brokerJson(0, 0), brokerJson(1102, 0)),
		).toEqual([
			{ service: "com.apple.securityd.xpc", status: "reachable" },
			{ service: "com.apple.SecurityServer", status: "reachable" },
		]);
		expect(() =>
			executionFixture.requireBrokerLookupDenial(brokerJson(0, 0), brokerJson(0, 1100), brokerJson(0, 0)),
		).toThrow("Native broker lookup denial was not demonstrated.");
	});
	it("does not accept an all-unavailable oracle as native proof", () => {
		expect(
			executionFixture.classifyBrokerLookups(brokerJson(1102, 1102), brokerJson(1100, 5), brokerJson(1102, 1102)),
		).toEqual([
			{ service: "com.apple.securityd.xpc", status: "unavailable" },
			{ service: "com.apple.SecurityServer", status: "unavailable" },
		]);
		expect(() =>
			executionFixture.requireBrokerLookupDenial(
				brokerJson(1102, 1102),
				brokerJson(1100, 5),
				brokerJson(1102, 1102),
			),
		).toThrow("Native broker lookup denial was not demonstrated.");
	});
	it("accepts a nonvacuous denial while disclosing a genuinely unavailable second service", () => {
		expect(
			executionFixture.requireBrokerLookupDenial(brokerJson(0, 1102), brokerJson(1100, 1102), brokerJson(0, 1102)),
		).toEqual([
			{ service: "com.apple.securityd.xpc", status: "denied" },
			{ service: "com.apple.SecurityServer", status: "unavailable" },
		]);
	});
});

async function compileBrokerProbe(f: Awaited<ReturnType<typeof fixture>>) {
	const source = fileURLToPath(new URL("./fixtures/subagent-execution/credential-broker.c", import.meta.url));
	const executable = join(f.workspace.root, "credential-broker-probe");
	const built = await f.f.exec(
		"/usr/bin/env",
		[
			"-i",
			"PATH=/usr/bin:/bin",
			"HOME=/dev/null",
			"LC_ALL=C",
			"/Library/Developer/CommandLineTools/usr/bin/clang",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-isysroot",
			"/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
			source,
			"-o",
			executable,
		],
		{ timeout: 10000 },
	);
	expect(built.code).toBe(0);
	expect(built.killed).toBe(false);
	expect(built.stderr).toBe("");
	return executable;
}
async function outsideLookup(f: Awaited<ReturnType<typeof fixture>>, executable: string) {
	const control = await f.f.exec(executable, [], { timeout: 1000 });
	expect(control.killed, JSON.stringify(control)).toBe(false);
	expect(control.code, JSON.stringify(control)).toBe(0);
	expect(control.stderr).toBe("");
	return control.stdout;
}

describe.skipIf(!nativeExecutionCandidate)("real native complete-tool boundary", () => {
	it("runs read/grep/find/ls/edit/write/bash without changing parent or sibling files or parent sandbox policy", async () => {
		const f = await fixture();
		const report = await f.probe([
			{ tool: "write", input: { path: "made.txt", content: "private creation\n" } },
			{ tool: "edit", input: { path: "tracked.txt", edits: [{ oldText: "base line", newText: "child line" }] } },
			{ tool: "read", input: { path: "tracked.txt" } },
			{ tool: "grep", input: { pattern: "child line", path: "." } },
			{ tool: "find", input: { pattern: "*.txt", path: "." } },
			{ tool: "ls", input: { path: "." } },
			{ tool: "bash", input: { command: "printf 'shell-ok\\n'" } },
		]);
		expect(report.results.map((r) => r.ok)).toEqual([true, true, true, true, true, true, true]);
		expect(report.results[2].text).toContain("child line");
		expect(report.results[3].text).toContain("tracked.txt");
		expect(report.results[4].text).toContain("made.txt");
		expect(report.results[5].text).toContain("tracked.txt");
		expect(report.results[6].text).toContain("shell-ok");
		expect(await readFile(join(f.workspace.root, "made.txt"), "utf8")).toBe("private creation\n");
		expect(await readFile(join(f.workspace.root, "tracked.txt"), "utf8")).toBe("child line\nsecond base\n");
		for (const root of [f.f.parentCwd, f.sibling.root])
			expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base line\nsecond base\n");
		expect(report.workerExitObserved).toBe(true);
		expect(report.parentConfigUnchanged).toBe(true);
		expect(report.parentResult.ok).toBe(true);
		expect(await readFile(f.parentLive, "utf8")).toBe("parent operation still allowed\n");
	});

	it("blocks complete SDK operations against parent/sibling/source Git and control paths", async () => {
		const f = await fixture();
		const control = join(f.f.stateDir, "private-control.txt");
		await writeFile(control, "synthetic control sentinel\n");
		const external = [
			join(f.f.parentCwd, "tracked.txt"),
			join(f.sibling.root, "tracked.txt"),
			join(f.source.repoDir, "config"),
			control,
		];
		const operations: ProbeOperation[] = external.flatMap((path) => [
			{ tool: "read", input: { path } },
			{ tool: "write", input: { path, content: "unauthorized\n" } },
			{ tool: "edit", input: { path, edits: [{ oldText: "base", newText: "unauthorized" }] } },
		]);
		operations.push(
			{ tool: "grep", input: { path: f.f.parentCwd, pattern: "base line" } },
			{ tool: "find", input: { path: f.sibling.root, pattern: "*.txt" } },
			{ tool: "ls", input: { path: f.f.parentCwd } },
			{
				tool: "bash",
				input: {
					command: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(control)}, 'unauthorized')`),
				},
			},
		);
		const report = await f.probe(operations);
		expect(report.results.slice(0, 13).map((r) => r.ok)).toEqual(Array(13).fill(false));
		expect(report.results[13]).toEqual({ ok: true, text: "No files found matching pattern" });
		expect(report.results.slice(14).map((r) => r.ok)).toEqual([false, false]);
		expect(await readFile(control, "utf8")).toBe("synthetic control sentinel\n");
		for (const root of [f.f.parentCwd, f.sibling.root])
			expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base line\nsecond base\n");
	});

	it("enforces denied paths through file tools, search subprocesses and shell operations", async () => {
		const f = await fixture(["Read(**/blocked/**)", "Write(**/write-locked.txt)", "Edit(**/write-locked.txt)"]);
		await mkdir(join(f.workspace.root, "blocked"));
		await writeFile(join(f.workspace.root, "blocked", "secret.txt"), "synthetic denied sentinel\n");
		await writeFile(join(f.workspace.root, "write-locked.txt"), "locked original\n");
		const report = await f.probe([
			{ tool: "read", input: { path: "blocked/secret.txt" } },
			{ tool: "grep", input: { path: "blocked", pattern: "sentinel" } },
			{ tool: "find", input: { path: "blocked", pattern: "*.txt" } },
			{ tool: "ls", input: { path: "blocked" } },
			{ tool: "write", input: { path: "write-locked.txt", content: "overwritten" } },
			{ tool: "edit", input: { path: "write-locked.txt", edits: [{ oldText: "locked", newText: "overwritten" }] } },
			{ tool: "bash", input: { command: "cat blocked/secret.txt" } },
			{ tool: "bash", input: { command: "mv blocked moved && cat moved/secret.txt" } },
		]);
		expect(report.results.map((r) => r.ok)).toEqual([false, false, true, false, false, false, false, false]);
		expect(report.results[2].text).toBe("No files found matching pattern");
		expect(await readFile(join(f.workspace.root, "write-locked.txt"), "utf8")).toBe("locked original\n");
	});

	it("blocks symlink escapes, original Git redirects and private Git writes", async () => {
		const f = await fixture();
		await symlink(join(f.f.parentCwd, "tracked.txt"), join(f.workspace.root, "escape"));
		await mkdir(join(f.workspace.root, "redirect"));
		await writeFile(join(f.workspace.root, "redirect", ".git"), `gitdir: ${join(f.f.parentCwd, ".git")}\n`);
		const report = await f.probe([
			{ tool: "read", input: { path: "escape" } },
			{ tool: "write", input: { path: "escape", content: "overwritten" } },
			{ tool: "bash", input: { command: "git -C redirect rev-parse --show-toplevel" } },
			{ tool: "bash", input: { command: `git cat-file -e ${f.source.sourceHead}` } },
			{ tool: "bash", input: { command: "git config probe.changed true" } },
			{ tool: "bash", input: { command: "git --no-optional-locks status --porcelain" } },
		]);
		expect(report.results.map((r) => r.ok)).toEqual([false, false, false, false, false, true]);
		expect(await readFile(join(f.f.parentCwd, "tracked.txt"), "utf8")).toBe("base line\nsecond base\n");
	});

	it("cannot overwrite another host tool artifact in the shared runtime temp root", async () => {
		const f = await fixture();
		await mkdir("/private/tmp/claude", { recursive: true, mode: 0o700 });
		const shared = await mkdtemp(join(await realpath("/private/tmp/claude"), "bcs-gate-"));
		f.f.scratchDirs.push(shared);
		const sentinel = join(shared, "parent-artifact.txt");
		await writeFile(sentinel, "synthetic parent artifact\n");
		const report = await f.probe([
			{
				tool: "bash",
				input: {
					command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "unauthorized")`),
				},
			},
		]);
		expect(report.results[0].ok).toBe(false);
		expect(await readFile(sentinel, "utf8")).toBe("synthetic parent artifact\n");
	});

	it("does not expose the host credential broker through Mach services", async () => {
		const f = await fixture();
		const executable = await compileBrokerProbe(f);
		const before = await outsideLookup(f, executable);
		const report = await f.probe([{ tool: "bash", input: { command: JSON.stringify(executable) } }]);
		expect(report.workerExitObserved).toBe(true);
		expect(report.results[0].ok).toBe(true);
		const after = await outsideLookup(f, executable);
		expect(
			executionFixture
				.requireBrokerLookupDenial(before, report.results[0].text, after)
				.some((r) => r.status === "denied"),
		).toBe(true);
		console.info(
			"Broker lookup controls",
			JSON.stringify({
				before: JSON.parse(before),
				inside: JSON.parse(report.results[0].text),
				after: JSON.parse(after),
			}),
		);
	});

	it.each([
		["exact", ["com.apple.securityd.xpc", "com.apple.SecurityServer"]],
		["wildcard", ["com.apple.*"]],
	])(
		"blocks broker lookup despite exact and wildcard session allows while seven SDK tools execute (%s)",
		async (_kind, allows) => {
			const f = await fixture();
			const executable = await compileBrokerProbe(f);
			const before = await outsideLookup(f, executable);
			const report = await f.probe(
				[
					{ tool: "write", input: { path: "made.txt", content: "private creation\n" } },
					{
						tool: "edit",
						input: { path: "tracked.txt", edits: [{ oldText: "base line", newText: "child line" }] },
					},
					{ tool: "read", input: { path: "tracked.txt" } },
					{ tool: "grep", input: { pattern: "child line", path: "." } },
					{ tool: "find", input: { pattern: "*.txt", path: "." } },
					{ tool: "ls", input: { path: "." } },
					{ tool: "bash", input: { command: JSON.stringify(executable) } },
				],
				{ parentMachAllows: allows },
			);
			expect(report.workerExitObserved).toBe(true);
			expect(report.results.map((r) => r.ok)).toEqual([true, true, true, true, true, true, true]);
			expect(report.results[2].text).toContain("child line");
			expect(report.results[3].text).toContain("tracked.txt");
			expect(report.results[4].text).toContain("made.txt");
			expect(report.results[5].text).toContain("tracked.txt");
			const after = await outsideLookup(f, executable);
			const coverage = executionFixture.requireBrokerLookupDenial(before, report.results[6].text, after);
			expect(coverage.some((r) => r.status === "denied")).toBe(true);
			expect(report.parentMachAllows).toEqual(allows);
			expect(report.parentConfigUnchanged).toBe(true);
			expect(report.parentResult.ok).toBe(true);
			expect(report.parentWriteWhileChildWaiting).toBe(true);
			expect(await readFile(f.parentLive, "utf8")).toBe("parent operation still allowed\n");
			for (const root of [f.f.parentCwd, f.sibling.root])
				expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base line\nsecond base\n");
			console.info(
				"Broker precedence controls",
				JSON.stringify({
					kind: _kind,
					before: JSON.parse(before),
					inside: JSON.parse(report.results[6].text),
					after: JSON.parse(after),
					coverage,
				}),
			);
		},
	);

	it("keeps parent work active during isolated execution", async () => {
		const f = await fixture();
		const report = await f.probe([
			{ tool: "write", input: { path: "child-live.txt", content: "child operation still allowed\n" } },
		]);
		expect(report.parentWriteWhileChildWaiting).toBe(true);
		expect(report.workerExitObserved).toBe(true);
		expect(report.parentConfigUnchanged).toBe(true);
		expect(report.parentResult.ok).toBe(true);
		expect(report.results[0].ok).toBe(true);
		expect(await readFile(f.parentLive, "utf8")).toBe("parent operation still allowed\n");
		expect(await readFile(join(f.workspace.root, "child-live.txt"), "utf8")).toBe("child operation still allowed\n");
	});

	it.each([
		["reports probe timeout as unknown", "timeout"],
		["rejects worker startup failure", "startup"],
	])("%s", async (_name, failure) => {
		const f = await fixture();
		const transport = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => true),
		}) as unknown as ChildProcessWithoutNullStreams;
		vi.spyOn(childProcess, "spawn").mockReturnValueOnce(transport);
		syncBuiltinESMExports();
		const pending = f.probe([]);
		if (failure === "startup") transport.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
		transport.emit("close", failure === "timeout" ? null : -13, failure === "timeout" ? "SIGKILL" : null);
		await expect(pending).rejects.toThrow("Native execution probe failed (transport)");
	});

	it("scrubs parent credentials and denies raw loopback/Unix connections", async () => {
		const f = await fixture();
		let connections = 0;
		const server = createServer((socket) => {
			connections++;
			socket.end("synthetic local service");
		});
		const unix = createServer((socket) => {
			connections++;
			socket.end("synthetic local service");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const socketPath = join(f.workspace.scratchDir, "outside.sock");
		await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
		try {
			const port = (server.address() as { port: number }).port;
			const connection = (address: unknown) =>
				nodeCommand(
					`const s=require('node:net').connect(${JSON.stringify(address)});s.setTimeout(300);s.on('connect',()=>{console.log('connected');s.destroy()});s.on('error',()=>console.log('blocked'));s.on('timeout',()=>{console.log('blocked');s.destroy()});`,
				);
			const report = await f.probe([
				{ tool: "bash", input: { command: `printf '%s' "\${BLUCLAWD_TEST_PARENT_CREDENTIAL:-unset}"` } },
				{ tool: "bash", input: { command: connection({ host: "127.0.0.1", port }) } },
				{ tool: "bash", input: { command: connection({ path: socketPath }) } },
			]);
			expect(report.results[0].text).toBe("unset");
			expect(report.results.slice(1).map((r) => r.text.trim())).toEqual(["blocked", "blocked"]);
			expect(connections).toBe(0);
		} finally {
			await Promise.all([
				new Promise<void>((resolve) => server.close(() => resolve())),
				new Promise<void>((resolve) => unix.close(() => resolve())),
			]);
		}
	});
});
