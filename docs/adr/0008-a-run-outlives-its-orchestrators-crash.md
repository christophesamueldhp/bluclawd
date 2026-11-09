# A run outlives its orchestrator's crash

Supersedes the part of ADR-0006 that says a run lives as long as its orchestrator's session: a crash does not end the session, so it no longer ends the run's work in flight. When the orchestrator's pi disappears without ending its session, the daemon leaves a working run open until its turn settles, then closes it. The run stores its Report before it is closed, and its session is kept for a Resume. A run that is idle, or waiting on a dialog, is closed at its next heartbeat. Nobody is left to answer the dialog, and with no timer it would never end. When the orchestrator's session starts again, for any reason, it takes over the runs still open on its active branch whose pane is still there, as a reload always did. It tells each one its own pane, and from then on the run reports there, and its heartbeats and ← name that pane. pi does not resume a tool call a crash cut off, so a run taken over, and a Report pulled for one, comes as a notice that wakes the orchestrator, and the run's delivery mode becomes background, as a Resume's always is. A quit, `/new`, `/resume` of another session, a fork and tree navigation end the session, and close its runs as before.

Decided 2026-11-09; the spec is GitHub issue #267, settled by comparing bluclawd's subagents with `pi/packages/durable`.

## Considered Options

- **A grace period after the orchestrator's pane is gone**: rejected. The run knows when its turn ends, so there is no timer to tune.
- **Keeping the closed run's foreground call waiting**: impossible, because pi drops a tool call that a crash cut off.

## Consequences

- A run can change orchestrator panes. It accepts the change only from its own orchestrator's session, whose id names the directory its run directory is kept in.
- A run working when its orchestrator's pane goes keeps working until its turn ends, whether or not anyone reopens the orchestrator.
- An orchestrator reopened outside tmux has no pane to take its runs over to, so it closes them, as before.
