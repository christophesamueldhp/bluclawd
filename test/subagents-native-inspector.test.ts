import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIsolatedSubagentPolicySnapshot } from "../ext/subagents/execution-policy.ts";
import {
	inspectNativeProcesses,
	type NativeCookies,
	type PreparedNativeInspector,
	prepareNativeInspector,
	readNativeProcessStatus,
	signalNativeProcess,
} from "../ext/subagents/native-inspector.ts";
import { withSubagentPreparation } from "../ext/subagents/preparation.ts";
import { captureSourceSnapshot } from "../ext/subagents/source-snapshot.ts";
import { createSubagentFixture } from "./helpers/subagent-fixture.ts";

const native = process.platform === "darwin" && process.arch === "arm64" && process.getuid?.() !== 0;
const signal = new AbortController().signal;
const cookies = (): NativeCookies => ({
	run: randomBytes(32).toString("hex"),
	command: randomBytes(32).toString("hex"),
});
let fixture: Awaited<ReturnType<typeof createSubagentFixture>>;
let inspector: PreparedNativeInspector;
const children: Array<{ child: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }> }> = [];
const owner = () => ({ parentSessionId: "native-parent", runtimeGeneration: 1, signal, isCurrent: () => true });
async function build(exec: ExtensionAPI["exec"] = fixture.exec) {
	return withSubagentPreparation(owner(), (preparation) =>
		prepareNativeInspector({ ...owner(), agentDir: fixture.stateDir, preparation, exec }),
	);
}
async function control(cookie: NativeCookies, title = false) {
	const birthLower = BigInt(Date.now() - 1000) * 1000n;
	const child = spawn(
		process.execPath,
		[
			"-e",
			`
		${title ? 'process.title = "native-inspector-control";' : ""}
		process.on("SIGTERM", () => {});
		process.stdout.write("ready");
		setTimeout(() => process.exit(0), 6000);
	`,
		],
		{
			env: {
				PATH: "/usr/bin:/bin",
				BLUCLAWD_SUBAGENT_RUN_COOKIE: cookie.run,
				BLUCLAWD_SUBAGENT_COMMAND_COOKIE: cookie.command,
			},
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	children.push({ child, exited });
	await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
	return { child, exited, birthLower, birthUpper: BigInt(Date.now() + 1000) * 1000n };
}
async function raw(args: string[], input: string) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(inspector.executablePath, args, { stdio: ["pipe", "pipe", "pipe"], env: { LANG: "C" } });
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdin.on("error", () => {});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input);
	});
}

beforeAll(async () => {
	fixture = await createSubagentFixture();
	if (native) inspector = await build();
}, 15000);
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const item of children.splice(0)) {
		item.child.kill("SIGKILL");
		await item.exited;
	}
});
afterAll(async () => {
	await fixture?.cleanup();
});

it("refuses compiler absence without installing tools or creating a helper", async () => {
	const before = await readdir(fixture.stateDir, { recursive: true });
	const missing: ExtensionAPI["exec"] = async (command, args) => {
		expect(command).toBe("/usr/bin/env");
		expect(args).toEqual([
			"-i",
			"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
			"LC_ALL=C",
			"HOME=/dev/null",
			"/usr/bin/xcode-select",
			"--print-path",
		]);
		return { stdout: "", stderr: "unavailable", code: 1, killed: false };
	};
	await expect(build(missing)).rejects.toThrow(/unavailable|unsupported|toolchain|compiler/i);
	const after = await readdir(fixture.stateDir, { recursive: true });
	expect(after).toEqual(before);
});

describe.skipIf(!native)("locally compiled macOS inspector", () => {
	it("builds a private helper with a bounded ABI probe from outside the source cwd", async () => {
		expect(inspector.platform).toBe("darwin");
		expect(inspector.arch).toBe("arm64");
		expect(inspector.protocolVersion).toBe(1);
		expect(inspector.sha256).toBe(
			createHash("sha256")
				.update(await readFile(inspector.executablePath))
				.digest("hex"),
		);
		expect(Object.isFrozen(inspector)).toBe(true);
		expect(inspector.executablePath.startsWith(`${fixture.stateDir}/`)).toBe(true);
		expect((await stat(dirname(inspector.executablePath))).mode & 0o777).toBe(0o700);
		expect((await stat(inspector.executablePath)).mode & 0o777).toBe(0o700);
	});

	it("keeps queued compiler plus capture under the original deadline", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holders = [withSubagentPreparation(owner(), () => held), withSubagentPreparation(owner(), () => held)];
		const timeouts: number[] = [];
		let gitCalls = 0,
			verifiedCaptureDeadline = false;
		const exec: ExtensionAPI["exec"] = async (command, args, options) => {
			if (args.includes("git")) gitCalls++;
			else timeouts.push(options!.timeout!);
			return fixture.exec(command, args, options);
		};
		const pending = withSubagentPreparation(owner(), async (preparation) => {
			await prepareNativeInspector({ ...owner(), agentDir: fixture.stateDir, preparation, exec });
			expect(timeouts).toEqual([5000, 5000]);
			await vi.advanceTimersByTimeAsync(5001);
			await expect(
				captureSourceSnapshot({
					...owner(),
					preparation,
					agentDir: fixture.stateDir,
					exec,
					policy: createIsolatedSubagentPolicySnapshot({
						cwd: fixture.parentCwd,
						denyRules: [],
						allowedTools: ["bash"],
					}).snapshot!,
				}),
			).rejects.toThrow(/timed out|preparation/i);
			expect(gitCalls).toBe(0);
			verifiedCaptureDeadline = true;
		});
		const settled = Promise.allSettled([...holders, pending]);
		try {
			await vi.advanceTimersByTimeAsync(25_000);
		} finally {
			release();
		}
		const outcome = (await settled)[2];
		expect(outcome.status).toBe("rejected");
		if (outcome.status === "rejected") expect(String(outcome.reason)).toMatch(/timed out/);
		expect(verifiedCaptureDeadline).toBe(true);
		vi.useRealTimers();
	});

	it("ignores compiler and SDK environment overrides", async () => {
		const poison = join(fixture.root, "include");
		await mkdir(poison);
		await writeFile(join(poison, "stdio.h"), "#error Unexpected inherited include directory\n");
		vi.stubEnv("CC", "/not-an-approved-compiler");
		vi.stubEnv("CFLAGS", "-include /not-an-approved-header");
		vi.stubEnv("CPATH", poison);
		vi.stubEnv("SDKROOT", "/not-an-approved-sdk");
		vi.stubEnv("DEVELOPER_DIR", "/not-an-approved-toolchain");
		expect((await build()).protocolVersion).toBe(1);
	});

	it.each([false, true])("finds its owned child after process-title change=%s", async (title) => {
		const cookie = cookies();
		const own = await control(cookie, title);
		const scan = await inspectNativeProcesses(inspector, cookie, signal);
		expect(scan.matches.map((member) => member.pid)).toEqual([own.child.pid]);
		expect(scan.matches[0].uid).toBe(process.getuid!());
		expect(scan.matches[0].startMicros).toMatch(/^[1-9][0-9]+$/);
		expect(BigInt(scan.matches[0].startMicros)).toBeGreaterThanOrEqual(own.birthLower);
		expect(BigInt(scan.matches[0].startMicros)).toBeLessThanOrEqual(own.birthUpper);
		expect(Number.isSafeInteger(scan.unreadable)).toBe(true);
		expect(scan.truncated).toBe(false);
	});

	it("separates command cookies and unrelated run cookies", async () => {
		const first = cookies();
		const second = { ...cookies(), run: first.run };
		const a = await control(first);
		const b = await control(second);
		await control(cookies());
		expect((await inspectNativeProcesses(inspector, first, signal)).matches.map((m) => m.pid)).toEqual([a.child.pid]);
		expect(
			(await inspectNativeProcesses(inspector, { run: first.run }, signal)).matches.map((m) => m.pid).sort(),
		).toEqual([a.child.pid!, b.child.pid!].sort());
	});

	it("refuses stale identity and foreign cookies without killing the live instance", async () => {
		const cookie = cookies();
		const own = await control(cookie);
		const member = (await inspectNativeProcesses(inspector, cookie, signal)).matches[0];
		expect(
			await signalNativeProcess(
				inspector,
				{ identity: { ...member, startMicros: "0" }, cookies: cookie, signal: "SIGKILL" },
				signal,
			),
		).toBe("refused");
		expect(
			await signalNativeProcess(inspector, { identity: member, cookies: cookies(), signal: "SIGKILL" }, signal),
		).toBe("refused");
		expect(await readNativeProcessStatus(inspector, member, cookie, signal)).toBe("live");
		expect(await readNativeProcessStatus(inspector, { ...member, startMicros: "0" }, cookie, signal)).toBe("reused");
		expect(await readNativeProcessStatus(inspector, member, cookies(), signal)).toBe("unknown");
		expect(
			await signalNativeProcess(
				inspector,
				{ identity: { ...member, uid: 0 }, cookies: cookie, signal: "SIGKILL" },
				signal,
			),
		).toBe("refused");
		expect(own.child.exitCode).toBeNull();
	});

	it("terminates a TERM-resistant owned process and observes actual exit without stopping a sibling", async () => {
		const cookie = cookies(),
			siblingCookie = cookies();
		const own = await control(cookie);
		const sibling = await control(siblingCookie);
		const siblingMember = (await inspectNativeProcesses(inspector, siblingCookie, signal)).matches[0];
		const member = (await inspectNativeProcesses(inspector, cookie, signal)).matches[0];
		expect(
			await signalNativeProcess(inspector, { identity: member, cookies: cookie, signal: "SIGTERM" }, signal),
		).toBe("sent");
		expect(await readNativeProcessStatus(inspector, member, cookie, signal)).toBe("live");
		expect(
			await signalNativeProcess(inspector, { identity: member, cookies: cookie, signal: "SIGKILL" }, signal),
		).toBe("sent");
		expect((await own.exited).signal).toBe("SIGKILL");
		expect(await readNativeProcessStatus(inspector, member, cookie, signal)).toBe("exited");
		expect(await readNativeProcessStatus(inspector, siblingMember, siblingCookie, signal)).toBe("live");
		expect(sibling.child.exitCode).toBeNull();
	});

	it("keeps aborted inspection unknown rather than reporting an empty process set", async () => {
		const cookie = cookies();
		const own = await control(cookie);
		const member = (await inspectNativeProcesses(inspector, cookie, signal)).matches[0];
		const aborted = AbortSignal.abort();
		await expect(inspectNativeProcesses(inspector, cookie, aborted)).rejects.toThrow();
		expect(await readNativeProcessStatus(inspector, member, cookie, aborted)).toBe("unknown");
		expect(
			await signalNativeProcess(inspector, { identity: member, cookies: cookie, signal: "SIGKILL" }, aborted),
		).toBe("unknown");
		expect(own.child.exitCode).toBeNull();
	});

	it("does not expose cookie values, argv or environment in native responses", async () => {
		const cookie = cookies();
		await control(cookie);
		const response = await raw(["v1", "scan"], `${cookie.run}\n${cookie.command}\n`);
		expect(response.code).toBe(0);
		expect(response.stdout).not.toContain(cookie.run);
		expect(response.stdout).not.toContain(cookie.command!);
		expect(response.stdout).not.toContain("BLUCLAWD_SUBAGENT");
		expect(response.stderr).toBe("");
	});

	it.each(["bad\n\n", "a".repeat(4097), `${"a".repeat(64)}\n\nextra`])(
		"rejects malformed private requests without signalling",
		async (input) => {
			const response = await raw(["v1", "scan"], input);
			expect(response.code).not.toBe(0);
			expect(JSON.parse(response.stdout)).toEqual({ version: 1, op: "scan", error: { code: "invalid_request" } });
			expect(response.stderr).toBe("");
		},
	);

	it.each([
		{ args: ["v2", "scan"] },
		{ args: ["v1", "status", "-1", "501", "0"] },
		{ args: ["v1", "status", "1", "501", "18446744073709551616"] },
		{ args: ["v1", "signal", "1", "501", "0", "STOP"] },
	])("rejects invalid protocol versions, identities and signal names", async ({ args }) => {
		const cookie = cookies();
		const response = await raw(args, `${cookie.run}\n${cookie.command}\n`);
		expect(response.code).not.toBe(0);
		expect(JSON.parse(response.stdout).error).toEqual({ code: "invalid_request" });
	});

	it("rejects copied helper references before executing them", async () => {
		await expect(inspectNativeProcesses({ ...inspector }, cookies(), signal)).rejects.toThrow(
			/inspector|identity|reference/i,
		);
	});

	it.each(["bytes", "symlink"])("rejects helper %s replacement", async (kind) => {
		const other = await build();
		if (kind === "bytes") await writeFile(other.executablePath, "not the compiled helper");
		else {
			await rename(other.executablePath, `${other.executablePath}.original`);
			await symlink(`${other.executablePath}.original`, other.executablePath);
		}
		await expect(inspectNativeProcesses(other, cookies(), signal)).rejects.toThrow(
			/inspector|identity|changed|unsafe/i,
		);
	});

	it("refuses stale owner after compilation without publishing a usable helper", async () => {
		let current = true;
		const exec: ExtensionAPI["exec"] = async (command, args, options) => {
			const result = await fixture.exec(command, args, options);
			if (args.includes("-o")) current = false;
			return result;
		};
		await expect(
			withSubagentPreparation({ ...owner(), isCurrent: () => current }, (preparation) =>
				prepareNativeInspector({
					...owner(),
					preparation,
					agentDir: fixture.stateDir,
					exec,
					isCurrent: () => current,
				}),
			),
		).rejects.toThrow(/owner|session|current/i);
	});
});
