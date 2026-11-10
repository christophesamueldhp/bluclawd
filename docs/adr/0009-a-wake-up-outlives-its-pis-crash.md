# A wake-up outlives its pi's crash

An orchestrator's agent can schedule a wake-up: a turn of its own that starts once, at a set time, with a prompt it wrote. A wake-up is a record, not a process: the session log owns it, and the pi hands its pending ones to the daemon, starting the daemon if it must. While the pi is alive it fires its own. When the pi is gone without ending its session (a crash), the daemon reopens the session in agent view's tmux to take the wake-up that falls due, late if the daemon was down or the Mac asleep. Ending the session cancels its wake-ups, as it closes its runs (ADR-0008): a quit, `/new`, a `/resume` of another session, a fork, tree navigation, and deleting its row.

Decided 2026-11-10; the spec is GitHub issue #268, settled by comparing bluclawd with the durable sleeps of `pi/packages/durable`.

## Considered Options

- **Durable only within the session, fired when it is next opened**: rejected. The use cases (polling CI, a deploy, a monitor) need the turn at its time, and a crash is not the user's choice to stop.
- **Reopening the session even after a quit**: rejected. A quit is the user ending the session, as it is for runs; reopening it behind their back would make a quit mean nothing.
- **A durable mode of `bash` or `monitor`**: rejected. Background shells are never revived after their pi is gone (a dead process must not be resurrected), and a wake-up has no process to revive.

## Consequences

- A Silent pane is not reopened: its pi may only be held up, and it fires its own wake-ups when it beats again. A pi outside tmux that is held up is not reopened either.
- The daemon counts a session's pi as gone when its process no longer runs (decided in #280), not by its heartbeat: a pi outside tmux never registers one. The pi hands over its pid with its start time, which `ps` gives both sides, so a later process with the same pid (after a restart of the Mac) is not taken for it. A Silent pane's pi, or a held-up pi outside tmux, still runs, so the daemon leaves its wake-ups to it.
- A Delete cancels wake-ups the session log cannot record, so a later `/resume` of the session file must not revive them. The daemon leaves word of each one it cancelled in the server dir (decided in #281), whether its pi crashed earlier or agent view's Delete killed it just now. Neither the daemon nor a pi reopening the session takes those wake-ups; the pi records them cancelled in the log.
- A session's pi that ran outside tmux comes back in agent view's tmux when the daemon reopens it.
- No wake-up is dropped for being late; it fires once, saying when it was due.
- A signal counts as a crash (decided 2026-11-10, in #280): pi takes a SIGHUP or SIGTERM for a quit, but a pi ended by one that bluclawd did not send (a closed terminal, a `kill`, a logout or restart) keeps its wake-ups. A pane bluclawd hangs up itself (a stop in agent view, a run closed) leaves word first, and ends as a quit. Agent view's Delete kills a live pi outright, so it records nothing, and the Delete's own word cancels its wake-ups; a deleted row's pane the daemon still finds when it beats again is hung up as a quit.
