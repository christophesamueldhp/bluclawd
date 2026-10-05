import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { InstanceSummary, ServerRequest, ServerResponse } from "../daemon/ipc/protocol.ts";
import { type IpcRequestHandler, startIpcServer } from "../daemon/ipc/server.ts";
import { RpcProcessInstance } from "../daemon/rpc-process.ts";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import { OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";
import { SessionController } from "../ext/agent-view/session-controller.ts";
import { SessionViewClient } from "../ext/agent-view/view-client.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function wait(condition: () => boolean, timeout = 5000): Promise<void> {
	const end = Date.now() + timeout;
	while (!condition()) {
		if (Date.now() > end) throw new Error("Persistent-view probe condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
async function deadline<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Persistent-view probe deadline exceeded")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer!);
	}
}
interface Stats {
	pid: number;
	toolExecutions: number;
	prompts: string[];
}
export interface PersistentViewHarness {
	dir: string;
	a: InstanceSummary;
	b: InstanceSummary;
	controller: SessionController;
	client: OrchestratorClient;
	supervisor: ServerSupervisor;
	wait: typeof wait;
	newController: () => SessionController;
	pid: (id: string) => Promise<number>;
	stats: (id: string) => Promise<Stats>;
	commands: () => Promise<string[]>;
}
export async function withPersistentViewHarness<T>(run: (harness: PersistentViewHarness) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "persistent-view-probe-"));
	const keys = ["PI_SERVER_DIR", "PI_CODING_AGENT_DIR", "RADIUS_API_KEY", "VIEW_FIXTURE_DIR"];
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, {
		PI_SERVER_DIR: dir,
		PI_CODING_AGENT_DIR: join(dir, "agent"),
		RADIUS_API_KEY: "",
		VIEW_FIXTURE_DIR: dir,
	});
	mkdirSync(join(dir, "agent"));
	const children: ChildProcess[] = [];
	const supervisor = new ServerSupervisor((_command, args, options) => {
		const index = args.indexOf("--session");
		const child = spawn(
			process.execPath,
			[join(root, "test/fixtures/view-rpc-child.mjs"), ...(index >= 0 ? ["--session", args[index + 1]] : [])],
			options,
		);
		children.push(child);
		return child;
	});
	let server: Server | undefined;
	const controllers: SessionController[] = [];
	try {
		const summary = (record: InstanceSummary) => ({
			...record,
			activity: supervisor.getActivity(record.id),
			needs: supervisor.getPendingNeeds(record.id),
		});
		const handler = Object.assign(
			(async (request: ServerRequest): Promise<ServerResponse> => {
				switch (request.type) {
					case "spawn":
						return { type: "spawn_result", ok: true, instance: summary(await supervisor.spawnInstance(request)) };
					case "list":
						return { type: "list_result", ok: true, instances: supervisor.listInstances().map(summary) };
					case "delete":
						await supervisor.deleteInstance(request.instanceId);
						return { type: "ack", ok: true };
					case "stop":
						await supervisor.stopInstance(request.instanceId);
						return { type: "stop_result", ok: true, instanceId: request.instanceId };
					case "view_history":
						return {
							type: "view_history_result",
							ok: true,
							page: supervisor.getViewHistory(request.instanceId, request.before, request.limit)!,
						};
					default:
						return { type: "error", ok: false, error: `Probe request unsupported: ${request.type}` };
				}
			}) as IpcRequestHandler,
			{ openViewStream: supervisor.openViewStream.bind(supervisor), openRpcStream: () => undefined },
		);
		server = await startIpcServer(handler);
		const socket = join(dir, "server.sock");
		const client = new OrchestratorClient(socket);
		const a = await client.spawn({ cwd: dir, label: "A" });
		const b = await client.spawn({ cwd: dir, label: "B" });
		if (!a || !b || a.status !== "online" || b.status !== "online")
			throw new Error("Probe fixture child initialization failed");
		const newController = () => {
			const controller = new SessionController({
				client,
				views: new SessionViewClient(socket),
				cwd: dir,
				onChange: () => {},
			});
			controllers.push(controller);
			return controller;
		};
		const stats = async (id: string): Promise<Stats> => {
			const view = await new SessionViewClient(socket).open(id, { onRecord: () => {}, onDisconnect: () => {} });
			try {
				const response = await view.send({ type: "get_session_stats" });
				if (response.success === false || !("data" in response)) throw new Error("Probe stats missing");
				return response.data as unknown as Stats;
			} finally {
				view.close();
			}
		};
		const controller = newController();
		return await deadline(
			run({
				dir,
				a,
				b,
				controller,
				client,
				supervisor,
				wait,
				newController,
				stats,
				pid: async (id) => (await stats(id)).pid,
				commands: async () => (await stats(controller.selected()!.instance.id)).prompts,
			}),
			20_000,
		);
	} finally {
		for (const controller of controllers) controller.dispose();
		await supervisor.shutdown();
		if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		rmSync(dir, { recursive: true, force: true });
	}
}
function rpcEntry(packageRoot?: string) {
	if (!packageRoot) return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const entry = manifest.exports["./rpc-entry"];
	return resolve(packageRoot, typeof entry === "string" ? entry : (entry.import ?? entry.default));
}
async function loadedResources(packageRoot?: string): Promise<boolean> {
	const dir = mkdtempSync(join(tmpdir(), "persistent-view-resources-"));
	const agent = join(dir, "agent");
	mkdirSync(agent);
	writeFileSync(
		join(agent, "settings.json"),
		JSON.stringify({
			defaultProjectTrust: "always",
			extensions: [join(root, "test/fixtures/persistent-view-provider.ts")],
		}),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_SERVER_DIR: join(dir, "server"),
		RADIUS_API_KEY: "",
		VIEW_GATE_DIR: dir,
	};
	const child = new RpcProcessInstance(
		{ cwd: dir, env, provider: "bluclawd-view-test", model: "view-test" },
		(_command, args, options) => spawn(process.execPath, [rpcEntry(packageRoot), ...args.slice(1)], options),
	);
	try {
		const state = await deadline(child.send({ type: "get_state" }));
		if (state.success === false) throw new Error(state.error);
		const response = await deadline(child.send({ type: "get_commands" }));
		if (response.success === false || response.command !== "get_commands")
			throw new Error("RPC commands unavailable");
		const commands = response.data.commands.map((command) => command.name);
		const filename = join(dir, `resources-${child.process.pid}.json`);
		await wait(() => existsSync(filename));
		const resources = JSON.parse(readFileSync(filename, "utf8")) as { mode: string; tools: string[] };
		const unique = (names: string[], name: string) => names.filter((item) => item === name).length === 1;
		return (
			resources.mode === "rpc" &&
			["tasks", "bashes", "rewind", "agent-view-bootstrap"].every((name) => unique(commands, name)) &&
			["bash", "monitor", "task_stop", "view_test_gate"].every((name) => unique(resources.tools, name))
		);
	} finally {
		await child.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}
export async function probePersistentSessionViews(options: { piPackageRoot?: string } = {}): Promise<{
	pidStable: boolean;
	toolExecutions: number;
	deletedRowAbsent: boolean;
	transcriptPreserved: boolean;
	childToolsLoaded: boolean;
}> {
	const lifecycle = await withPersistentViewHarness(async (h) => {
		await h.controller.select({ instanceId: h.a.id });
		const pid = await h.pid(h.a.id);
		await h.controller.submit({ text: "gated", images: [] });
		await h.wait(() => !!h.controller.projection()?.tools.gate);
		const earlier = JSON.stringify(h.controller.projection()?.partial);
		await h.controller.select({ instanceId: h.b.id });
		await h.controller.select({ instanceId: h.a.id });
		const pidStable = (await h.pid(h.a.id)) === pid && JSON.stringify(h.controller.projection()?.partial) === earlier;
		await h.controller.send({ type: "set_session_name", name: "release-gate" });
		await h.wait(() => !h.controller.projection()?.running);
		const toolExecutions = (await h.stats(h.a.id)).toolExecutions;
		const file = h.controller.selected()!.state.sessionFile!;
		await h.client.delete(h.a.id);
		await h.wait(() => !h.controller.selected());
		return {
			pidStable,
			toolExecutions,
			deletedRowAbsent: !(await h.client.list()).some((row) => row.id === h.a.id),
			transcriptPreserved: existsSync(file),
		};
	});
	return {
		...lifecycle,
		childToolsLoaded: await loadedResources(options.piPackageRoot ?? process.env.PI_PACKAGE_ROOT),
	};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const result = await probePersistentSessionViews({});
	console.log(JSON.stringify(result));
	if (
		!result.pidStable ||
		result.toolExecutions !== 1 ||
		!result.deletedRowAbsent ||
		!result.transcriptPreserved ||
		!result.childToolsLoaded
	)
		process.exitCode = 1;
}
