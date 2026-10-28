# Subagents share the live checkout with the orchestrator's authority

An orchestrator delegates to child agents. They work in the same live checkout with the orchestrator's callable tools, under the user's own deny rules, and nothing more. There are no per-agent workspaces, locks, quotas or child-only permission ceilings. Edits are live for everyone and the last write wins, so the orchestrator owns decomposition, handoffs and final verification. Delegation is one level deep. Children talk to the orchestrator, never to the user: an action that would need the user's approval is denied and reported to the orchestrator, which can do it itself.

Decided 2026-10-27 to 2026-10-28; the spec is GitHub issue #6.

## Considered Options

- **An isolated workspace per writing agent**: snapshots, a private tool host, patch export and apply, a scheduler with quotas. Built and then abandoned. The machinery was heavy. On macOS the sandbox cannot guarantee that a stopped writer's processes are gone (see ADR-0001), which the design required before applying a writer's patch.
- **Child-specific quotas** (turns, tool calls, tokens, deadlines): rejected. An explicit stop replaces them.

## Consequences

- The historical isolation code and its tests are kept, but the new dispatch never calls them.
- Children's model-only tools stay with the orchestrator, and virtual model routers are unavailable to children, because the SDK runs only callable tools through `ctx.executeTool`.
- The sandbox can tell a child's network request from the orchestrator's only when no orchestrator command is running at the same time. #26 makes that exact.
