/**
 * Checks for docs/research/pane-runs-linux-and-memory.md (#390), not part of `npm test`: set BLUCLAWD_PANE_PROBE.
 * `switching` opens an explorer and a reviewer run in panes and prints tmux's clients and the panes' sizes;
 * `memory` prints the resident memory of a pane run and an RPC run of the same role, interleaved.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPaneSession } from "../daemon/run-queue.ts";
import { conversation, FAUX, hasTmux, type RealPi, startRealPi } from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

const probe = process.env.BLUCLAWD_PANE_PROBE;

function runDir(agentDir: string, name: string): { runId: string; dir: string } {
	const root = join(agentDir, "bluclawd", "subagents");
	for (const session of readdirSync(root)) {
		for (const run of readdirSync(join(root, session))) {
			const dir = join(root, session, run);
			try {
				const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8"));
				if (record.name === name) return { runId: record.runId, dir };
			} catch {
				// Not written yet.
			}
		}
	}
	throw new Error(`no run named ${name}`);
}

const tmuxOut = (real: RealPi, args: string[]) =>
	spawnSync("tmux", ["-S", real.tmux.socket, ...args], { encoding: "utf8" }).stdout.trim();
const size = (real: RealPi, pane: string) =>
	tmuxOut(real, ["display-message", "-p", "-t", `=${pane}:`, "#{window_width}x#{window_height}"]);
const clients = (real: RealPi) =>
	tmuxOut(real, ["list-clients", "-F", "#{client_name} #{client_session} #{client_width}x#{client_height}"]);

async function orchestrator(panes: boolean): Promise<RealPi> {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
	return startRealPi({ runsInPanes: panes });
}

let pi: RealPi | undefined;
afterEach(async () => {
	await pi?.stop();
	pi = undefined;
});

describe.runIf(hasTmux && probe === "switching")("pane runs: switching and size", () => {
	it("opens an explorer and a reviewer run from the panel and leaves them with ←", async () => {
		const real = await orchestrator(true);
		pi = real;
		writeFileSync(join(real.cwd, "notes.txt"), "the codeword is PELICAN\n");
		const gate = join(real.cwd, "go");
		real.script("main", [
			{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Read notes.txt.", background: true } },
			{ tool: "subagent", args: { agent: "reviewer", name: "review", task: "Review notes.txt.", background: true } },
			{ text: "waiting" },
			{ text: "one report" },
			{ text: "both reports" },
		]);
		real.script("look", [
			{ tool: "read", args: { path: "notes.txt" } },
			{ text: "Looked: PELICAN.", until: gate },
		]);
		real.script("review", [
			{ tool: "read", args: { path: "notes.txt" } },
			{ text: "Reviewed: PELICAN.", until: gate },
		]);
		const main = real.start(["--", "Delegate."]);
		// Each has read notes.txt and waits on the gate.
		await real.waitForRequests("look", 2);
		await real.waitForRequests("review", 2);
		await real.waitForRequests("main", 3);
		const panes = { look: runPaneSession(runDir(real.agentDir, "look").runId, 0), review: "" };
		panes.review = runPaneSession(runDir(real.agentDir, "review").runId, 0);
		console.log(`tmux ${tmuxOut(real, ["-V"])}`);
		console.log(
			`before any client: main ${size(real, main)}, look ${size(real, panes.look)}, review ${size(real, panes.review)}`,
		);
		console.log(`clients before attach: [${clients(real)}]`);
		real.attach(main);
		await waitFor(() => expect(real.shown()).toBe(main));
		console.log(`clients after attach: [${clients(real)}]`);
		// tmux 3.4 shows the config's errors to the first client in view mode, over the pane; the user leaves it with q.
		const mode = tmuxOut(real, ["display-message", "-p", "-t", `=${main}:`, "#{pane_mode}"]);
		if (mode) {
			console.log(`main is in ${mode} after attach; leaving it`);
			tmuxOut(real, ["send-keys", "-X", "-t", `=${main}:`, "cancel"]);
		}
		const screen = () => real.tmux.capture(main, 80).join("\n");
		await waitFor(() => expect(screen()).toMatch(/^\s+look\s+explorer\s/m));
		await waitFor(() => expect(screen()).toMatch(/^\s+review\s+reviewer\s/m));

		const opened: string[] = [];
		for (const keys of [
			["Down", "Enter"],
			["Down", "Down", "Enter"],
		]) {
			real.tmux.sendKeys(main, keys);
			const shown = await waitFor(() => {
				const now = real.shown();
				expect([panes.look, panes.review]).toContain(now);
				return now ?? "";
			});
			opened.push(shown);
			const name = shown === panes.look ? "look" : "review";
			console.log(`opened ${name}: clients [${clients(real)}], ${name} ${size(real, shown)}`);
			await waitFor(() => expect(real.tmux.capture(shown, 200).join("\n")).toContain("notes.txt"));
			real.tmux.sendKeys(shown, ["Left"]);
			await waitFor(() => expect(real.shown()).toBe(main));
			console.log(
				`left ${name}: clients [${clients(real)}], ${name} ${size(real, shown)}, main ${size(real, main)}`,
			);
		}
		expect(new Set(opened)).toEqual(new Set([panes.look, panes.review]));

		writeFileSync(gate, "");
		// Both Reports reach the orchestrator, in one request or two.
		await waitFor(() => {
			const last = real.requests("main").at(-1);
			const told = last
				? conversation(last)
						.map((m) => m.text)
						.join("\n")
				: "";
			expect(told).toContain("Looked: PELICAN.");
			expect(told).toContain("Reviewed: PELICAN.");
		});
		await waitFor(() => expect(real.tmux.hasSession(panes.look) || real.tmux.hasSession(panes.review)).toBe(false));
		console.log(`both reports in; run panes closed; clients [${clients(real)}]`);
	}, 120_000);
});

/** Resident memory in KiB of `root` and its descendants, by pid. */
function tree(root: number): Map<number, { rss: number; command: string }> {
	const rows = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
		.stdout.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), command: m[4] }));
	const found = new Map<number, { rss: number; command: string }>();
	const visit = (pid: number) => {
		const row = rows.find((r) => r.pid === pid);
		if (!row || found.has(pid)) return;
		found.set(pid, { rss: row.rss, command: row.command });
		for (const child of rows.filter((r) => r.ppid === pid)) visit(child.pid);
	};
	visit(root);
	return found;
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mib = (kib: number) => (kib / 1024).toFixed(1);

describe.runIf(hasTmux && probe === "memory")("pane runs: resident memory", () => {
	it("measures an explorer run in a pane and on RPC, interleaved", async () => {
		const samples = Number(process.env.BLUCLAWD_PANE_PROBE_SAMPLES ?? 5);
		const settleMs = Number(process.env.BLUCLAWD_PANE_PROBE_SETTLE_MS ?? 5000);
		const results: Record<"pane" | "rpc", { host: number[]; pi: number[]; total: number[] }> = {
			pane: { host: [], pi: [], total: [] },
			rpc: { host: [], pi: [], total: [] },
		};
		for (let i = 0; i < samples; i++) {
			for (const kind of i % 2 ? (["rpc", "pane"] as const) : (["pane", "rpc"] as const)) {
				const real = await orchestrator(kind === "pane");
				pi = real;
				real.script("main", [
					{ tool: "subagent", args: { agent: "explorer", name: "look", task: "Look.", background: true } },
					{ text: "waiting" },
				]);
				real.script("look", [{ text: "Looked.", until: join(real.cwd, "never") }]);
				real.start(["--", "Delegate."]);
				await real.waitForRequests("look", 1);
				const { runId, dir } = runDir(real.agentDir, "look");
				expect(real.tmux.hasSession(runPaneSession(runId, 0))).toBe(kind === "pane");
				await new Promise((resolve) => setTimeout(resolve, settleMs));
				const state = JSON.parse(readFileSync(join(dir, "rpc-host.json"), "utf8"));
				const procs = tree(state.hostPid);
				const host = procs.get(state.hostPid)?.rss ?? 0;
				const child = procs.get(state.childPid)?.rss ?? 0;
				const total = [...procs.values()].reduce((sum, p) => sum + p.rss, 0);
				results[kind].host.push(host);
				results[kind].pi.push(child);
				results[kind].total.push(total);
				const pressure =
					process.platform === "darwin"
						? spawnSync("memory_pressure", [], { encoding: "utf8" }).stdout.match(/free percentage: (\d+%)/)?.[1]
						: undefined;
				console.log(
					`sample ${i + 1} ${kind}: host ${mib(host)} MiB, pi ${mib(child)} MiB, tree ${mib(total)} MiB ` +
						`(${procs.size} processes: ${[...procs.values()].map((p) => p.command.split(" ").slice(0, 2).join(" ")).join(" | ")}); ` +
						`load ${loadavg()
							.map((l) => l.toFixed(2))
							.join(" ")}${pressure ? `; memory free ${pressure}` : ""}`,
				);
				await real.stop();
				pi = undefined;
			}
		}
		for (const kind of ["pane", "rpc"] as const) {
			const r = results[kind];
			const line = (key: "host" | "pi" | "total") =>
				`${key} median ${mib(median(r[key]))} MiB (range ${mib(Math.min(...r[key]))}–${mib(Math.max(...r[key]))})`;
			console.log(`${kind} over ${samples}: ${line("host")}, ${line("pi")}, ${line("total")}`);
		}
	}, 900_000);
});
