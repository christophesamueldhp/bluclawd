# Pane runs on Linux, and their memory (#390)

The faux-model checks of pane runs (ADR-0013) that #345 left open: tmux's switching and a run pane's size on Linux, and a pane run's resident memory beside an RPC run's. Split from #359, whose real-provider check stays parked. Run on 2026-11-12 and 13 at `5eac274` plus the probe this record adds, `test/pane-run-probe.test.ts`. No real provider was called.

## Results

- **Linux, as shipped: 5 of the 10 tests in `subagent-pane-runs` fail or hang, from one cause.** tmux 3.4 (Ubuntu 24.04) refuses line 7 of the private server's config, `set -g extended-keys-format csi-u`, an option tmux 3.4 does not have (tmux 3.6b, on macOS, has it). tmux shows that error to the first client that attaches, in view mode over the pane. Until the user leaves view mode with `q`, every key goes to view mode, not pi. A `send-keys` of `/` opens view mode's search prompt and never returns, which hangs a test for good. Every other line of the config still applies. Filed as #397: see [Open](#open).
- **Linux, with that error out of the way, behaves as on macOS.** With the error dismissed as a user would, or with the line deleted in the container's copy, opening an `explorer` and a `reviewer` run from the panel switches the client to the run's pane, ← switches it back, and both Reports arrive. All 26 pane-run tests pass with the line deleted.
- **Pane size is the same on both:** 80x24 while no client shows the pane, then the size of the client that opens it (120x40 here), which it keeps after ←.
- **Memory (macOS, faux, `explorer`, 8 samples each): a pane run's host and pi took a median of 313.9 MiB of RSS, an RPC run's 272.2 MiB, about 42 MiB more.** All of it is in the run's pi: 156.8 MiB in a pane against 116.8 MiB on RPC. The host is about 156 MiB in both. That is round 2, taken at a load of 5 to 18. Round 1, at a load of up to 92, was too noisy to quote. Linux in the container agrees: +32 MiB in pi, host equal.

## Linux

### Setup

- Docker Desktop VM, `docker run --privileged ubuntu:24.04`, as for #327. Tests ran as an unprivileged user, `uid=1001(dev)`, with `LANG=C.UTF-8`. No host environment or credentials went in.
- The tree came from `git archive` of the index (`5eac274` plus the probe), followed by `npm ci` inside the container.
- `uname -a`: `Linux 95cab5ca5ba9 7.0.12-linuxkit #1 SMP PREEMPT Thu Aug 27 14:02:21 UTC 2026 aarch64 aarch64 aarch64 GNU/Linux`.
- Ubuntu 24.04.5 LTS, **tmux 3.4** from the distribution, Node 26.8.1 (the official linux-arm64 build, the host's version; it needs `libatomic1`), npm 11.19.0, git 2.43.0, pi 1.5.2.
- macOS for comparison: macOS 27.2, Apple M4, tmux 3.6b, Node 26.8.1.

Commands, from the worktree:

```sh
git add test/pane-run-probe.test.ts
docker run -d --privileged --name bc390-linux -e LANG=C.UTF-8 ubuntu:24.04 sleep infinity
docker exec bc390-linux mkdir -p /work/bluclawd
git archive "$(git write-tree)" | docker exec -i bc390-linux tar -x -C /work/bluclawd
docker exec bc390-linux sh -c '
  apt-get update -qq &&
  apt-get install -y -qq tmux git ca-certificates curl xz-utils procps ripgrep bubblewrap socat libatomic1 &&
  curl -fsSL https://nodejs.org/dist/v26.8.1/node-v26.8.1-linux-arm64.tar.xz | tar -xJ -C /opt &&
  ln -s /opt/node-v26.8.1-linux-arm64/bin/node /opt/node-v26.8.1-linux-arm64/bin/npm /opt/node-v26.8.1-linux-arm64/bin/npx /usr/local/bin/ &&
  useradd -m -u 1001 dev && chown -R dev:dev /work &&
  su dev -c "cd /work/bluclawd && npm ci --no-audit --no-fund"'
# Each test, as dev:
docker exec bc390-linux su dev -c 'cd /work/bluclawd && LANG=C.UTF-8 npx vitest run <file> [-t <name>] --reporter=verbose'
# The probe, as dev:
docker exec bc390-linux su dev -c 'cd /work/bluclawd && LANG=C.UTF-8 BLUCLAWD_PANE_PROBE=switching npx vitest run test/pane-run-probe.test.ts --silent=false --reporter=verbose'
```

A test that hangs in `send-keys` blocks vitest's worker in `spawnSync`, so no test timeout ends it. While the tests ran, a watchdog in the container, as root, killed every process of `dev` once a `send-keys` was older than 60 s:

```sh
while true; do
  for p in $(pgrep -u dev -f send-keys); do
    [ "$(ps -o etimes= -p $p | tr -d ' ')" -gt 60 ] && pkill -KILL -u dev
  done
  sleep 5
done
```

Each test of `subagent-pane-runs` ran alone, by its name (`-t`, regex characters escaped), with `pkill -KILL -u dev; rm -rf /tmp/bc-real-*` in the container after each. For the "line 7 deleted" column, the line was removed from the container's copy only, then the three files ran together:

```sh
docker exec bc390-linux sed -i '/extended-keys-format/d' /work/bluclawd/daemon/tmux.ts
docker exec bc390-linux su dev -c 'cd /work/bluclawd && LANG=C.UTF-8 npx vitest run test/subagent-pane-runs.test.ts test/subagent-pane-child.test.ts test/daemon-run-queue.test.ts --reporter=verbose'
```

 `sleep infinity` as PID 1 reaps nothing, so ended tmux servers and pis stay as zombies until the container goes; no result below depends on one.

### The pane-run tests

`test/subagent-pane-runs.test.ts` (each test alone), `test/subagent-pane-child.test.ts` and `test/daemon-run-queue.test.ts`. On macOS all 26 pass.

| Test (`subagent-pane-runs`) | Linux, as shipped | Linux, line 7 deleted |
|---|---|---|
| works in a pane the user can watch… | pass | pass |
| asks the user for an approval in its own pane… | pass | pass |
| keeps an approval waiting while its orchestrator is there… | pass | pass |
| follows its orchestrator to the pane its session is reopened in… | **fail**: the run's model never got its second request (Enter went to view mode, not the approval) | pass |
| stops when its orchestrator stops it… | pass | pass |
| opens from its orchestrator's panel by switching the terminal… | **fail**: `expected 'pi-0e668936' to be 'sub_…-0'` (Down, Enter went to view mode) | pass |
| resumes once finished in a pane… opened from /tasks | **hang**: `send-keys … /tasks Enter` never returned (killed after 814 s) | pass |
| ends with nothing done when the user looks at a finished run… | **hang**: the same `send-keys`, killed | pass |
| holds its work for the user after Esc in its pane… | **fail**: `expected 'pi-07b6f8ae' to be 'sub_…-0'` | pass |
| gives its model the same system prompt and tools as… RPC | pass | pass |

`subagent-pane-child` (2 tests) and `daemon-run-queue` (14 tests) pass on Linux as shipped. With line 7 deleted, the three files give `Tests 26 passed (26)`.

The tests that pass as shipped either attach no terminal, so no client is shown the error, or move the terminal only with `switch-client` (`moveClients`), which view mode does not stop. The others send keys to a pane after a terminal has attached.

### Why: tmux 3.4 and `extended-keys-format`

Reproduced without pi, as `dev` in the container, with the config `daemon/tmux.ts` writes:

```
$ D=$(mktemp -d); cd /work/bluclawd
$ node -e 'process.stdout.write(require("fs").readFileSync("daemon/tmux.ts","utf8").match(/const CONFIG = `([^`]*)`/)[1])' > $D/tmux.conf
$ tmux -S $D/s.sock -f $D/tmux.conf new-session -d -s main -x 80 -y 24 cat
$ tmux -S $D/s.sock show -gv history-limit; tmux -S $D/s.sock show -gv window-size; tmux -S $D/s.sock show -gv extended-keys
10000
latest
always
$ tmux -S $D/t.sock -f /dev/null new-session -d -x 120 -y 40 "env -u TMUX tmux -S $D/s.sock attach-session -t =main"
$ tmux -S $D/s.sock display -p -t =main: '#{pane_mode}'
view-mode
$ tmux -S $D/t.sock capture-pane -p      # what the terminal shows
/tmp/bc390-repro-6YmUkX/tmux.conf:7: invalid option: extended-keys-format                                          [0/0]
$ timeout 5 tmux -S $D/s.sock send-keys -t =main: /tasks Enter; echo $?
124
$ tmux -S $D/t.sock capture-pane -p
/tmp/bc390-repro-6YmUkX/tmux.conf:7: invalid option: extended-keys-format                                          [0/0]
(jump to forward)
```

- The server starts without a client (`new-session -d`), as agent view's launcher (`ext/agent-view/launch.ts`: `newSession`, then `attach`) and the tests start it. The first client to attach gets the config's errors.
- `history-limit`, set after line 7, is applied, so the rest of the config holds. Deleting the line removes the error; tmux 3.4 then encodes modified keys in its default extended-key format. The tests above send only unmodified keys (Left, Down, Escape, Enter and text), so they do not show that pi reads modified keys, such as Shift+Enter, in that format.
- The real `pi` launch was not run in the container. That it shows the same error rests on the launcher starting the server the same way.

### Switching and pane size

`BLUCLAWD_PANE_PROBE=switching` starts an orchestrator pane, which launches an `explorer` run and a `reviewer` run in panes of their own. Both read a file and then wait on a gate. It attaches a terminal of 120x40, opens each run from the orchestrator's panel (↓, then ⏎) and leaves it with ←. Each line below prints tmux's `list-clients` (`client session size`) and the `window_width`x`window_height` of the panes. On Linux as shipped, the probe first leaves view mode, as the user would with `q`.

macOS, tmux 3.6b (the probe's final version printed the same on a later run):

```
before any client: main 80x24, look 80x24, review 80x24
clients before attach: []
clients after attach: [/dev/ttys016 pi-2fee26a0 120x40]
opened look: clients [/dev/ttys016 sub_bb1f4117-…-0 120x40], look 120x40
left look: clients [/dev/ttys016 pi-2fee26a0 120x40], look 120x40, main 120x40
opened review: clients [/dev/ttys016 sub_8859aae2-…-0 120x40], review 120x40
left review: clients [/dev/ttys016 pi-2fee26a0 120x40], review 120x40, main 120x40
both reports in; run panes closed; clients [/dev/ttys016 pi-2fee26a0 120x40]
```

Linux, tmux 3.4, as shipped:

```
before any client: main 80x24, look 80x24, review 80x24
clients before attach: []
clients after attach: [/dev/pts/3 pi-aeef60cb 120x40]
main is in view-mode after attach; leaving it
opened look: clients [/dev/pts/3 sub_c623ba97-…-0 120x40], look 120x40
left look: clients [/dev/pts/3 pi-aeef60cb 120x40], look 120x40, main 120x40
opened review: clients [/dev/pts/3 sub_04d8a662-…-0 120x40], review 120x40
left review: clients [/dev/pts/3 pi-aeef60cb 120x40], review 120x40, main 120x40
both reports in; run panes closed; clients [/dev/pts/3 pi-aeef60cb 120x40]
```

The probe passed twice more on Linux as shipped, and twice with line 7 deleted, with the same sizes and the same moves; with line 7 deleted there is no view mode to leave. One earlier Linux run failed on a race in the probe itself (it waited for exactly one request from a run that had already made two), fixed before these runs.

- **Switching:** the same on both. Opening a run moves the one client to the run's session; ← moves it back. When the run ends, its pane closes and the client stays on the orchestrator.
- **Size:** the same on both. The daemon starts a run's pane with no size (`startRunHost` passes no `-x`/`-y`), so tmux gives it 80x24. With `window-size latest`, it takes the size of the client that opens it and keeps that size after the client leaves. The orchestrator's pane here also starts at 80x24 because the test starts it from a process with no terminal. A `pi` started in a terminal gets that terminal's size.

## Memory

### Method

`BLUCLAWD_PANE_PROBE=memory` on macOS, in the worktree:

```sh
BLUCLAWD_PANE_PROBE=memory BLUCLAWD_PANE_PROBE_SAMPLES=8 BLUCLAWD_PANE_PROBE_SETTLE_MS=8000 \
  npx vitest run test/pane-run-probe.test.ts --silent=false --reporter=verbose
```

- **One sample** is one fresh orchestrator, with `subagents.panes` on for a pane run or off for an RPC run. It launches one `explorer` run in the background. The run's model holds its first request on a gate that never opens, so both kinds are measured at the same point, with no client showing the pane.
- **When:** 8 s after the run's first model request.
- **What is summed:** `ps -o rss` of the run's host (`hostPid` in `rpc-host.json`) and every descendant. In every sample that was two processes: the host (`node --import … rpc-host.ts`) and the run's pi (`childPid`). The orchestrator, the daemon and tmux are not counted.
- **Order:** pane and RPC alternate (pane first in odd samples, RPC first in even ones), so drift in the machine's load falls on both.
- **Machine state:** the load average (`os.loadavg()`) and `memory_pressure`'s free percentage are printed with each sample. Three other agents ran tests on this machine at the time.
- **Caveats:**
  - RSS counts shared pages in both processes.
  - macOS compresses idle pages under memory pressure, which lowers RSS. One host read 8.6 MiB in round 1, most likely compressed rather than small.
  - `HOME` is a temporary directory, so the user's pistatusline, which a pane run loads when the user has it (ADR-0013), was not loaded. A user's pane run may be larger.

### Round 1: 2026-11-12 23:29–23:32, 8 samples each

Load average (1 min) 9.9 at the start, up to 91.6, 67.1 at the end; memory free 33–59%.

RSS in MiB, host / pi / sum, with the 1-minute load average and memory free when sampled:

| Sample | Pane run | Load, free | RPC run | Load, free |
|---|---|---|---|---|
| 1 | 71.5 / 125.5 / 197.0 | 9.9, 42% | 65.6 / 90.7 / 156.3 | 23.2, 39% |
| 2 | 123.6 / 122.3 / 245.9 | 76.7, 41% | 118.3 / 76.5 / 194.8 | 48.0, 33% |
| 3 | 8.6 / 50.8 / 59.4 | 78.8, 33% | 108.0 / 82.9 / 190.9 | 84.3, 45% |
| 4 | 118.2 / 124.5 / 242.7 | 90.1, 46% | 130.8 / 98.6 / 229.4 | 91.6, 45% |
| 5 | 134.6 / 139.3 / 273.8 | 87.8, 50% | 121.0 / 75.8 / 196.8 | 84.6, 36% |
| 6 | 133.9 / 145.5 / 279.4 | 87.3, 51% | 47.5 / 63.7 / 111.3 | 86.6, 37% |
| 7 | 155.8 / 158.0 / 313.8 | 84.1, 52% | 155.1 / 112.8 / 267.8 | 70.8, 54% |
| 8 | 155.3 / 154.4 / 309.7 | 67.1, 59% | 155.9 / 117.9 / 273.8 | 78.3, 59% |
| **Median** | **128.7 / 132.4 / 259.9** | | **119.6 / 86.8 / 195.8** | |
| Range | 8.6–155.8 / 50.8–158.0 / 59.4–313.8 | | 47.5–155.9 / 63.7–117.9 / 111.3–273.8 | |

The pane run's pi had more RSS than the RPC run's pi in 7 of the 8 pairs. The exception is sample 3, whose pane run read low in both processes, most likely from compression.

### Round 2: 2026-11-13 00:18–00:21, 8 samples each

Started once the 1-minute load average fell under 20 (on 10 cores). Load 17.7 at the first sample and 5.8 at the last; memory free 56–71%. Other agents still ran on the machine, but more lightly than in round 1.

| Sample | Pane run | Load, free | RPC run | Load, free |
|---|---|---|---|---|
| 1 | 156.1 / 160.1 / 316.1 | 17.7, 63% | 156.4 / 112.0 / 268.4 | 16.0, 62% |
| 2 | 154.8 / 157.1 / 311.9 | 13.9, 57% | 121.3 / 80.1 / 201.4 | 15.5, 60% |
| 3 | 154.3 / 154.9 / 309.2 | 12.2, 56% | 158.2 / 120.7 / 278.9 | 10.8, 64% |
| 4 | 155.5 / 158.7 / 314.2 | 8.7, 67% | 157.8 / 120.4 / 278.2 | 9.7, 63% |
| 5 | 155.9 / 159.8 / 315.6 | 9.3, 67% | 157.6 / 113.2 / 270.8 | 8.4, 70% |
| 6 | 158.0 / 156.3 / 314.2 | 6.7, 69% | 156.8 / 119.8 / 276.7 | 7.7, 69% |
| 7 | 157.2 / 155.2 / 312.4 | 6.3, 70% | 154.0 / 119.5 / 273.5 | 5.9, 70% |
| 8 | 157.0 / 156.5 / 313.5 | 5.8, 67% | 156.4 / 114.0 / 270.4 | 5.5, 71% |
| **Median** | **156.0 / 156.8 / 313.9** | | **156.6 / 116.8 / 272.2** | |
| Range | 154.3–158.0 / 154.9–160.1 / 309.2–316.1 | | 121.3–158.2 / 80.1–120.7 / 201.4–278.9 | |

RPC sample 2 is low in both processes, as round 1's outliers were, most likely from compression rather than a smaller run. Without it the RPC medians barely move (156.8 / 119.5 / 273.5).

### Reading the two rounds

Round 2 is the figure to quote: **a pane run takes a median of 313.9 MiB, an RPC run 272.2 MiB, so a pane run costs about 42 MiB more.** The whole difference is in the run's pi (156.8 against 116.8 MiB); the host is the same size for both. Linux agrees on the shape (below: +32 MiB in pi, host equal). Round 1, under a load of up to 92, saw the same direction with a lot of noise and is kept only as the record of what was run. The machine was not idle in round 2 either, so an idle rerun could move these by a few MiB; with round 2's spread under 7 MiB for a pane run, a rerun is not needed to conclude that the cost is about 42 MiB a run.

### Linux, for comparison

The same probe in the container, 5 samples each, 8 s settle: `BLUCLAWD_PANE_PROBE=memory BLUCLAWD_PANE_PROBE_SAMPLES=5 BLUCLAWD_PANE_PROBE_SETTLE_MS=8000`. The VM had 13.6 GiB, 12.3 GiB of it available after the runs, and its own load average stayed under 0.9. These numbers vary far less than macOS's. They come from a different OS and are not the brief's macOS figure.

| | Host | pi | Sum |
|---|---|---|---|
| Pane run, median (range) | 156.8 (156.4–163.1) | 148.3 (142.0–150.6) | 305.4 (298.5–311.5) |
| RPC run, median (range) | 156.7 (155.4–164.6) | 116.5 (108.3–118.6) | 275.3 (265.0–281.0) |

The host is the same size for both kinds. The pane run's pi had more RSS than the RPC run's pi in every pair, by 31.8 MiB at the median. What a pane run's pi loads beyond an RPC run's is the likely cause: interactive mode with its TUI, `pane-child.ts`, and the eight extensions that draw the pane (ADR-0013). This was not broken down further.

## Open

- **Filed as #397.** Draft as filed:
  - **Title:** Agent view on tmux 3.4: the private server's config error covers the first pane and takes its keys
  - **Body:** tmux 3.4, Ubuntu 24.04's, refuses `set -g extended-keys-format csi-u` in the private server's config (`daemon/tmux.ts`). The rest of the config applies. tmux shows the error (`tmux.conf:7: invalid option: extended-keys-format`) to the first client that attaches, in view mode over the pane. Until the user presses `q`, keys go to view mode, not pi; a `send-keys` of `/` opens view mode's search and never returns. 5 of the 10 tests in `test/subagent-pane-runs.test.ts` fail or hang there; all pass with the line removed. Evidence and repro: `docs/research/pane-runs-linux-and-memory.md`, "Why: tmux 3.4 and `extended-keys-format`".
  - **Acceptance:** on tmux 3.4, the first terminal to attach shows pi, not view mode; `test/subagent-pane-runs.test.ts` passes in an Ubuntu 24.04 container; macOS keeps `csi-u`.
  - **Not shown, to settle in the issue:** whether pi reads modified keys (such as Shift+Enter) in tmux 3.4's default extended-key format; whether the real `pi` launch shows the error (expected, as it starts the server the same way, but not run); tmux versions other than 3.4 and 3.6b; whether the README should state a minimum tmux version (none is documented).
- Optional: re-measure memory on an idle machine (see [Reading the two rounds](#reading-the-two-rounds)).
- The real-provider check stays with #359.

## Clean-up

The container `bc390-linux` was removed with `docker rm -f`; `ubuntu:24.04` was already on the machine and stays. Each probe and test run on macOS ends its own daemon, panes and `bc-real-*` directory (`startRealPi`'s `stop`). Afterwards, `docker ps -a --filter name=bc390` listed nothing, and neither `ps -axww -o pid=,command=` nor `ps eww -ax` (which shows each process's environment, so a `pi` or a tmux server started from this worktree) matched `bluclawd-390`. The `bc-real-*` directories of the two probe runs that failed on macOS were gone.
