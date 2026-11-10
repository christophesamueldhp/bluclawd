# A run outlives its orchestrator's crash

Supersedes the part of ADR-0006 that says a run lives as long as its orchestrator's session: a crash does not end the session. When the orchestrator's pi disappears without ending its session, a working run finishes its turn, stores its Report, and is then closed; an idle one is closed at once. When the session starts again, it takes over the runs still open on its branch, as a reload always did. pi does not resume a tool call a crash cut off, so a run taken over, and a Report pulled for one, comes as a notice, and the run goes on in the background. Ending the session (a quit, `/new`, `/resume` of another session, a fork, tree navigation) still closes its runs.

Decided 2026-11-09; the spec is GitHub issue #267, settled by comparing bluclawd's subagents with `pi/packages/durable`.

## Considered Options

- **A grace period after the orchestrator's pane is gone**: rejected. The run knows when its turn ends, so there is no timer to tune.
- **Keeping a run that waits on a dialog open**: rejected. Nobody is left to answer it, and with no timer it would never end, so it is closed like an idle one.

## Consequences

- A run can change orchestrator panes: the session that takes it over tells it its own pane, and from then on its Reports, heartbeats and ← go there. A run accepts this only from its own orchestrator's session.
- A session open in two pis at once lets the later one take over the earlier one's open runs. Before, it closed them.
- An orchestrator reopened outside tmux has no pane to take its runs over to, so it closes them, as before.
