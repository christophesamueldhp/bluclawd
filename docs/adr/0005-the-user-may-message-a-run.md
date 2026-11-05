# The user may message a run directly

Superseded in part by ADR-0006: a run now asks the user for approval in its own session.

ADR-0003 had children talk only to the orchestrator. The user can now open a run's transcript and type to it: a running run takes the message at its next safe point, and a completed one resumes as its next generation. The orchestrator is told each time, so it still owns decomposition and final verification. A run still never asks the user for approval; what would need it is denied and reported to the orchestrator, as before.

Decided 2026-11-04, while specifying the subagent panel and the orchestrator's waiting.

## Considered Options

- **Read-only transcripts, as in Codex v2**: rejected. The user asked to steer runs without going through the orchestrator, as Claude Code and Codex v1 allow.
