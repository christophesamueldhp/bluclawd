# The sandbox confines pi's file tools too

Revises ADR-0001 (the sandbox wraps only `bash` and `monitor`). Decided 2026-11-25 in an audit with the user, after comparing Codex, Claude Code and Gemini CLI (`docs/research/agent-sandboxing.md`, `docs/research/subagent-confinement-and-context.md`); on 2026-11-26 the user kept the sandbox opt-in. Not yet implemented.

The user wants the sandbox to confine everything the model does, not only its commands. pi's `read`, `edit`, `write`, `grep`, `find` and `ls` run in pi's own process, so a sandbox around the shell never saw them and only text-matching deny rules held them. Codex and Gemini CLI confine their file tools; Claude Code does not, and says so. bluclawd follows Codex and Gemini.

## Decisions

- **One policy for every tool.** While the sandbox is on, `write` and `edit` write through a helper process inside the sandbox; `read`, `ls` and `find` check each resolved path against the same policy; `grep` runs `rg` inside it. An extension can replace these tools' operations without changing pi.
- **Off by default, and a switch.** The sandbox stays off until the user turns it on with `/sandbox on`, which starts in the `workspace` profile. While it is off nothing is confined by the OS. A sandbox the user turned on fails closed.
- **`sandbox.filesystem.disabled` is an explicit opt-out.** With the sandbox on and this setting true, the runtime emits no filesystem rules, so the protected paths, default secrets and job-output deny do not hold for shells. `bash` and `monitor` still run; `/sandbox` status and the docs say filesystem protection is off (#21).
- **Profiles.** `read-only` writes nowhere. `workspace` writes the working directory, the temp directory and `allowWrite`. `custom` takes the user's lists of readable and writable directories, plus system directories that stay readable so tools still run.
- **Protected paths.** Nothing the model runs writes `.pi/`, `.agents/`, `.git/hooks`, `.git/config`, `.vscode/`, `.idea/`, `.claude/` or `.mcp.json` in the project, unless the user allows it explicitly. Without the sandbox this holds only as far as deny rules match a command's text. An Integration that would carry a change to one of them asks the user first. These paths configure what runs outside the sandbox later, as Codex and Claude Code also hold.
- **Default secrets.** Reading `.env*`, `*.pem`, `*.key`, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`, `~/.pi/agent/auth.json` and `~/.pi/agent/bluclawd/accounts.json` is denied unless the user turns that off, or allows one for a session or a folder with `/sandbox allow`; the model's `gh` and private npm registries need that. While the sandbox is on, the shell does not get environment variables whose names mark them as credentials.
- **`.gitignore` hides files from search only**, by a setting that is on by default and that runs follow. Ignored files stay readable and writable, since they include `node_modules` and build output. No agent compared uses `.gitignore` as a security boundary; the default secrets do that job.
- **Fail closed.** The sandbox refuses to start rather than run with less than the user asked for: on Linux when the runtime would drop a glob write-deny, and whenever a deny list or the settings cannot be read.

## Considered options

- **Run the whole pi inside the sandbox** (Gemini CLI). Rejected: pi needs to write its agent directory and reach the daemon's and tmux's sockets, which the sandbox exists to deny.
- **On by default**, as Codex and Gemini CLI do. Drafted on 2026-11-25, then rejected by the user on 2026-11-26: the sandbox stays opt-in.
- **Refuse `bash` and `monitor`, or ignore `filesystem.disabled`**, while the sandbox is on (#21). Rejected: the user turned the sandbox on and then turned its filesystem part off on purpose; status and docs warn about it.
- **A VM or container around the agent**, the only stronger boundary. Documented for unattended work, not built in.
