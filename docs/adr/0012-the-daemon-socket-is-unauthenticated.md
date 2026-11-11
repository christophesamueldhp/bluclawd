# The daemon socket is unauthenticated; sandboxed shells are kept off it

The daemon's socket takes any request from any client that can connect, and several of its requests end in code running outside the sandbox: `run_queue launch` starts pi from a spec the client wrote, `wakeups` and `remote` carry an argv, `send` types into a pane's pi (a `!` line included), and the daemon's tmux socket takes `send-keys`. We keep it that way and close the one path that matters: the orchestrator's sandboxed shell can never reach bluclawd's own sockets, whatever the user's Unix-socket settings allow (#317). The sandbox profile denies the server directory's sockets after every allow, and the shell cannot read that directory.

The only client this defends against is a sandboxed shell. With the sandbox off, the orchestrator's shell already runs anything; a run's shell and its codemode scripts open no Unix socket; any other process of the same user can run code without the daemon, and the server directory is owner-only. Sockets bluclawd does not own (the user's tmux, Docker) stay under the user's settings.

## Considered options

- **A check in the daemon for each launch** (the first shape of #317): accept only runs an orchestrator the daemon knows admitted, and compare the spec with the admitted definition. Rejected. The daemon knows no orchestrator: a claim's parent is self-asserted, and the subagents root belongs to the orchestrator's agent dir, which the daemon may not share. A rule on the run directory is either forgeable or breaks orchestrators with another agent dir. The host reads the spec after the daemon answers, so the check would race. It would also have to be repeated for every other request above, and for runs relaunched from disk after a daemon restart.
- **A secret per orchestrator**: rejected for the same client. A sandboxed shell reads the agent dir and the server dir by default, so a token file protects nothing until reads are denied, and once they are, the socket is unreachable anyway.

## Consequences

- A process of the same user outside the sandbox can still start pi with a forged spec, or drive a pane through `send`. That is accepted, not a defect: `send` does not check that a command starts with `/`, and the cancel markers of `wakeups` take a client's id as a file name.
- On Linux one socket path cannot be denied, so hiding the server directory from the shell is the whole mechanism there. When this was decided it had been read in srt's code, not run; if it does not hold, the sandbox refuses to start on Linux with `allowAllUnixSockets` on.
- The promise is about Unix sockets. The remote app's HTTP listener on 127.0.0.1 keeps its own guard: a paired device's token, and a pairing secret the daemon gives only over its socket.
- Adding authentication later would touch every client of the socket: each extension, the run host's launch, the remote app's reports.

Decided 2026-11-11 for #317, which replaces residual R27 of spec #290.
