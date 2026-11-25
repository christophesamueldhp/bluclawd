# Linux run shells confirm their processes ended by bubblewrap's PID namespaces

ADR-0011 gave a run a shell only on macOS, where the run's Seatbelt profile names its processes. On Linux, srt runs each command under bubblewrap with `--unshare-pid` and `--die-with-parent`, and its `apply-seccomp` starts the command in a second PID namespace nested in the first. No process can leave a PID namespace: an orphan, however it detached, is re-parented to that namespace's init, so it stays in the process tree under the outer bubblewrap. When the init ends, the kernel kills everything in the namespace.

So a run's processes on Linux are the outer bubblewraps that bind the run's own temp directory (`bluclawd/run-tmp/<runId>`), and every process under them, read from `/proc`. An outer bubblewrap must run the `bwrap` binary in bluclawd's own PID namespace, which no sandboxed process is in, so no command can pass for another run's. Ending a run kills them all and reads `/proc` again until none is left, failing closed when it cannot read it. The extension and the daemon share this code (`daemon/linux-run-members.ts`), so Linux needs no native helper.

Each pi first starts a bubblewrap the same way, with a `setsid` process in it, and checks that it is found and ended and that pi itself is not taken for it. The test also refuses when srt reports no `apply-seccomp`, without which a command could hand work to a service over a Unix socket, outside its namespace.

Shown in Docker on Ubuntu 24.04 (`scripts/linux-check.sh`). WSL2 and other distributions rely on the self-test refusing where this does not hold.

Decided 2026-11-24 with #500.
