# Subagents share the live checkout with the orchestrator's authority

Superseded in part by ADR-0006: a run is now a pi session of its own, not a child inside the orchestrator's pi. What relied on that no longer holds: a child's tools running through the orchestrator's `executeTool`, the sandbox telling a child's request from the orchestrator's, and a child never asking the user for approval. The shared live checkout, the user's deny rules, no locks or quotas, and one level of delegation still hold.

An orchestrator delegates to child agents. They work in the same live checkout with the orchestrator's callable tools, under the user's own deny rules, and nothing more. There are no per-agent workspaces, locks, quotas or child-only permission ceilings. Edits are live for everyone and the last write wins, so the orchestrator owns decomposition, handoffs and final verification. Delegation is one level deep. Children talk to the orchestrator, never to the user (amended by ADR-0005: the user may message a run directly): an action that would need the user's approval is denied and reported to the orchestrator, which can do it itself.

Decided 2026-10-27 to 2026-10-28; the spec is GitHub issue #6.

## Considered Options

- **An isolated workspace per writing agent**: snapshots, a private tool host, patch export and apply, a scheduler with quotas. Built and then abandoned. The machinery was heavy. On macOS the sandbox cannot guarantee that a stopped writer's processes are gone (see ADR-0001), which the design required before applying a writer's patch.
- **Child-specific quotas** (turns, tool calls, tokens, deadlines): rejected. An explicit stop replaces them.

## Consequences

- The historical isolation code and its tests were removed (#46). Commit 7377594 is the last one that has them.
- Children's model-only tools stay with the orchestrator, and virtual model routers are unavailable to children, because the SDK runs only callable tools through `ctx.executeTool`.
- The sandbox can tell a child's network request from the orchestrator's only when no orchestrator command is running at the same time. #26 makes that exact.
