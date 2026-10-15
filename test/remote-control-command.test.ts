import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	currentDaemonBuildId,
	OrchestratorClient,
	type RemoteAction,
	type RemoteResult,
} from "../daemon/orchestrator-client.ts";
import { type AutostartDeps, autostartDeps, LABEL } from "../ext/remote/autostart.ts";
import remoteFactory, { USAGE } from "../ext/remote/index.ts";
import { qrMatrix, renderQr } from "../ext/remote/qr.ts";
import { serve, tailscaleInfo } from "../ext/remote/tailscale.ts";

// Never the real tailscale, launchctl or LaunchAgents.
vi.mock("../ext/remote/tailscale.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../ext/remote/tailscale.ts")>()),
	tailscaleInfo: vi.fn(),
	serve: vi.fn(),
}));
vi.mock("../ext/remote/autostart.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../ext/remote/autostart.ts")>()),
	autostartDeps: vi.fn(),
}));

const HOST = "mac.tail1234.ts.net";
const PAIR = "Pair a new phone";
const OFF = "Turn off remote control";

describe("/remote-control", () => {
	let dir: string;
	let deps: AutostartDeps;
	let enabled: boolean;
	let actions: RemoteAction[];
	let code: string;
	let secret: string;
	const devices: RemoteResult["devices"] = [
		{ id: "d1", name: "iPhone", createdAt: "2026-10-01T10:00:00.000Z" },
		{ id: "d2", name: "iPad", createdAt: "2026-10-02T10:00:00.000Z" },
	];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-command-"));
		vi.stubEnv("HOME", dir);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
		vi.stubEnv("PI_SERVER_DIR", join(dir, "server"));
		deps = {
			platform: "darwin",
			dir: join(dir, "LaunchAgents"),
			uid: 501,
			launchctl: vi.fn((args: string[]) => {
				if (args[0] === "bootout") throw new Error("not loaded");
			}),
			command: ["/usr/local/bin/node", "/x/daemon/cli.ts", "serve"],
			env: { PATH: "/usr/bin" },
			log: join(dir, "server", "daemon.log"),
		};
		vi.mocked(autostartDeps).mockImplementation(() => deps);
		vi.mocked(tailscaleInfo).mockResolvedValue({ installed: true, dnsName: HOST, serve: "ours", funnel: false });
		vi.mocked(serve).mockResolvedValue();
		enabled = false;
		actions = [];
		code = "482913";
		secret = "Qm3xZ8vT1pLk9sWc2rYb0A";
		vi.spyOn(OrchestratorClient.prototype, "ensureDaemon").mockResolvedValue(true);
		vi.spyOn(OrchestratorClient.prototype, "getDaemonInfo").mockResolvedValue({
			buildId: currentDaemonBuildId(),
		} as never);
		vi.spyOn(OrchestratorClient.prototype, "remote").mockImplementation(async (action) => {
			actions.push(action);
			if (action.action === "on") enabled = true;
			if (action.action === "off") enabled = false;
			const paired = action.action === "on" || action.action === "pair";
			const result: RemoteResult = { enabled, port: 7878, listening: enabled, devices };
			return paired ? { ...result, code, secret, expiresAt: Date.now() + 10 * 60_000 } : result;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	function run(args: string, answers: { select?: (string | undefined)[]; confirm?: boolean } = {}) {
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		remoteFactory({
			on: () => {},
			events: { on: () => {} },
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		} as never);
		const selects = [...(answers.select ?? [])];
		const ui = {
			notify: vi.fn(),
			select: vi.fn(async (_title: string, _items: string[]) => selects.shift()),
			confirm: vi.fn(async () => answers.confirm ?? false),
		};
		const done = handler!(args, { cwd: dir, isProjectTrusted: () => false, ui });
		return { ui, done };
	}

	const pairing = (pairSecret: string) => renderQr(qrMatrix(`https://${HOST}/#pair=${pairSecret}`));

	it("when off, turns on and shows the address, a QR code of the pairing link, and the code dimmed under it", async () => {
		const { ui, done } = run("");
		await done;
		expect(actions.map((a) => a.action)).toEqual(["status", "on"]);
		expect(ui.select).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledTimes(1);
		const [text, type] = ui.notify.mock.calls[0]!;
		expect(type).toBe("info");
		const lines = text.split("\n");
		expect(lines[0]).toBe(`Remote control is on: https://${HOST}`);
		expect(lines[1]).toBe("Scan with your phone's camera to pair it (valid 10 minutes, once):");
		expect(text).toContain(`\n${pairing(secret)}\n`);
		const after = text.slice(text.indexOf(pairing(secret)) + pairing(secret).length).split("\n");
		expect(after.slice(1)).toEqual([
			"\x1b[2mCan't scan? Type 482 913 in the app\x1b[22m",
			"Starts at login: off (turn it on from /remote-control)",
		]);
	});

	it("when on, offers a menu, and cancelling it changes nothing", async () => {
		enabled = true;
		const { ui, done } = run("", { select: [undefined] });
		await done;
		expect(ui.select).toHaveBeenCalledWith("Remote control is on", [
			PAIR,
			"Paired phones (2)…",
			"Start at login: off",
			OFF,
		]);
		expect(actions.map((a) => a.action)).toEqual(["status"]);
		expect(ui.notify).not.toHaveBeenCalled();
		expect(deps.launchctl).not.toHaveBeenCalled();
	});

	it("pairs a new phone with a new code's QR code", async () => {
		enabled = true;
		code = "105377";
		secret = "Zx9-_aBcDeFgHiJkLmNoPq";
		const { ui, done } = run("", { select: [PAIR] });
		await done;
		expect(actions.map((a) => a.action)).toEqual(["status", "pair"]);
		expect(ui.notify.mock.calls[0]![0]).toContain(pairing(secret));
		expect(ui.notify.mock.calls[0]![0]).toContain("Type 105 377 in the app");
	});

	it("says why it cannot pair while on but not listening, as with its port in use", async () => {
		enabled = true;
		vi.mocked(OrchestratorClient.prototype.remote).mockImplementation(async (action) => {
			actions.push(action);
			if (action.action === "pair") throw new Error("The agent daemon is out of date — restart pi to update it");
			return { enabled, port: 7878, listening: false, listenError: "listen EADDRINUSE", devices };
		});
		const { ui, done } = run("", { select: [PAIR] });
		await done;
		expect(actions.map((a) => a.action)).toEqual(["status"]);
		expect(ui.notify.mock.calls[0]).toEqual([expect.stringContaining("could not listen"), "error"]);
	});

	describe("paired phones", () => {
		const PHONES = "Paired phones (2)…";
		const REMOVE_ALL = "Remove all phones";
		const removed = () => actions.flatMap((a) => (a.action === "revoke" ? [a.deviceId] : []));

		it("lists each with when it paired and was last used, then Remove all phones", async () => {
			enabled = true;
			devices[1] = { ...devices[1]!, lastUsedAt: "2026-10-03T10:00:00.000Z" };
			const { ui, done } = run("", { select: [PHONES, undefined] });
			await done;
			const [title, items] = ui.select.mock.calls[1]!;
			expect(title).toBe("Paired phones (enter removes one)");
			expect(items).toHaveLength(3);
			expect(items[0]).toMatch(/^1\. iPhone · paired .*2026/);
			expect(items[0]).not.toContain("last used");
			expect(items[1]).toMatch(/^2\. iPad · paired .* · last used .*2026/);
			expect(items[2]).toBe(REMOVE_ALL);
			expect(actions.map((a) => a.action)).toEqual(["status", "devices"]);
			delete devices[1]!.lastUsedAt;
		});

		it("removes the phone picked, once confirmed", async () => {
			enabled = true;
			const declined = run("", { select: [PHONES, (await phoneLabel(1))!], confirm: false });
			await declined.done;
			expect(declined.ui.confirm).toHaveBeenCalledWith("Remove iPad?", "It will have to pair again.");
			expect(removed()).toEqual([]);
			const confirmed = run("", { select: [PHONES, (await phoneLabel(1))!], confirm: true });
			await confirmed.done;
			expect(removed()).toEqual(["d2"]);
			expect(confirmed.ui.notify).toHaveBeenCalledWith("Removed iPad", "info");
		});

		it("removes every phone, once confirmed", async () => {
			enabled = true;
			const declined = run("", { select: [PHONES, REMOVE_ALL], confirm: false });
			await declined.done;
			expect(declined.ui.confirm).toHaveBeenCalledWith("Remove all 2 phones?", "Each will have to pair again.");
			expect(removed()).toEqual([]);
			const confirmed = run("", { select: [PHONES, REMOVE_ALL], confirm: true });
			await confirmed.done;
			expect(removed()).toEqual(["d1", "d2"]);
			expect(confirmed.ui.notify).toHaveBeenCalledWith("Removed 2 phones", "info");
		});

		/** The menu's label for devices[index], as the list shows it. */
		async function phoneLabel(index: number): Promise<string | undefined> {
			const { ui, done } = run("", { select: [PHONES, undefined] });
			await done;
			actions = [];
			return ui.select.mock.calls[1]![1][index];
		}
	});

	it("turns start at login on, then off, saying which in the menu", async () => {
		enabled = true;
		const plist = join(deps.dir, `${LABEL}.plist`);
		const first = run("", { select: ["Start at login: off"] });
		await first.done;
		expect(existsSync(plist)).toBe(true);
		expect(first.ui.notify.mock.calls[0]![0]).toContain("starts at login now");
		const second = run("", { select: ["Start at login: on"] });
		await second.done;
		expect(second.ui.select.mock.calls[0]![1]).toContain("Start at login: on");
		expect(existsSync(plist)).toBe(false);
	});

	it("leaves start at login out where there is none", async () => {
		enabled = true;
		deps.platform = "linux";
		const { ui, done } = run("", { select: [undefined] });
		await done;
		expect(ui.select.mock.calls[0]![1]).toEqual([PAIR, "Paired phones (2)…", OFF]);
	});

	it("turns off only once confirmed", async () => {
		enabled = true;
		const declined = run("", { select: [OFF], confirm: false });
		await declined.done;
		expect(declined.ui.confirm).toHaveBeenCalledTimes(1);
		expect(actions.map((a) => a.action)).toEqual(["status"]);
		expect(enabled).toBe(true);
		const confirmed = run("", { select: [OFF], confirm: true });
		await confirmed.done;
		expect(enabled).toBe(false);
		expect(confirmed.ui.notify.mock.calls[0]![0]).toContain("Remote control is off");
	});

	it("still runs pair, devices and autostart as before, and names only /remote-control in its usage", async () => {
		enabled = true;
		const pair = run("pair");
		await pair.done;
		expect(pair.ui.select).not.toHaveBeenCalled();
		expect(pair.ui.notify.mock.calls[0]![0]).toContain(pairing(secret));
		const autostart = run("autostart");
		await autostart.done;
		expect(existsSync(join(deps.dir, `${LABEL}.plist`))).toBe(true);
		const usage = run("nope");
		await usage.done;
		expect(usage.ui.notify.mock.calls).toEqual([[USAGE, "warning"]]);
	});
});
