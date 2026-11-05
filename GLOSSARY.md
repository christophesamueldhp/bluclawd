# bluclawd

An extension pack for the pi coding agent: a sandboxed shell, background sessions, and an orchestrator that delegates work to subagents in the same live checkout.

## Language

### Subagents

**Run**:
One delegated piece of work by a subagent, with its own identity, transcript and report. A run lives through one or more generations.
_Avoid_: job, task (for a subagent's work)

**Generation**:
One launch or one resume of a run. Usage is counted once per generation.
_Avoid_: generation for the orchestrator's session being reloaded or replaced

**Finishing**:
A run's status from the child's last turn of a generation, one pi will not retry, until its final record: the work is done but the run is not final yet. It can no longer be stopped, and a message to it waits for it to be final and then resumes it. It ends with the generation's final record.
_Avoid_: done, ended (before the final record)

**Attribution**:
Where a generation's usage is counted: in pi's own totals (nested usage the SDK folds into the launch tool result, or the usage a foreground tool result carries) or in the background ledger. Each token is attributed exactly once.
_Avoid_: reconciling, double counting

**Admission**:
The checks that accept or reject a launch or a resume before a run starts: deny rules, the role's tools, the model and thinking level, the run's name, and whether the orchestrator's session and branch are still current.
_Avoid_: validation, preflight

**Parent scope**:
The orchestrator's session, and its session epoch, that a run or message belongs to. The session epoch changes whenever that session is switched, forked, replaced, reloaded or shut down, which makes everything of the earlier epoch stale. A run whose originating entry is no longer on the active branch is out of scope too.
_Avoid_: generation, runtime generation

**Resume**:
Continuing a completed run with a new message from the orchestrator or the user, as its next generation, with its earlier context.
_Avoid_: restart, rerun

**Waiting**:
The orchestrator between turns while background runs it launched are still active: it leaves their work to them and goes on when their reports arrive.
_Avoid_: idle, stopped, done (while runs are active)

### Tasks

**Task**:
An entry in `/tasks` and `task_stop`: a background shell, a monitor, or a run as seen from there.
_Avoid_: task for the run itself inside `subagents`

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

**Daemon lifetime**:
The marker of one daemon process, given to the phone with each prompt it accepts. Asked about a prompt it has no record of, under an earlier lifetime, the daemon answers lost because it restarted, when the row's pane reports outcomes.
_Avoid_: build id, version, generation

**Prompt outcome**:
What became of a prompt or slash command a phone sent, reported back by the id the phone gave it: taken (pi started a turn with it, or Enter was pressed for the command), queued (pi queued it behind the turn in progress), refused with a reason (the pane did not hand it to pi: busy, draft or dialog for a command; compacting; session changed), or lost with a reason (its pane went with it still queued, in its inbox or in pi; pi dropped it from its queue, as a stopped turn, the dequeue key or its session reloading or switching does, or it was queued and never seen in pi's queue by the time pi fell quiet, or its session ended other than by a quit with it queued; or the daemon restarted). A Silent pane loses what is still in its inbox at once, while what pi holds waits on its report. The daemon's prompt delivery keeps each one's journey, from the pane's inbox to the outcome its pane reports, and the phone puts a refused or lost one back in its composer. A pane from an older build reports none, and the phone guesses for it.
_Avoid_: PhoneOutcome (phone control's decision), delivered (the pane's heartbeat took it, nothing more)

**Silent pane**:
A pane the daemon reaped for missing its heartbeat while tmux still has its session: its pi may only be held up (the Mac slept). It stays listed as its row, alive, and its session is not started again elsewhere; it goes on as that row when it beats again, and ends as any pane does once tmux no longer has it, it unregisters, or it beats on another session.
_Avoid_: dead pane, stale pane

**Session changed**:
Why a phone's prompt is refused when it was sent to another session than its pane's: the pane is on another one now and refuses it, or its session ended for a new one, a `/resume` of another file or a fork before pi took it, and the daemon refuses it. A reload or a `/resume` of the same file is still the session it was sent to; a fork has a row of its own.

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
