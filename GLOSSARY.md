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
Continuing a completed run with a new message from the orchestrator, as its next generation, with its earlier context.
_Avoid_: restart, rerun

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
