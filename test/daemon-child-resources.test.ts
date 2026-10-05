import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { bundledChildExtensionArgs } from "../daemon/child-resources.ts";
import { RpcProcessInstance } from "../daemon/rpc-process.ts";

describe("bundled RPC child resources", () => {
	it("package and bin paths load child tools once in manifest order", () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
		const args = bundledChildExtensionArgs();
		const paths = args.filter((_, index) => index % 2 === 1);
		expect(paths).toEqual(manifest.pi.extensions.map((path: string) => resolve(root, path)));
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths[0]).toContain("ext/permissions/index.ts");
		expect(args.filter((_, index) => index % 2 === 0)).toEqual(paths.map(() => "--extension"));
	});
	it("launcher receives resources without disabling normal discovery", () => {
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			pid: 1234,
			kill: () => true,
		}) as unknown as ChildProcess;
		const launch = vi.fn(
			(_command: string, _args: string[], _options: import("node:child_process").SpawnOptions) => child,
		);
		const instance = new RpcProcessInstance({ cwd: "/tmp", provider: "test", model: "model" }, launch);
		const args = launch.mock.calls[0][1] as string[];
		expect(args).toContain("--extension");
		expect(args).not.toContain("--no-extensions");
		expect(args).toContain("--provider");
		expect(instance.process).toBe(child);
		child.emit("exit", 0, null);
	});
});
