import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertSubagentPreparation, type SubagentPreparationContext } from "./preparation.ts";
import { assertPreparationCurrent, isWithin, privateDirectory } from "./workspace.ts";

declare const inspectorBrand: unique symbol;
export interface PreparedNativeInspector {
	readonly executablePath: string;
	readonly sha256: string;
	readonly protocolVersion: 1;
	readonly platform: "darwin";
	readonly arch: "arm64";
	readonly [inspectorBrand]: true;
}
export interface NativeProcessIdentity {
	pid: number;
	uid: number;
	startMicros: string;
}
export interface NativeCookies {
	run: string;
	command?: string;
}
export interface NativeSignalTarget {
	identity: NativeProcessIdentity;
	cookies: NativeCookies;
	signal: "SIGTERM" | "SIGKILL";
}
export interface NativeInspection {
	matches: readonly NativeProcessIdentity[];
	unreadable: number;
	truncated: boolean;
}
type Op = "probe" | "scan" | "status" | "signal";
const MAX_RESPONSE = 256 * 1024;
const MAX_BINARY = 4 * 1024 * 1024;
const references = new WeakMap<PreparedNativeInspector, { directory: string; file: string }>();
const environment = ["-i", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C", "HOME=/dev/null"];

function fingerprint(path: string, directory = false): string {
	const stat = lstatSync(path, { bigint: true });
	if (
		(directory ? !stat.isDirectory() : !stat.isFile()) ||
		realpathSync(path) !== path ||
		stat.uid !== BigInt(process.getuid!()) ||
		(stat.mode & 0o7777n) !== 0o700n
	)
		throw new Error("Unsafe native inspector identity");
	return [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function bytes(path: string, max: number): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.size > BigInt(max)) throw new Error("Unsafe native inspector file");
		const buffer = Buffer.alloc(Number(before.size) + 1);
		let total = 0;
		while (total < buffer.length) {
			const count = readSync(fd, buffer, total, buffer.length - total, null);
			if (!count) break;
			total += count;
		}
		const after = fstatSync(fd, { bigint: true });
		if (
			BigInt(total) !== before.size ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs
		)
			throw new Error("Native inspector file changed");
		return buffer.subarray(0, total);
	} finally {
		closeSync(fd);
	}
}
function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}
function validate(inspector: PreparedNativeInspector): void {
	const reference = references.get(inspector);
	if (!reference) throw new Error("Invalid native inspector reference");
	if (
		fingerprint(dirname(inspector.executablePath), true) !== reference.directory ||
		fingerprint(inspector.executablePath) !== reference.file ||
		sha256(bytes(inspector.executablePath, MAX_BINARY)) !== inspector.sha256
	)
		throw new Error("Native inspector identity changed");
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
	return record(value) && Object.keys(value).sort().join(",") === expected.sort().join(",");
}
function identity(value: unknown): value is NativeProcessIdentity {
	return (
		keys(value, ["pid", "uid", "startMicros"]) &&
		Number.isSafeInteger(value.pid) &&
		Number(value.pid) > 0 &&
		Number(value.pid) <= 2147483647 &&
		Number.isSafeInteger(value.uid) &&
		Number(value.uid) >= 0 &&
		Number(value.uid) <= 4294967295 &&
		typeof value.startMicros === "string" &&
		/^(0|[1-9][0-9]{0,19})$/.test(value.startMicros) &&
		BigInt(value.startMicros) <= 18446744073709551615n
	);
}
function cookieInput(cookies: NativeCookies): string {
	if (
		!cookies ||
		!/^[0-9a-f]{64}$/.test(cookies.run) ||
		(cookies.command !== undefined && !/^[0-9a-f]{64}$/.test(cookies.command))
	)
		throw new Error("Invalid native inspector cookies");
	return `${cookies.run}\n${cookies.command ?? ""}\n`;
}

async function request(
	path: string,
	op: Op,
	args: string[],
	input: string,
	signal: AbortSignal,
	timeout = 1000,
): Promise<unknown> {
	signal.throwIfAborted();
	if (Buffer.byteLength(input) > 4096 || timeout <= 0) throw new Error("Native inspector request limit");
	const response = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
		const child = spawn(path, ["v1", op, ...args], {
			stdio: [op === "probe" ? "ignore" : "pipe", "pipe", "pipe"],
			env: { PATH: "/usr/bin:/bin", LC_ALL: "C", HOME: "/dev/null" },
			signal,
			timeout: Math.min(1000, timeout),
			killSignal: "SIGKILL",
		});
		let size = 0,
			failed = false;
		const chunks: Buffer[] = [];
		child.on("error", () => {
			failed = true;
		});
		child.stdin?.on("error", () => {
			failed = true;
		});
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_RESPONSE) {
				failed = true;
				child.kill("SIGKILL");
			} else if (!failed) chunks.push(chunk);
		});
		child.stderr.on("data", () => {
			failed = true;
			child.kill("SIGKILL");
		});
		// Retain the helper until actual close, including abort and output-limit failures.
		child.once("close", (code, termination) => {
			if (failed || termination || signal.aborted) reject(new Error("Native inspector transport failed"));
			else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") });
		});
		child.stdin?.end(input);
	});
	let envelope: unknown;
	try {
		envelope = JSON.parse(response.stdout);
	} catch {
		throw new Error("Invalid native inspector response");
	}
	if (!record(envelope) || envelope.version !== 1 || envelope.op !== op)
		throw new Error("Invalid native inspector envelope");
	if (response.code === 0 && keys(envelope, ["version", "op", "result"])) return envelope.result;
	if (
		response.code !== 0 &&
		keys(envelope, ["version", "op", "error"]) &&
		keys(envelope.error, ["code"]) &&
		["invalid_request", "unsupported", "inspection_failed", "limit_exceeded", "internal"].includes(
			String(envelope.error.code),
		)
	)
		throw new Error("Native inspector request failed");
	throw new Error("Invalid native inspector envelope");
}
async function probe(path: string, signal: AbortSignal, timeout?: number): Promise<void> {
	const result = await request(path, "probe", [], "", signal, timeout);
	if (
		!keys(result, ["platform", "arch", "uid"]) ||
		result.platform !== "darwin" ||
		result.arch !== "arm64" ||
		result.uid !== process.getuid!()
	)
		throw new Error("Invalid native inspector ABI probe");
}
async function invoke(
	inspector: PreparedNativeInspector,
	op: Op,
	args: string[],
	cookies: NativeCookies,
	signal: AbortSignal,
) {
	validate(inspector);
	const input = cookieInput(cookies);
	await probe(inspector.executablePath, signal);
	validate(inspector);
	return request(inspector.executablePath, op, args, input, signal);
}

export async function prepareNativeInspector(options: {
	agentDir: string;
	parentSessionId: string;
	runtimeGeneration: number;
	preparation: SubagentPreparationContext;
	exec: ExtensionAPI["exec"];
	isCurrent(): boolean;
}): Promise<PreparedNativeInspector> {
	const { preparation } = options;
	const check = () => {
		assertSubagentPreparation(preparation, options.parentSessionId, options.runtimeGeneration);
		assertPreparationCurrent(preparation.signal, options.isCurrent);
	};
	check();
	if (process.platform !== "darwin" || process.arch !== "arm64" || !process.getuid?.())
		throw new Error("Native inspector unavailable on this platform");
	const exec = async (args: string[], cwd?: string) => {
		check();
		const result = await options.exec("/usr/bin/env", [...environment, ...args], {
			cwd: cwd ?? "/",
			signal: preparation.signal,
			timeout: Math.min(10_000, preparation.deadlineAt - Date.now()),
		});
		check();
		if (result.code !== 0 || result.killed) throw new Error("Native inspector toolchain unavailable or build failed");
		return result.stdout.trim();
	};
	// --print-path does not launch the command-line-tools installer or compiler stubs.
	const developer = await exec(["/usr/bin/xcode-select", "--print-path"]);
	if (!["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"].includes(developer))
		throw new Error("Native inspector installed Apple toolchain unavailable");
	let compiler: string, sdk: string;
	try {
		compiler = realpathSync(
			join(
				developer,
				developer.endsWith("CommandLineTools")
					? "usr/bin/clang"
					: "Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
			),
		);
		sdk = realpathSync(
			join(
				developer,
				developer.endsWith("CommandLineTools")
					? "SDKs/MacOSX.sdk"
					: "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
			),
		);
		for (const path of [compiler, sdk]) {
			const stat = lstatSync(path);
			if (
				!isWithin(developer, path) ||
				stat.uid !== 0 ||
				stat.mode & 0o022 ||
				(path === compiler ? !stat.isFile() : !stat.isDirectory())
			)
				throw new Error();
		}
	} catch {
		throw new Error("Native inspector compiler or SDK unavailable");
	}
	if (!isAbsolute(options.agentDir)) throw new Error("Unsafe native inspector storage");
	privateDirectory(options.agentDir);
	const directory = join(
		realpathSync(options.agentDir),
		"bluclawd",
		"subagents",
		options.parentSessionId,
		"native",
		`${options.runtimeGeneration}-${randomUUID()}`,
	);
	privateDirectory(directory);
	fingerprint(directory, true);
	const source = fileURLToPath(new URL("./native/inspector.c", import.meta.url));
	const sourcePath = join(directory, "inspector.c"),
		executablePath = join(directory, "inspector");
	writeFileSync(sourcePath, bytes(source, 64 * 1024), { mode: 0o600, flag: "wx" });
	await exec(
		[
			`TMPDIR=${directory}`,
			compiler,
			"-std=c11",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-O2",
			"-arch",
			"arm64",
			"-isysroot",
			sdk,
			sourcePath,
			"-o",
			executablePath,
		],
		directory,
	);
	check();
	if (!lstatSync(executablePath).isFile() || realpathSync(executablePath) !== executablePath)
		throw new Error("Unsafe native inspector executable");
	chmodSync(executablePath, 0o700);
	const file = fingerprint(executablePath),
		directoryIdentity = fingerprint(directory, true);
	const inspector = Object.freeze({
		executablePath,
		sha256: sha256(bytes(executablePath, MAX_BINARY)),
		protocolVersion: 1,
		platform: "darwin",
		arch: "arm64",
	}) as PreparedNativeInspector;
	await probe(executablePath, preparation.signal, preparation.deadlineAt - Date.now());
	check();
	references.set(inspector, { file, directory: directoryIdentity });
	validate(inspector);
	return inspector;
}

export async function inspectNativeProcesses(
	inspector: PreparedNativeInspector,
	cookies: NativeCookies,
	signal: AbortSignal,
): Promise<NativeInspection> {
	const result = await invoke(inspector, "scan", [], cookies, signal);
	if (
		!keys(result, ["matches", "unreadable", "truncated"]) ||
		!Array.isArray(result.matches) ||
		result.matches.length > 10_000 ||
		!result.matches.every(identity) ||
		result.matches.some((member) => member.uid !== process.getuid!() || member.pid <= 1) ||
		new Set(result.matches.map((member) => member.pid)).size !== result.matches.length ||
		!Number.isSafeInteger(result.unreadable) ||
		Number(result.unreadable) < 0 ||
		Number(result.unreadable) > 10_000 ||
		typeof result.truncated !== "boolean"
	)
		throw new Error("Invalid native inspector scan response");
	return Object.freeze({
		matches: Object.freeze(result.matches.map((member) => Object.freeze(member))),
		unreadable: Number(result.unreadable),
		truncated: result.truncated,
	});
}
export async function readNativeProcessStatus(
	inspector: PreparedNativeInspector,
	member: NativeProcessIdentity,
	cookies: NativeCookies,
	signal: AbortSignal,
): Promise<"live" | "exited" | "reused" | "unknown"> {
	validate(inspector);
	if (!identity(member)) throw new Error("Invalid native process identity");
	try {
		const result = await invoke(
			inspector,
			"status",
			[String(member.pid), String(member.uid), member.startMicros],
			cookies,
			signal,
		);
		if (keys(result, ["status"]) && ["live", "exited", "reused", "unknown"].includes(String(result.status)))
			return result.status as "live" | "exited" | "reused" | "unknown";
	} catch {}
	return "unknown";
}
export async function signalNativeProcess(
	inspector: PreparedNativeInspector,
	target: NativeSignalTarget,
	signal: AbortSignal,
): Promise<"sent" | "gone" | "refused" | "unknown"> {
	validate(inspector);
	if (!identity(target.identity) || !["SIGTERM", "SIGKILL"].includes(target.signal))
		throw new Error("Invalid native signal target");
	try {
		const { identity: member } = target;
		const result = await invoke(
			inspector,
			"signal",
			[String(member.pid), String(member.uid), member.startMicros, target.signal === "SIGTERM" ? "TERM" : "KILL"],
			target.cookies,
			signal,
		);
		if (keys(result, ["status"]) && ["sent", "gone", "refused", "unknown"].includes(String(result.status)))
			return result.status as "sent" | "gone" | "refused" | "unknown";
	} catch {}
	return "unknown";
}
