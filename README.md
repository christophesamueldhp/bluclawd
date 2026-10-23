# bluclawd

A feature layer for [pi](https://github.com/earendil-works/pi), installed as an
ordinary pi package — not a fork. **Nothing here modifies a file pi owns**, and
nothing here bundles pi's own source: install pi normally, then install this on
top.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # pi itself
brew install tmux                                                  # agent view needs it
npm install --omit=dev --omit=peer --prefix /path/to/this/repo     # the sandbox runtime
pi install /path/to/this/repo                                     # this layer
pi                                                                 # run it
```

For updates from Git, install with `pi install git:github.com/christophesamueldhp/bluclawd`.
Then `pi update --all` updates Pi and installed packages, including newly published bluclawd
features. Restart Pi or run `/reload` in an existing session to load the updated extensions.
Prompt assistance is included and enabled by default; no separate extension installation is needed.

Identity is plain pi — `~/.pi/agent`, the `pi` binary. The name "bluclawd"
shows up in the welcome header and nowhere else; there is no rebrand.

## How it works

Two mechanisms, both pi's own:

| Need | pi's mechanism |
|---|---|
| What ships | `package.json`'s `pi.extensions` — an explicit, ordered list of files (`permissions` must load first: it must see `tool_call` before anything that might answer it) |
| What a feature does | `ExtensionAPI`: `registerCommand`, `registerTool`, `registerShortcut`, `appendEntry` + `registerEntryRenderer`, `ui.custom`, `setHeader`, `resources_discover`, … |

`bin.mjs` is a convenience entry point for trying this out without a separate
`pi install` (imports `@earendil-works/pi-coding-agent` as a normal
dependency); it is not how `pi install` loads this package.

## What ships

```
package.json    the pi package manifest (pi.extensions, pi.themes, peer dependencies)
bin.mjs         convenience entry point for local runs
themes/         the bluclawd themes: Claude Code's six palettes
daemon/         agent view's session registry (state in ~/.pi/server, or $PI_SERVER_DIR), and its client, tmux and row code the extensions share
ext/            the feature layer, one directory per extension
  _shared/      cross-extension state (via globalThis), settings readers, vendored pi internals
scripts/        probe-extensions.ts — headless report of what each extension registers
test/           vitest suites, self-contained — no monorepo, no fixture files
```

12 extensions, no runtime dependencies (pi's own packages are peers):

| Extension | Registers |
|---|---|
| `permissions` | deny-rule gate on every tool call; Alt+M |
| `checkpoints` | `/rewind` |
| `background-bash` | `/tasks`; the `bash`, `monitor` and `task_stop` tools |
| `subagents` | model-only `subagent` tool (`explorer`, `reviewer`, plus trusted `.pi/agents/*.md` and `~/.pi/agent/agents/*.md`) |
| `branding` | `/theme`; welcome header and mascot |
| `agent-view` | `/agent-view` (what `←` twice dispatches) |
| `remote` | `/remote-control` |
| `help` | `/help`, `/status`, `/context` |
| `vibes` | spinner verbs |
| `prompt-assist` | `/prompt-assist`; prompt suggestions and automatic session titles with a selectable Pi model; manual rename stays available |
| `paste` | Claude Code's paste in the prompt and agent view's composer: a paste over 800 characters or 2 lines shows as `[Pasted text #N +L lines]`, a ctrl+v image as `[Image #N]` (sent as an image), and pasting the same thing again right after shows the text or the image's file |

Prompt assistance defaults to **OpenCode Go / MiMo-V2.6-Flash**, independently of your coding model.
Use **`/prompt-assist`** to open the built-in Pi TUI picker, showing the current enabled state
and model. Its first option turns assistance on or off; the remaining options select any available,
authenticated Pi chat model, including custom providers. The toggle remains available without model credentials. **`/prompt-assist provider/model`** selects one directly (Tab completes IDs), and
**`/prompt-assist default`** returns to MiMo. **`/prompt-assist off`** disables both prompt
suggestions and automatic session naming; **`/prompt-assist on`** enables them again. Disabling
cancels pending assistance requests and clears ghost text, without changing your draft or an
existing session name. Model selection does not implicitly enable assistance. Both the enabled
state (on by default) and the selected model are saved globally in `~/.pi/agent/bluclawd/prompt-assist.json` (under `$PI_CODING_AGENT_DIR`
when overridden) for future sessions and package updates. Changing it leaves the main coding model unchanged.

After a response has fully finished (including retries and queued work), assistance automatically
requests a dim next-prompt suggestion in the empty editor, without requiring you to type first.
It also refreshes the suggestion when resuming or reloading a conversation. While typing,
continuations are requested after a 700 ms pause. Provider latency still applies; background
requests allow up to 30 seconds. Suggestions target **2–12 words**, with no extra character cutoff
on the draft or returned suggestion. The request still has a 64-output-token budget; these token
budgets and the bounded conversation excerpt are bluclawd cost controls, not documented Claude Code limits.
**Right arrow (`→`)** or **Tab** accepts without sending;
**Enter** submits the accepted text, and **Esc** dismisses. Without a visible suggestion, Right arrow
keeps its normal cursor movement. Command/file
completion takes priority. Only a short text-only conversation excerpt and the draft are sent
to the selected provider; assistance does not read repository files or include tool output.
The selected provider must be authenticated; unavailable models produce a warning, not a silent fallback.

An unnamed session starts generating an English **2–5 word noun-phrase title** as soon as its
first prompt is submitted, without waiting for the main response. The background request uses
the first 1,500 characters of that prompt and a 32-output-token budget; it does not apply a
separate 80-character cutoff to the returned title. The title appears on the editor's upper border while idle.
A completely empty session has no topic to name yet. Rename it at any time with pi's
**`/name Your title`**, or **Ctrl+R** in agent view. Automatic naming never replaces a manually
assigned name, including one assigned while generation is still running.

## What it adds

Claude Code's names and behaviours, on top of pi's own commands:

| Command | What it does |
|---|---|
| `permissions.deny`, Alt+M | deny rules block matching tool calls; the footer shows pi's `defaultProjectTrust` (`⏵⏵ always` / `⏸ ask` / `✕ never`) and Alt+M cycles it — see [Permissions](#permissions) |
| `/tasks` | background tasks dialog: shells (`run_in_background`, Ctrl+B on the model's running bash, or a foreground command past its `timeout`), monitors, subagents (`subagent` with `background: true`), and the model's bash still running in the foreground once it has run 2s (marked `foreground`; `x` kills it; Claude Code does not list these); running tasks only; Enter shows a task's output tail, `x` stops it (the model is told without a turn starting), and updates wait while the dialog is open. The model's bash is Claude Code's: `timeout` in milliseconds (2 minutes by default), a command still running then - or on Ctrl+B after 2s, or when you send a message - moves to the background instead of being killed, and the model reads a task's output file with `read`. The footer pill counts the running shells and monitors; ↓ from an empty prompt selects it and Enter opens the dialog. A shell writes its whole output to a file named in its start result and exit notification; `task_stop` stops shells, monitors, and background subagents (`sub_*`). A job notifies the model once when it exits, and once more if it goes quiet for 45s on what reads as an interactive prompt (`(y/n)`, `Press Enter`, …); the `monitor` tool turns each stdout line of a long-running command, or each frame of a WebSocket (`ws`), into an event that wakes the model (Claude Code's `Monitor`; stderr goes to the output file; every monitor expires after `timeout_ms`, 5 minutes by default and at most 30, with one notice so the model can re-arm it) |
| `subagent` tool | model-only read-only delegation (`explorer` and `reviewer` bundled, plus custom Markdown definitions in trusted `<cwd>/.pi/agents/*.md` and `~/.pi/agent/agents/*.md`). Runs in an isolated fresh child context with only `read`, `grep`, `find`, and `ls`, inheriting the parent model, thinking level, and `Read`/`Grep`/`Find`/`Ls` deny rules (at most 2 active and 4 queued per session, 12 turns / 40 tool calls per run, 6 child runs or 300k child tokens per parent turn). Foreground calls return child usage in the tool result; `background: true` delivers completion to the originating session branch and tracks background child usage in a separate ledger (`~/.pi/agent/bluclawd/subagents/<session>/background-usage-ledger.json`) |
| `/rewind` (or Esc twice on an empty prompt, as in Claude Code) | Claude Code's rewind: a file checkpoint per message you send; lists your prompts newest first with what each changed (`a.ts +3 -1`, `No code changes`, `⚠ No code restore`), then Restore code and conversation / Restore conversation (the prompt returns to the editor) / Restore code / Never mind, with no further confirmation (the current files are checkpointed first and listed as `(before rewind)`, so `/rewind` undoes it). New files the agent created since the point (`write`, `bash`) are removed and your own are kept, as in Claude Code; unlike Claude Code it also restores files changed through bash or by hand. Checkpoints are git commits kept under `refs/bluclawd/checkpoints/<session>/`: the newest 50 per session, and another session's refs are pruned after 30 days |
| `←` on an empty prompt (or `/agent-view`) | agent view, as Claude Code's `claude agents`: background sessions in Needs input (blocked on a prompt) / Working (a turn running) / Idle (nothing running) bands (empty ones hidden; ctrl+s: by directory, this one first, remembered), one line each — `✻`/spinner/`∙` + name, what it is doing (a working session's current tool), age. Type a task + enter to start a background session (ctrl+enter: start it and switch to it), shift+enter / alt+enter / ctrl+j adds a line, ctrl+g writes it in `$EDITOR`, ctrl+v attaches a clipboard image to the new-session composer, an unknown `/command` is sent as the task, `!<command>` runs it in your shell as a row of its own (its last output line while it runs, then done, `exit N — …` or stopped; enter shows its output, ctrl+x stops it then removes the row, and it is never run again), space peeks and replies (the reply is the session's next prompt, `/stop` stops it; a reply draft is kept per session), enter/→ switches this terminal to any session at once, including Working and Needs input (see [Session switching](#session-switching)), ↑↓ wrap, alt/ctrl+↑↓ jump between bands, alt+1-9 opens the Nth session in the focused one's directory, ctrl+x stops then deletes (this terminal's own session too: the terminal moves to agent view), ctrl+t pins, ctrl+r renames, shift+↑↓ reorders, `s:<state>` / `n:<name>` filter (ctrl+f turns the text into a name search), `/resume` brings a past session back and opens it, `/model <name>` (or `default`) sets the model for new ones, `/cd <dir>` sets the directory they start in (relative to the current one; bare `/cd` goes back), tab completes the model or directory (several matches are listed: ↑↓ and tab or enter pick one), typing `/` lists these commands (↑↓ to pick, tab or enter completes one that takes an argument, enter runs the rest), the hint line starts with the mode new ones start in (`⏵⏵ always` or `✕ never`; nothing at pi's default, `ask`), `?` shows the shortcuts, esc returns to your session, and ctrl+c twice (or `exit`, `/exit`) leaves tmux with the sessions still running, except the one `pi` started in this terminal, which ends with it while idle. The footer shows `← for agents` / `← N agents` / `← N done`, and `Press ← again to open agents` after the first press. Every session is a pi of its own in tmux, so it keeps running after its terminal leaves or closes; a local daemon (`daemon/`, a Unix socket in `~/.pi/server`) only lists them. Agent View detects both changed daemon code and a changed Pi installation, and restarts an obsolete daemon. A session that was idle when its pi quit is kept as a row with no process (it resumes when opened or replied to); every row stays until ctrl+x deletes it |
| `/remote-control` | Claude Code's Remote Control, for every agent-view session: a phone app (a PWA the daemon serves) lists them in agent view's bands, shows a session's conversation and its reply as it streams, sends it a prompt, stops its turn, starts sessions, switches the model, and notifies you; a message once sent is never edited from the phone, only stopped. `/remote-control` turns it on and shows a QR code that pairs your phone; once on, it offers a menu: pair a new phone, the paired phones (remove one or all), start at login (macOS), turn off — see [Remote control](#remote-control) |
| `/prompt-assist [on\|off\|provider/model\|default]` | enable/disable prompt suggestions and automatic session naming, or choose and save their Pi model without changing the coding model |
| `/status`, `/context` | `/status`: model, auth, project trust; `/context`: context window usage (session file, messages, tokens and cost stay in pi's `/session`) |
| `/theme` | Claude Code's theme picker: Auto (match terminal), Dark / Light mode, their colorblind-friendly and ANSI-only variants (Claude Code's six palettes, with the bluclawd mascot cyan as accent), then every other pi theme; the focused theme previews live over a `demo.js` diff, Enter saves it, Esc restores the saved one. `/theme <name>` sets one directly |
| `exit`, `/exit`, `quit`, `:q`, `:wq` alone at the prompt | as Claude Code's `/exit`: ends a normal session, detaches from a background one (see [Session switching](#session-switching)) |
| `/help` | all of the above, grouped |

bluclawd draws no footer of its own. Its footer items go through pi's `setStatus`, keyed so they
sort in this order: `⏵⏵ always (alt+m to cycle)`, then the background-task pill,
then `← for agents`. pi's own footer shows them on one line. For the ccstatusline
status line, install [pistatusline](https://github.com/christophesamueldhp/pistatusline): it draws
the same items under its lines.

While the agent works, "Working..." becomes one of Claude Code's 186 spinner verbs
("Pondering...", "Clauding..."), a new one each turn, none repeated until all have shown.

The welcome header is Claude Code's: the mascot beside name, model and cwd. In the
fullscreen renderer the mascot plays an entrance animation each time pi is launched,
picked at random from Claude Code's four (skip, jump, look, spin) and bluclawd's own
hand wave; `"prefersReducedMotion": true` in settings turns it off.


## Updating

```bash
npm update    # bump the @earendil-works/pi-* peer/dev dependency versions
npm test      # confirm nothing broke against the new pi
```

There is no upstream merge here — this repo owns no pi source to merge into.
The dependency this actually has on pi's internals: `ext/_shared/` (and
`daemon/ansi.ts`) vendor a handful of small pi functions/tables that pi does not export publicly
(`stripAnsi`, the built-in slash-command list, a security-relevant path
resolver). Each is documented in its own file with what drifts
if pi changes it — mostly cosmetic (a stale `/help` line), one
(`path-resolve.ts`) copied whole rather than trimmed because it backs
permission rule matching. `npm run typecheck && npm test` after a pi version
bump is what would actually catch a break.

## Running and checking it

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome check .
npm test            # vitest
node --experimental-strip-types scripts/probe-extensions.ts   # what each extension registers
```

## Session switching

Agent view needs [tmux](https://github.com/tmux/tmux): every session is a full interactive pi of its
own, running in a private tmux server next to the daemon's socket (`~/.pi/server/tmux.sock`).
`pi` in a terminal starts its session there and attaches, so the terminal is only a viewer: all
sessions run at once, and enter/→ in agent view switches the terminal to another session
instantly — nothing waits, nothing is interrupted, and the one you left keeps working. A new
session from the composer is a new pane with the task as its first prompt; ctrl+enter switches to
it. Exit keys follow Claude Code's split between a normal session and a background one. The
session `pi` starts in a terminal is normal until ← opens agent view: ctrl+c twice, ctrl+d twice,
`exit` or `/exit` end it, and so does closing its terminal. Every other session is a background
one: ctrl+c twice, `exit` or `/exit` leave tmux while it keeps running, even with the terminal
closed, and so does a single ctrl+d; running `pi` again starts a new session and lists them all.
Ctrl+c while a turn runs stops the turn, and `/quit` ends any session. Ending a session kills a
turn in progress with its pi, and the session stays listed as a stopped row. In agent view,
ctrl+c twice or `exit` leave tmux, and ctrl+x on a running session ends its pi (the row stays,
stopped) and a second press deletes the row; on this terminal's own session the first press stops
its turn and the second moves the terminal to agent view with no session of its own, as Claude
Code does once the session you came from is deleted: the list can be empty, and esc quits from
there. A session nothing has been asked in yet ends when its terminal leaves it. A peek reply is
the session's next prompt. tmux runs with no prefix key and no status line, passing keys through as CSI u.

Without tmux, agent view is off: pi says so once at startup (and again on ←), and the rest of
bluclawd works as usual.

An empty foreground prompt opens Agent View with one ←. Just after editing text or navigating
history, it asks for a second press to avoid accidentally leaving the conversation.

## Remote control

The daemon serves a phone app on `127.0.0.1` only (port 7878, or `"remote": { "port": … }` in
settings); the phone reaches it over [Tailscale](https://tailscale.com), never the LAN or the
internet. Once, on the Mac: install Tailscale and log in, then run `/remote-control` in any pi
session. It offers to run `tailscale serve --bg 7878`, which gives this Mac an HTTPS address on
your tailnet, and shows that address and a QR code (10 minutes, single use), drawn in the
terminal's own colours. On the phone, also on your tailnet, scan it with the camera: Safari opens
the address and pairs at once, as the link carries a one-time secret; there is nothing to type.
For notifications, then add it to the Home Screen (Share → Add to Home Screen), as Safari then
says: the Home Screen app opens already paired, as a phone of its own ("iPhone (Home Screen)"),
even where iOS does not share Safari's storage with it. Can't scan? The dimmed 6-digit code under
the QR code pairs too, typed into the app (run `/remote-control` again for a new one). The phone
keeps a token; the daemon keeps only its hash, in `~/.pi/server/remote.json`. If your tailnet has Serve
or HTTPS certificates turned off, `/remote-control` shows the link that turns them on, once for
the tailnet. For more than one Mac, add one Home Screen app per Mac: each has its own ts.net
address and pairs on its own.

Once remote control is on, `/remote-control` shows a menu:

- **Pair a new phone**: a new QR code (and 6-digit code).
- **Paired phones (n)…**: each phone with when it paired and was last used; enter removes one, or
  all of them with **Remove all phones**, once confirmed. A removed phone has to pair again.
- **Start at login: on/off** (macOS): starts the daemon at login with a LaunchAgent
  (`~/Library/LaunchAgents/dev.bluclawd.daemon.plist`, its log in `~/.pi/server/daemon.log`), so
  the phone reaches the Mac before any `pi` has run.
- **Turn off remote control**, once confirmed. It leaves `tailscale serve` in place;
  `tailscale serve --https=443 off` removes it.

The Mac is the root: a phone can disconnect only itself (which signs it out), never another;
removing the others is `/remote-control`'s Paired phones.

Started at login, the daemon runs the node and pi that last ran `/remote-control`: after moving
either, as a node upgrade does, running `/remote-control` points it at the new ones for the next
login. The LaunchAgent runs the daemon through your login shell (zsh in place of fish or another
shell that is not POSIX), which reads your login profile (`~/.zprofile`, `~/.profile`) but not
`~/.zshrc`. An API key exported only in `~/.zshrc` is then missing from a
session the phone starts before any `pi` has run since login and, because every session shares
one tmux server that keeps the environment it started with, from every session started after it,
on the Mac too, until that server ends with the last session.

The phone lists every agent-view session in its bands, with what it is doing. A session's chat
shows its conversation, replies with their markdown rendered (older messages load at the top),
streams the reply in progress, sends a prompt, which reaches the session at once (within a few seconds right after a move, or while an
older daemon still runs), and Stop ends its turn (the chat then says it was interrupted). A reply
starting with `/` runs as if typed in the session's prompt on the Mac, once the session is idle and
that prompt empty, but only as Claude Code's Remote Control runs commands: those whose result is
the conversation itself. That is pi's `/compact`, `/new` and `/reload`, and any prompt template or
skill; every other command (a selector such as `/model` or `/resume`, `/tree`, `/fork`, an
extension's) runs only on the Mac, and the phone's autocomplete lists none of them. A session closed on the Mac shows as disconnected, read only:
only the Mac opens it again, and the phone follows it there by itself. While no terminal on the Mac shows pi, the
phone only reads ("pi closed"): sessions still running in the background are listed and notify,
but nothing is sent, stopped or started until a terminal shows pi again. Start begins a new one in a
recent or typed directory. Tapping the title shows the model
(and switches it), context and the session's own tokens and cost, and pins or renames it; the
phone shows no plan usage that pistatusline does not show on the Mac. A session waiting on a dialog says so, and is
answered on the Mac. Enable notifications to hear when a session finishes or needs you:
on iOS only in the app opened from the Home Screen, iOS 16.4 or later. A phone with the app open
in the foreground, on any screen, gets none; your other phones still do.

A prompt to a running session can carry up to four images (+ beside the reply field); a new
session's first prompt is text only. The images in a conversation, a prompt's or a
tool's (`read` on a PNG), show as thumbnails as they scroll into view; tap one for full screen.
The model gets a phone's image as it gets a pasted one. The Mac shows neither as a picture, in
any terminal: pi draws only a prompt's text (a pasted image at least leaves its `[Image #1]`
marker in it, and so does a phone's), and a tool's image only outside tmux, while every
agent-view session runs in tmux, where pi turns image protocols off and does not wrap them for
tmux's passthrough.

A paired phone can read every session, tool output included, and prompt any of them: it is
effectively a shell as you on this Mac. Its token does not expire; revoke a phone
from `/remote-control`'s Paired phones.

What the phone cannot do: work without the daemon running (any `pi` starts it, and so does login
with autostart on) and the Mac awake. A new bluclawd reaches the phone once the daemon restarts,
which agent view and `/remote-control` do when they find its code changed.

## What this layer cannot do

Recorded so nobody re-litigates it. Each was found by running the thing, not by
reading the API:

- **Hidden command aliases are impossible.** `registerCommand` has no alias
  field, and pi's `input` event fires only after the interactive command chain.
  An alias has to be a second, visible command.
- **An extension cannot rebind a pi keybinding.** Trust cycling is
  **Alt+M**, not Claude Code's Shift+Tab, which pi binds to
  `app.thinking.cycle`; pi refuses the registration and logs a conflict.
- **An extension cannot add a theme colour.** pi's `ThemeColor` union is fixed,
  so the `acceptEdits` badge paints Claude Code's `#af87ff` with a raw truecolor
  escape and falls back to the `success` token on a 256-colour terminal.
- **A theme contributed through `resources_discover` cannot be the startup
  theme.** pi resolves the configured theme before that hook runs, so it falls
  back to dark and prints "Theme not found". The theme is declared in
  `package.json`'s `pi.themes` instead, which pi registers before startup.
- **`/theme`'s Auto follows only terminals that report light/dark switches.**
  pi has no extension API for a light/dark pair setting: `/theme` saves the
  pair, shows the theme for the terminal's current appearance, and follows the
  terminal's switch reports (mode 2031) itself until pi restarts and follows the
  pair on its own. A terminal that sends no such reports gets the other theme
  only at the next start. Claude Code's
  syntax-highlighting toggle and its "New custom theme…" editor have no pi
  counterpart; pi's other themes are listed after Claude Code's six.
- **Agent view differs from Claude Code's in a few places.** Row text comes from each
  session's own output, and its state from pi's own signals (a model error is Failed, an
  interrupted turn Stopped, a blocking prompt Needs input) — nothing is added to the system
  prompt and there is no Haiku-class summary, so it works with any provider. There are no pull-request badges (no Ready for review band), no `@repo` / `@agent` mentions, and no worktree isolation for background
  sessions, and there is no mouse support.
  A peek reply cannot answer a session's open dialog (enter opens it to answer), and each idle
  session is a running pi process. `tab` does not browse subagents.

## Read-only subagents

Ask the parent to delegate a bounded exploration or review, supplying target paths or the diff
in the task. The model calls `subagent` with `{ "agent": "explorer", "task": "Trace src/auth.ts" }`;
`"background": true` returns immediately instead of waiting. There is no `/agents` command.
Background runs appear in `/tasks` and the phone's task sheet; local, model-issued, and remote
stops use the same session-owned run. User and remote stops do not start an unsolicited parent turn.
Print/JSON invocations support foreground delegation only; background also works in RPC mode.

Custom roles are Markdown files in `~/.pi/agent/agents/` or a trusted project's `.pi/agents/`.
A trusted project definition overrides a user definition, which overrides a bundled role.
For example, `.pi/agents/api-review.md`:

```markdown
---
name: api-review
description: Review explicitly supplied API handler files for defects.
tools: read, grep, find, ls
model: inherit
maxTurns: 8
---
Review only the supplied targets. Cite path:line evidence, state omissions, and never claim tests ran.
```

Reload after changing definitions. Only these five frontmatter fields are supported, and custom
roles cannot add shell, write/edit, MCP, skills, hooks, or nested delegation. Explicit models use
`provider/model`; virtual routers and model aliases are unsupported. Children get a fresh conversation
and applicable trusted instructions, not the parent's history. This is SDK/tool isolation, **not an
OS security boundary** against faulty trusted extensions.

Reports and private child transcripts live outside the repository under
`<getAgentDir()>/bluclawd/subagents/<parent-session>/<run>/`. The parent gets a bounded, untrusted
report with runtime-owned execution and verification fields. `Verification: not_run` means the child
could not execute tests. `Snapshot` records HEAD and a Git-status fingerprint, not a frozen checkout:
always recheck citations before acting on findings. Leaving the originating conversation branch or
replacing its session invalidates delivery; a restart marks unfinished runs interrupted rather than resuming them.

Foreground child usage is included once in Pi's native totals. Background child usage is additional:
`/status`, the phone's status sheet, and the separate `background-usage-ledger.json` disclose it.
Unpriced child usage is labelled unknown, not free; price-table estimates are not subscription invoices.

`node --experimental-strip-types scripts/eval-subagents.ts` prints the opt-in live evaluation command
without making model calls. `--live` runs synthetic baseline/delegation trials with a conservative
US$10 estimated-cost ceiling; it retains scratch fixtures and JSON results. It is separate from the
scripted-provider tests, and does not replace phone interaction or prove a production quality advantage.
Write-capable workers (M3), patch integration, and automatic worktree cleanup are not enabled.

## Permissions

pi asks nothing before a tool runs, and bluclawd keeps it that way: there are no
permission modes and no prompts. It adds one thing — **deny rules**. A tool call
that matches a `permissions.deny` rule is blocked, and the model is told which rule
blocked it:

```json
{
  "permissions": {
    "deny": ["Bash(rm -rf *)", "Bash(git push --force *)", "Read(~/.ssh/**)", "mcp__github__delete_*"]
  }
}
```

Rules come from `~/.pi/agent/settings.json` and the project's `.pi/settings.json`
(read only when the project is trusted); the two lists add up, so a project cannot
drop your global rules. Syntax: `Bash(npm test *)` is `npm test` alone or with
arguments; `*` stays within a path segment and `**` crosses them; `Edit(...)`
also covers write and `Read(...)` also covers grep, find and ls; `//path` is
absolute, `~/path` is home, anything else is relative to the working directory;
`WebFetch(domain:x.com)`, `WebSearch(...)`, `Subagent` or `Subagent(explorer)`, and MCP tools as `mcp__server`,
`mcp__server__*`, `mcp__server__tool` or `Mcp(server:tool)` — bluclawd ships no
web or MCP tools, so these apply to the `webfetch`/`websearch`/MCP tools another
pi package registers; `dir/**` covers
`dir` itself too. A bash rule also matches the command behind wrappers (`sudo`,
`timeout`, `nice`, `env`, `xargs`, `sh -c '…'`, `eval`, …), shell keywords,
quoting (`'rm'`, `\rm`), `/bin/…`, `$(…)`, and any part of a `&&`/`;`/`|` chain.
A file rule also blocks a bash command that names a matching path —
`cat ~/.ssh/id_rsa`, `cd secret && cat key` — except where the command only writes
it: an output redirect target is never read, so a `Read` rule lets `echo x >> .env`
and `echo x > .env` through, a `Write` rule only `>>`, and an `Edit` rule neither
(`echo x > .git/config` is an `Edit` rule's). `Read(**/.env*)` + `Write(**/.env*)`
keeps `.env` unread and whole while `>>` still appends to it. `powershell` is
judged as bash, and a `grep` over a folder drops the lines it found in a denied
file. Deny rules
match text, not behavior: a command that builds the path or name at run time
(`$(printf rm)`, a variable set earlier, a glob like `~/.ss*`) is not caught.

The footer shows pi's own `defaultProjectTrust` — `⏵⏵ always`, `⏸ ask` or
`✕ never` — and Alt+M cycles it, saving to global settings. It decides whether a
project's `.pi` settings and extensions load when no `/trust` decision was saved;
like `/settings`, the change applies to projects opened from then on.

Deliberately not ported, because pi already has them: **bash mode** (pi's `!cmd`
runs a command and sends its output to the model, `!!cmd` runs it without
sending), **prompt stash** (↑/↓ on the prompt browse earlier prompts, as in
Claude Code), **web search/fetch and MCP** (install a pi package for those; deny
rules still cover them). Also not ported: **PDF input** (would mean reimplementing four
provider wire formats behind `before_provider_request` — a shared-type change
in pi's own `packages/ai`, not reachable through the extension API at all).

### Sandbox

Deny rules match the text of a call, so `grep -r KEY .` or a script that opens `.env`
still reads it. Turn on the sandbox to have the operating system stop that: the model's
`bash` and `monitor` commands, and everything they start, then run inside Anthropic's
[sandbox runtime](https://github.com/anthropics/sandbox-runtime), the one Claude Code uses.
Run `/sandbox` for a menu, `/sandbox on` to enable, `/sandbox off` to disable, or
`/sandbox status` to inspect the current runtime. On/off is saved globally and applied
immediately after the agent is idle; existing background jobs must be restarted. The command
preserves existing policy settings and does not add any deny rules or allowed domains.

Configure the policy in `~/.pi/agent/settings.json` (a project's settings cannot change it);
it is read when a session starts, so `/reload` after editing:

```json
{
  "sandbox": {
    "enabled": true,
    "network": { "allowedDomains": ["registry.npmjs.org", "github.com"] },
    "filesystem": { "allowWrite": ["~/.npm"], "denyRead": [], "denyWrite": [] }
  },
  "permissions": { "deny": ["Read(**/.env*)"] }
}
```

- Reads: everything except what a `Read` rule denies, plus `filesystem.denyRead`.
- Writes: the working directory and the temp directory, plus `filesystem.allowWrite`; never
  what an `Edit` or `Write` rule denies. Under the sandbox a `Write` rule blocks `>>` too.
- Network: hosts in `network.allowedDomains`. For any other host, pi asks once per host and port
  per session, the one prompt bluclawd adds (without a UI, the host is refused).
- Rule paths are anchored at the working directory: `Read(**/.env*)` covers `.env` files
  under the project. Add others to `filesystem.denyRead`, e.g. `~/**/.env*`.
- Every other key of the sandbox runtime's config goes under `sandbox` as written, e.g.
  `credentials` to hide environment variables or `network.deniedDomains`: see
  [docs/sandbox-settings.md](docs/sandbox-settings.md). A key the runtime does not know counts
  as a malformed setting.
- When the sandbox cannot run, or its `sandbox` setting is malformed, the model's `bash` and
  `monitor` are refused and pi says why. There is no unsandboxed fallback. `bash` is also
  refused when bluclawd's background-bash extension is disabled, since pi's own `bash` does
  not run inside the sandbox. pi's `powershell` tool is blocked while it is on. Settings pi
  cannot parse at all turn the sandbox off, with a warning.
- Outside the sandbox: commands you type with `!`, pi's own tools (`read`, `grep`, `edit`,
  …, which the deny rules govern), MCP servers and other extensions; `monitor`'s `ws` source
  (an in-process WebSocket that reads no files); and background jobs already running when you
  turn the sandbox on, until they are restarted. An app the model
  starts cannot read `.env` either; run it yourself with `!`.

| Platform | Needs |
|---|---|
| macOS | Nothing (Seatbelt) |
| Linux, WSL2 | `bubblewrap`, `socat` and `ripgrep` (`apt install bubblewrap socat ripgrep`). On Ubuntu 24.04+, unprivileged user namespaces must be allowed by AppArmor: see [Anthropic's notes](https://code.claude.com/docs/en/sandboxing) |
| Windows | Not supported; run pi in WSL2 |
