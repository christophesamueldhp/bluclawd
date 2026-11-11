# bluclawd

An extension pack for the pi coding agent: a sandboxed shell, background sessions, and an orchestrator that delegates work to subagents.

## Language

### Subagents

**Run**:
One delegated piece of work owned by its launching orchestrator, with its own identity, session, context, transcript and reports. A run can span multiple generations; its saved context can outlive the process doing its work.
_Avoid_: job, task (for a subagent's work), teammate

**Run workspace**:
The files and directories a run works with, which may be shared for reading or isolated for changes. An isolated run workspace has a defined starting state and does not automatically receive later edits from other runs or its orchestrator.
_Avoid_: sandbox (for the workspace itself)

**Integration**:
Applying a run's isolated changes to the orchestrator's workspace, preserving intervening changes and verifying the combined result. It does not by itself include committing or publishing those changes.
_Avoid_: automatic merge (when no Git merge is involved)

**Cancellation**:
Ending the selected work and its executing subprocesses, and cancelling pending steps when a batch or chain is cancelled, while retaining sessions and partial changes. User-cancelled work requires an explicit instruction to resume; a late message cannot restart it.
_Avoid_: rollback, deletion, stopping the wait

**Batch**:
Independent runs launched together by one orchestrator call, admitted all together or not at all. One member's failure leaves the others working. The batch settles once every member has, with one bounded account of every member's outcome and a reference to each full report; cancelling it cancels every member, working or queued.
_Avoid_: chain (for runs that depend on each other), group

**Chain**:
Dependent runs launched by one orchestrator call as ordered steps: each starts only once the step before it completed, given that step's report, never its transcript. When a step edits, every step works in one isolated workspace, one at a time; a later step continues an earlier one's context only by explicit resume. A failed, cancelled or blocked step halts the chain, and the steps after it never run; a review that reports defects has completed. Its output is integrated, if at all, after the whole sequence completes.
_Avoid_: pipeline, batch (for independent runs)

**Report**:
A run's account of its work, given to its orchestrator when that work settles. Further work in the same run can produce another report, including after resume.
_Avoid_: result (as if it came once), final answer

**Stop**:
Requesting cancellation of a run's active work while retaining its session and partial changes. Stopping work is distinct from leaving it running in the background.
_Avoid_: stopping the wait, cleanup

**Workspace cleanup**:
Removing a run workspace without deleting its transcript or reports. A workspace containing changes requires an explicit user cleanup request; cleanup may make resume unavailable if the required workspace state cannot be restored.
_Avoid_: stop, cancellation, deleting the session

**Generation**:
One launch or one resume of a run.
_Avoid_: generation for the orchestrator's session being reloaded or replaced

**Attribution**:
Where a run's usage is counted: in the run's own sessions, like any session's, never in the orchestrator's. The orchestrator shows the total of its runs apart from its own usage. Each token is counted once, however often a run reports, resumes or starts a new session.
_Avoid_: reconciling, double counting

**Admission**:
The checks that accept or reject a launch or a resume before a run starts: deny rules, the role's tools, the model and thinking level, the run's name, and whether the orchestrator's session and branch are still current.
_Avoid_: validation, preflight

**Parent scope**:
The orchestrator's session, and its session epoch, that a run or message belongs to. The session epoch changes whenever that session is switched, forked, replaced or shut down, which makes everything of the earlier epoch stale. A reload keeps the session, and its open runs; so does reopening it after a crash, which takes over its runs still open. A run whose originating entry is no longer on the active branch is out of scope too.
_Avoid_: generation, runtime generation

**Collaboration**:
Independent orchestrator sessions the user linked, with `/collaborate` in one of them, for work the user named. Its members may send each other findings, questions and blockers; no one else is reached, and nothing a member sends adds a member, changes the work or starts a turn in another member. Changing the work makes what was sent under the earlier one stale. A session is in one at most. Switching to another session, forking or quitting leaves it, and with one member left it ends; a reload keeps it.
_Avoid_: group chat, broadcast, peer discovery

**Resume**:
Continuing a saved run with an explicit instruction from the orchestrator or the user, as its next generation, with its earlier context. Starting another run with the same role is not a resume.
_Avoid_: restart, rerun

**Waiting**:
The orchestrator between turns while runs it launched are still working: it leaves their work to them and goes on when their reports arrive. A run that is idle, or waits on the user in its own session, is not waited for.
_Avoid_: idle, stopped, done (while runs are working)

### Tasks

**Task**:
An entry in `/tasks` and `task_stop`: a background shell, a monitor, a wake-up, or a run as seen from there.
_Avoid_: task for the run itself inside `subagents`

**Wake-up**:
A turn a session's agent schedules for itself: it starts once, at a set time or as soon after it as the session can take it, with a prompt the agent wrote. It outlives its pi crashing, or being ended by a signal bluclawd did not send (a closed terminal, a kill), and the session is opened again to take it; ending the session, a fork or a move in its tree, and deleting its row cancel it. An orchestrator schedules wake-ups, a run does not. A session may hold several at once.
_Avoid_: timer, reminder, cron job, sleep, scheduled task

### Agent view

**Manual order**:
The place the user gives a row in its band in agent view, in the Pinned band or a directory's band. Needs input, Working and Idle always list by recency. Pinning or unpinning a row clears it, and a filter hides rows without moving them.
_Avoid_: sort order, position

### Web

**Search provider**:
The service a web search is sent to: Exa or OpenAI. It is chosen independently of the model the session chats with.
_Avoid_: web provider, search model, provider (alone)

### Remote control

**Chat**:
One session, identified by its session file, opened in the remote app on a phone. It stays with that session while the session's row moves between a pane and storage, and ends when another session or the list is shown.
_Avoid_: open session, conversation

**Phone control**:
The rules that decide, for one session, whether a Chat's action is allowed and what it becomes: a message for its pane, a change the daemon makes itself (rename a stored session, pin, delete), a read of its transcript or a task's output, its status, the commands it lists, or a refusal with an error code.
_Avoid_: admission (a run's launch checks), validation

**Chat verdict**:
Whether a Chat may act on a listed row, and why not, as the daemon lists it with each row: only a live pane's row takes a message for its pi; a Silent pane's, a starting one's or a stored one's does not. Phone control and the phone's list both read it, so the phone never offers what the daemon would refuse.
_Avoid_: running, alive (a row's pane, not what it takes)

**Unseen**:
A session whose pi finished a turn since its Chat was last opened on this phone. Each phone keeps its own, and opening the Chat clears it; it is not a state, so a Done, Failed or Stopped row may be Unseen or not.
_Avoid_: unread, new

**Daemon lifetime**:
The marker of one daemon process, given to the phone with each prompt it accepts. Asked about a prompt it has no record of, under an earlier lifetime, the daemon answers lost because it restarted, when the row's pane reports outcomes.
_Avoid_: build id, version, generation

**Prompt outcome**:
What became of a prompt or slash command a phone sent, reported back by the id the phone gave it: taken (pi started a turn with it, or Enter was pressed for the command), queued (pi queued it behind the turn in progress), refused with a reason (the pane did not hand it to pi: busy, draft or dialog for a command; compacting; session changed), or lost with a reason (its pane went with it still queued, in its inbox or in pi; pi dropped it from its queue, as a stopped turn, the dequeue key or its session reloading or switching does, or it was queued and never seen in pi's queue by the time pi fell quiet, or its session ended other than by a quit with it queued; or the daemon restarted). A Silent pane loses what is still in its inbox at once, while what pi holds waits on its report. The daemon's prompt delivery keeps each one's journey, from the pane's inbox to the outcome its pane reports, and the phone puts a refused or lost one back in its composer. A pane from an older build reports none, and the phone guesses for it.
_Avoid_: PhoneOutcome (phone control's decision), delivered (the pane's heartbeat took it, nothing more)

**Delete**:
Removing a session's row from agent view and the phone's list. Its pi ends if it still runs, its session file stays on the Mac, resumable with `/resume`, and the row does not come back by itself: not with a late heartbeat, a quit's save or a daemon restart. A `/resume` from another window lists it again, as a new row.
_Avoid_: close, stop, forget

**Silent pane**:
A pane the daemon reaped for missing its heartbeat while tmux still has its session: its pi may only be held up (the Mac slept). It stays listed as its row, alive, and its session is not started again elsewhere; it goes on as that row when it beats again, and ends as any pane does once tmux no longer has it, it unregisters, or it beats on another session.
_Avoid_: dead pane, stale pane

**Session changed**:
Why a phone's prompt is refused when it was sent to another session than its pane's: the pane is on another one now and refuses it, or its session ended for a new one, a `/resume` of another file or a fork before pi took it, and the daemon refuses it. A reload or a `/resume` of the same file is still the session it was sent to; a fork has a row of its own.

### Models

**Active model**:
The model selected to answer in a session. Selecting it is separate from choosing which models belong to Scoped models.
_Avoid_: scoped model (when referring to the selected model)

**Scoped models**:
The chosen set of models offered for scoped selection and quick cycling, identified by provider and model independently of the active account. Membership does not make a model the Active model.
_Avoid_: active models

**Session model scope**:
The Scoped models belonging to one session, retained when it is reopened and inherited as an independent copy by a fork. Changing it does not change the Default model scope or another open session's choices.

**Default model scope**:
The globally saved baseline of Scoped models for new sessions, unless a project-specific choice takes precedence. Saving it also applies the selection to the current session, without changing other open sessions.

### Memory

**Memory**:
One fact the agent keeps for one Project across sessions: who the user is, guidance they gave, the state of ongoing work, or where to look something up. The orchestrator keeps it; a run does not.
_Avoid_: note, entry, context file (`AGENTS.md`, `CLAUDE.md`)

**Memory index**:
One line per Memory of the Project, given to the agent when its session starts. A Memory saved during the session is not added to it until the next session.
_Avoid_: MEMORY.md (its file, not the concept)

**Project**:
Whose Memory a session sees: the git repository the session's directory belongs to, shared by all its worktrees, or the directory itself outside git.
_Avoid_: workspace, repo (alone), cwd
