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

**Resume**:
Continuing a completed run with a new message from the orchestrator, as its next generation, with its earlier context.
_Avoid_: restart, rerun

### Tasks

**Task**:
An entry in `/tasks` and `task_stop`: a background shell, a monitor, or a run as seen from there.
_Avoid_: task for the run itself inside `subagents`
