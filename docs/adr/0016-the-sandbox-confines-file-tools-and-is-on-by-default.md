# The sandbox confines pi's file tools too, and is on by default

Revises ADR-0001 (the sandbox wraps only `bash` and `monitor`, and is opt-in). Decided 2026-11-25 in an audit with the user, after comparing Codex, Claude Code and Gemini CLI (`docs/research/agent-sandboxing.md`, `docs/research/subagent-confinement-and-context.md`). Not yet implemented.

The user wants the sandbox to confine everything the model does, not only its commands. pi's `read`, `edit`, `write`, `grep`, `find` and `ls` run in pi's own process, so a sandbox around the shell never saw them and only text-matching deny rules held them. Codex and Gemini CLI confine their file tools; Claude Code does not, and says so. bluclawd follows Codex and Gemini.

## Decisions

- **One policy for every tool.** While the sandbox is on, `write` and `edit` write through a helper process inside the sandbox; `read`, `ls` and `find` check each resolved path against the same policy; `grep` runs `rg` inside it. An extension can replace these tools' operations without changing pi.
- **On by default, and a switch.** New users start with the sandbox on, in the `workspace` profile. `/sandbox off` turns it off, and then nothing is confined by the OS. When the default cannot run, as on Linux without bubblewrap, the session starts without it and says so; only a sandbox the user turned on fails closed.
- **Profiles.** `read-only` writes nowhere. `workspace` writes the working directory, the temp directory and `allowWrite`. `custom` takes the user's lists of readable and writable directories, plus system directories that stay readable so tools still run.
- **Protected paths.** Nothing the model runs writes `.pi/`, `.agents/`, `.git/hooks`, `.git/config`, `.vscode/`, `.idea/`, `.claude/` or `.mcp.json` in the project, unless the user allows it explicitly. Without the sandbox this holds only as far as deny rules match a command's text. An Integration that would carry a change to one of them asks the user first. These paths configure what runs outside the sandbox later, as Codex and Claude Code also hold.
- **Default secrets.** Reading `.env*`, `*.pem`, `*.key`, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`, `~/.pi/agent/auth.json` and `~/.pi/agent/bluclawd/accounts.json` is denied unless the user turns that off, or allows one for a session or a folder with `/sandbox allow`; the model's `gh` and private npm registries need that. While the sandbox is on, the shell does not get environment variables whose names mark them as credentials.
- **`.gitignore` hides files from search only**, by a setting that is on by default and that runs follow. Ignored files stay readable and writable, since they include `node_modules` and build output. No agent compared uses `.gitignore` as a security boundary; the default secrets do that job.
- **Fail closed.** The sandbox refuses to start rather than run with less than the user asked for: on Linux when the runtime would drop a glob write-deny, and whenever a deny list or the settings cannot be read.

## Considered options

- **Run the whole pi inside the sandbox** (Gemini CLI). Rejected: pi needs to write its agent directory and reach the daemon's and tmux's sockets, which the sandbox exists to deny.
- **A VM or container around the agent**, the only stronger boundary. Documented for unattended work, not built in.
