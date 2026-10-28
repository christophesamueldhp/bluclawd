# The model's shell commands run in Anthropic's sandbox runtime (srt)

Deny rules match the text of a call, so they cannot stop a command that reads a secret without naming it (`grep -r KEY .`). bluclawd therefore wraps the model's `bash` and `monitor` in `@anthropic-ai/sandbox-runtime` (srt), the library behind Claude Code's sandbox. On macOS it uses Seatbelt and on Linux/WSL2 bubblewrap, with a localhost proxy for network filtering. The sandbox is opt-in through global settings only, so a repository cannot loosen it. If it cannot start, it fails closed, and a host no rule covers is asked about once per host per session.

## Considered Options

- **Hand-written Seatbelt profiles**: easy to get wrong, and they would cover macOS only.
- **Codex CLI, Cursor or gemini-cli sandboxes**: the same Seatbelt design on macOS, with the same gaps (2026-10-28 research).
- **A VM per command** (Apple `container`, Docker, Lima): the only way to contain process lifetime on macOS, but it costs a VM boot or an always-on VM, runs only Linux binaries, and puts the live checkout behind a mount. Kept as an optional mode (#30).
- **Cloud sandboxes** (E2B, Daytona): they cannot work on the user's live checkout.

## Consequences

- On macOS, Seatbelt limits files and network but not process lifetime. A command that detaches or double-forks a descendant leaves it running after a stop. The three red `subagents-writer-backend` assertions show this, and the best-effort reaper (#29) targets them. Linux's PID namespace contains it.
- srt is pre-1.0 ("Beta Research Preview") and its API still moves, so it is pinned.
