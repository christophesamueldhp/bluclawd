# Subagents are pi sessions of their own

A run is a full interactive pi in the agent view's private tmux server, launched by its orchestrator, rather than an SDK session inside the orchestrator's pi. Opening a run switches the terminal to it, so it looks and behaves exactly like any other session: its own editor, status line and slash commands. The orchestrator starts, messages, stops and closes it, and runs message each other, the way Claude Code's agent teams talk between sessions, except that the orchestrator's close is not a request the run can refuse. Runs are not agent view rows or phone rows of their own; they are reached from their orchestrator. The user asked for this after the in-process transcript view still read as "not a pi session of its own", the same reason a viewer was rejected for agent view.

Decided 2026-11-05; the spec is GitHub issue #180. Subagents need tmux, as agent view does.

## Considered Options

- **A richer overlay over the in-process run** (editor, footer and slash commands added to the transcript view): rejected. It stays a viewer and will always differ from a real pi somewhere.
- **Forwarding a run's approval prompts into the orchestrator's session**, as Claude Code does: rejected for now. The prompt shows in the run's own session, and the orchestrator's panel marks the run as needing input.

## Consequences

- This supersedes ADR-0003 where it relied on the run being in-process. A child's tools no longer run through the orchestrator's `executeTool`. The role's tools, model, thinking level and instructions become the child pi's launch flags, and the child loads the user's packages. A run can now ask the user for approval in its own session, which reverses "a run never asks the user" in ADR-0003 and ADR-0005. Delegation stays one level deep.
- A run's usage stays in its own session. The orchestrator shows the total of its runs apart from its own usage, so Attribution and Finishing are redefined in the spec.
- A run lives as long as its orchestrator's session does: when that session ends, every run is closed, and their sessions are kept so they can be resumed.
- Agent view folds an orchestrator's open runs into a line under its row, hidden until the user opens it (revised 2026-11-06, at the user's request: runs listed as rows of their own came and went, and stayed after their orchestrator was deleted). Deleting an orchestrator's row deletes its runs' rows and ends their pis, and the daemon removes a closed run's row once its orchestrator's pane is gone. The phone still lists no runs.
- The subagent panel moves below the status line. pi only offers widgets above or below the editor, and pistatusline owns the footer, so pistatusline draws the panel from data bluclawd provides.
