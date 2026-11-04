import { describe, expect, it } from "vitest";
import type { StartSpec } from "../daemon/ipc/protocol.ts";
import { resumePane, type StartClaims, startNewPane } from "../daemon/pane-start.ts";
import { startSession } from "../daemon/remote/spawn.ts";
import { OPEN_VIEW_ENV, PANE_ENV, Tmux } from "../daemon/tmux.ts";
import { testRegistry } from "./helpers/registry.ts";

const CWD = "/p";
const FILE = "/s/a.jsonl";

/** A tmux whose every command is recorded, failing when told to. */
function fakeTmux(fail = false) {
	const calls: string[][] = [];
	const tmux = new Tmux("/nonexistent", (args) => {
		calls.push(args);
		if (fail) throw new Error("tmux: no server");
		return "";
	});
	return { tmux, calls };
}

/** The phone's claims: the daemon's supervisor, asked directly; a refusal is thrown. */
function phoneClaims() {
	const registry = testRegistry();
	const claims: StartClaims = {
		start: (spec: StartSpec) => {
			if ("pane" in spec) {
				registry.paneStarting(spec);
				return spec.pane;
			}
			const claim = registry.claimStart(spec);
			if (!claim.ok) throw new Error(claim.refused);
			return claim.id;
		},
		startFailed: (id) => registry.startFailed(id),
	};
	return { registry, claims };
}

/** The phone's spawner: the daemon's tmux, running the pane-reported pi. */
const phoneSpawner = (tmux: Tmux) => () =>
	startSession({ cwd: CWD, sessionFile: FILE, task: "", launch: { command: ["/usr/bin/node", "/pi/cli.js"] }, tmux });

describe("starting a pane on a session file", () => {
	it("claims the file first, then starts its pane, listed as starting under the claimed row", async () => {
		const { registry, claims } = phoneClaims();
		const { tmux, calls } = fakeTmux();
		const { id, pane } = await resumePane(claims, { cwd: CWD, sessionFile: FILE }, phoneSpawner(tmux));
		expect(pane).toMatch(/^pi-[0-9a-f]{8}$/);
		expect(calls[0].slice(0, 4)).toEqual(["new-session", "-d", "-s", pane]);
		expect(registry.listInstances()).toEqual([
			expect.objectContaining({ id, status: "starting", sessionFile: FILE }),
		]);
	});
});

/** Agent view's claims: the daemon over IPC, which rejects a refused start with why; every call recorded. */
function viewClaims(refuse?: string) {
	const calls: unknown[][] = [];
	const claims: StartClaims = {
		start: async (spec) => {
			calls.push(["claim", spec]);
			if (refuse) throw new Error(refuse);
			return "pane" in spec ? spec.pane : "row-1";
		},
		startFailed: async (id) => {
			calls.push(["startFailed", id]);
		},
	};
	return { calls, claims };
}

/** Agent view's spawner: tmux in the pane's own process, with agent view's environment and its terminal's size. */
const viewSpawner = (tmux: Tmux, args: string[]) => () =>
	tmux.newSession({ cwd: CWD, args, env: { [OPEN_VIEW_ENV]: "1" } });

describe("starting a pane on a session file, refused or failing", () => {
	it("a refused claim starts nothing, from either side", async () => {
		const phone = phoneClaims();
		expect(phone.registry.claimStart({ cwd: CWD, sessionFile: FILE })).toMatchObject({ ok: true });
		const phoneTmux = fakeTmux();
		await expect(
			resumePane(phone.claims, { cwd: CWD, sessionFile: FILE }, phoneSpawner(phoneTmux.tmux)),
		).rejects.toThrow("starting");
		expect(phoneTmux.calls).toEqual([]);

		const view = viewClaims("it is already open in a pane");
		const viewTmux = fakeTmux();
		await expect(
			resumePane(view.claims, { cwd: CWD, sessionFile: FILE }, viewSpawner(viewTmux.tmux, ["--session", FILE])),
		).rejects.toThrow("it is already open in a pane");
		expect(viewTmux.calls).toEqual([]);
		expect(view.calls).toEqual([["claim", { cwd: CWD, sessionFile: FILE }]]);
	});

	it("a pane the phone cannot start gives its claim back, leaving the file free to resume", async () => {
		const { registry, claims } = phoneClaims();
		await expect(
			resumePane(claims, { cwd: CWD, sessionFile: FILE }, phoneSpawner(fakeTmux(true).tmux)),
		).rejects.toThrow("tmux: no server");
		expect(registry.listInstances()).toEqual([]);
		expect(registry.claimStart({ cwd: CWD, sessionFile: FILE })).toMatchObject({ ok: true });
	});

	it("a pane agent view cannot start gives its claim back, and says tmux's reason", async () => {
		const { calls, claims } = viewClaims();
		await expect(
			resumePane(claims, { cwd: CWD, sessionFile: FILE }, viewSpawner(fakeTmux(true).tmux, ["--session", FILE])),
		).rejects.toThrow("tmux: no server");
		expect(calls).toEqual([
			["claim", { cwd: CWD, sessionFile: FILE }],
			["startFailed", "row-1"],
		]);
	});

	it("a claim that cannot be given back still fails with the spawn's reason", async () => {
		const { claims } = viewClaims();
		claims.startFailed = async () => {
			throw new Error("daemon gone");
		};
		await expect(
			resumePane(claims, { cwd: CWD, sessionFile: FILE }, viewSpawner(fakeTmux(true).tmux, ["--session", FILE])),
		).rejects.toThrow("tmux: no server");
	});

	it("agent view's pane keeps agent view's environment", async () => {
		const { claims } = viewClaims();
		const { tmux, calls } = fakeTmux();
		const { pane } = await resumePane(
			claims,
			{ cwd: CWD, sessionFile: FILE },
			viewSpawner(tmux, ["--session", FILE]),
		);
		expect(calls[0]).toContain(`${OPEN_VIEW_ENV}=1`);
		expect(calls[0]).toContain(`${PANE_ENV}=${pane}`);
		expect(calls[0].slice(-2)).toEqual(["--session", FILE]);
	});
});

describe("starting a new session's pane", () => {
	it("starts the pane first, then lists it as starting under its own name, at once for the phone", () => {
		const { registry, claims } = phoneClaims();
		const { tmux } = fakeTmux();
		const { pane } = startNewPane(claims, { cwd: CWD, label: "fix it" }, () =>
			startSession({ cwd: CWD, task: "fix it", launch: { command: ["/usr/bin/node", "/pi/cli.js"] }, tmux }),
		);
		expect(registry.listInstances()).toEqual([
			expect.objectContaining({ id: pane, pane, status: "starting", label: "fix it" }),
		]);
	});

	it("hands agent view its pane before the daemon answers the claim, and lets a refused claim go", async () => {
		const calls: unknown[][] = [];
		let refuse: (error: Error) => void = () => {};
		const claims: StartClaims = {
			start: (spec) => {
				calls.push(["claim", spec]);
				return new Promise((_, reject) => {
					refuse = reject;
				});
			},
			startFailed: (id) => calls.push(["startFailed", id]),
		};
		const { tmux } = fakeTmux();
		const { pane, claimed } = startNewPane(
			claims,
			{ cwd: CWD, label: "fix it" },
			viewSpawner(tmux, ["--", "fix it"]),
		);
		expect(calls).toEqual([["claim", { cwd: CWD, label: "fix it", pane }]]);
		refuse(new Error("daemon gone"));
		await claimed;
		expect(calls).toHaveLength(1);
	});

	it("a pane that cannot start claims nothing", () => {
		const { registry, claims } = phoneClaims();
		expect(() => startNewPane(claims, { cwd: CWD }, viewSpawner(fakeTmux(true).tmux, ["--", "go"]))).toThrow(
			"tmux: no server",
		);
		expect(registry.listInstances()).toEqual([]);
	});
});
