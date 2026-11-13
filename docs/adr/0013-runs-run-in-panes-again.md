# A run is an interactive pi in a pane again

Revises ADR-0010 where it says that inspecting a run "does not require a full interactive pi terminal". On 2026-11-11, the day #311 shipped, the user asked to keep subagents as pi sessions they can see, not RPC processes. That is the reason ADR-0006 was written, and the same reason a viewer was rejected twice before.

A run's generation now runs as an interactive pi in a pane of the agent view's private tmux server whenever its orchestrator runs in one. Opening the run switches the terminal to that pane. Everything else ADR-0010 decided stays as it was: Admission, the role's tool ceiling and deny rules enforced by `rpc-child.ts`, the worktree of a run that edits, the contained shell, the daemon's queue and its slots, batches, chains, Resume, recovery and Reports. Only the process that runs the generation changes.

## Decisions

- **Panes are the default; RPC is the fallback.** An orchestrator outside a pane (print or json mode, or a pi outside tmux) runs its runs on RPC, as before.
- **The host stays the process the daemon starts.** In a pane, the daemon starts the host as the pane's command, so the host leads the pane's process group as it led its own. The host starts the run's pi on the pane's terminal rather than over pipes. The duties the host performed over RPC move into an extension in the run's pi (`pane-child.ts`): giving the task, taking messages from the inbox, writing what the run sends to the outbox, noticing that the work has settled, and storing the Report. The host still claims the generation, stores its state, forwards a stop, and records how the pi exited.
- **Approvals show in the run's own pane**, as in ADR-0006. The orchestrator's panel marks the run as needing input while any blocking dialog is open in its pane, an approval or a dialog the user opened there, but not while a `custom` UI is (#358).
- **Only extensions that draw the pane load in the run**, so it looks like the user's other sessions while its model sees exactly what it would see on RPC. The run's pi still starts with `-ne`. Besides `rpc-child.ts` and `pane-child.ts`, it loads bluclawd's branding, transcript, agent-view, help, vibes, paste, skills and accounts extensions, plus pistatusline when the user has it. None of these registers a tool or a system prompt section, and `test/subagent-pane-runs.test.ts` asserts that the model's context is byte-identical to that of an RPC run of the same role. The user's other extensions, and bluclawd's extensions that would change what the model sees or act for a session (memory, web, sandbox, permissions, checkpoints, background bash, subagents, remote, prompt assist), are not loaded. Widening this list would add their tools and prompt text to every run.
- **`subagents.panes: false`** in the user's settings keeps runs on RPC.
- **The pi ends after its Report**, once nothing is pending, as on RPC. A terminal that shows the pane at that moment moves back to the orchestrator. Opening a finished run starts a Resume in a pane that has no task, and the user types the instruction. Leaving that pane without typing ends the Resume, and no Report is delivered.

Old runs in tmux, from before ADR-0010, are still only followed until they end.

## Consequences

- The orchestrator's environment, which may hold credentials, never goes on tmux's command line or to disk. The daemon keeps it with the run's slot, and the host in the pane takes it once over the daemon's socket (`take_env`). The pane's command line carries only pi's state directories. This fits ADR-0012: the socket is unauthenticated, but no sandboxed shell reaches it, and any other process of the same user can already read that environment. Amended 2026-11-13 (#355): the daemon keeps it in memory only, so a daemon restarted between launching the host and the host taking it has none to give; the run then does not start, and says so.
- A run's pi in a pane knows the daemon's directory and its tmux, so ← can take the user back. Its shell commands are still told of neither (`run-shell.ts`).
- Esc in a run's pane holds its work for the user. The run ends as stopped once the user leaves the pane without going on; a stop from its orchestrator ends it at once. Amended 2026-11-13 (#356): a pane ended from outside, as by `tmux kill-session`, ends the run as stopped, with its Report delivered; a pi that does not end on the hang-up is killed after a grace.
- Startup costs a little more. From Admission to the run's first model request, measured on faux pi over six runs in two rounds on 2026-11-12: RPC took a median of 523–589 ms and a pane 606–737 ms.

## Approvals no one can answer

Decided 2026-11-12 (#345). While the run's orchestrator is there, an approval in its pane waits for the user with no timeout: the orchestrator's panel says the run needs input, as any pi waits for its user. Once the orchestrator's pane is gone (a crash: a quit stops its runs) and no terminal shows the run's pane for 5 s, the approval is blocked, as its host blocks one on pi's RPC. The run goes on and names the blocker in its Report (ADR-0008).

Amended 2026-11-12 (#354). When the orchestrator's session is reopened in another pane and takes its runs over, it stores its new pane in each run's spec, and a run's pi follows it there, as a run in tmux followed the session that took it over (ADR-0008). Only the session that owns the run takes it over. From then on an approval in the run's pane waits for the reopened orchestrator, ← goes back to it, and a terminal that shows the pane when the run ends moves to it. An approval waiting when the orchestrator crashed is still blocked if no terminal shows the run's pane for 5 s before its session is reopened.
