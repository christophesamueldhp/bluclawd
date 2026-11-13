import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Tmux } from "../daemon/tmux.ts";
import { waitFor } from "./helpers/wait-for.ts";

describe.skipIf(!Tmux.available())("the private tmux server's config", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (!dir) return;
		spawnSync("tmux", ["-S", join(dir, "tmux.sock"), "kill-server"]);
		spawnSync("tmux", ["-S", join(dir, "t.sock"), "kill-server"]);
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("applies without an error, so the first terminal to attach shows the pane, not tmux's view mode", async () => {
		dir = mkdtempSync(join(tmpdir(), "bc-tmux-config-"));
		const tmux = new Tmux(dir);
		const pane = tmux.newSession({ cwd: dir, args: [], command: ["sleep", "3600"] });
		// The terminal is a pane of another tmux server, running a client of the private one.
		const attach = `env -u TMUX tmux -S '${tmux.socket}' attach-session -t '=${pane}'`;
		const terminal = join(dir, "t.sock");
		spawnSync("tmux", ["-S", terminal, "-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", attach]);
		await waitFor(() => expect(tmux.shown(pane)).toBe(true));

		const ask = (...args: string[]) => spawnSync("tmux", ["-S", tmux.socket, ...args], { encoding: "utf8" });
		expect(ask("display-message", "-p", "-t", `=${pane}:`, "#{pane_mode}").stdout.trim()).toBe("");
		const format = ask("show-options", "-gv", "extended-keys-format");
		// tmux 3.3 and 3.4 have no such option.
		if (format.status === 0) expect(format.stdout.trim()).toBe("csi-u");
		else expect(format.stderr).toMatch(/invalid option: extended-keys-format/);
	});
});
