# bluclawd

A feature layer for [pi](https://github.com/earendil-works/pi), installed as an
ordinary pi package — not a fork. **Nothing here modifies a file pi owns**, and
nothing here bundles pi's own source: install pi normally, then install this on
top.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # pi itself
brew install tmux                                                  # agent view needs it
pi install /path/to/this/repo                                     # this layer
pi                                                                 # run it
```

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
daemon/         agent view's session registry (state in ~/.pi/server, or $PI_SERVER_DIR)
ext/            the feature layer, one directory per extension
  _shared/      cross-extension state (via globalThis), settings readers, vendored pi internals
scripts/        probe-extensions.ts — headless report of what each extension registers
test/           vitest suites, self-contained — no monorepo, no fixture files
```

8 extensions, no runtime dependencies (pi's own packages are peers):

| Extension | Registers |
|---|---|
| `permissions` | deny-rule gate on every tool call; Alt+M |
| `checkpoints` | `/rewind` |
| `background-bash` | `/tasks`; the `bash`, `monitor` and `task_stop` tools |
| `branding` | `/theme`; welcome header and mascot |
| `diagnostics` | `/status`, `/context` |
| `agent-view` | `/agent-view` (what `←` twice dispatches) |
| `help` | `/help` |
| `vibes` | spinner verbs |
| `paste` | Claude Code's paste in the prompt and agent view's composer: a paste over 800 characters or 2 lines shows as `[Pasted text #N +L lines]`, a ctrl+v image as `[Image #N]` (sent as an image), and pasting the same thing again right after shows the text or the image's file |

## What it adds

Claude Code's names and behaviours, on top of pi's own commands:

| Command | What it does |
|---|---|
| `permissions.deny`, Alt+M | deny rules block matching tool calls; the footer shows pi's `defaultProjectTrust` (`⏵⏵ always` / `⏸ ask` / `✕ never`) and Alt+M cycles it — see [Permissions](#permissions) |
| `/tasks` | background tasks dialog: shells (`run_in_background`, Ctrl+B on the model's running bash, or a foreground command past its `timeout`), monitors, and the model's bash still running in the foreground once it has run 2s (marked `foreground`; `x` kills it; Claude Code does not list these); running tasks only; Enter shows a task's output tail, `x` stops it (the model is told without a turn starting), and updates wait while the dialog is open. The model's bash is Claude Code's: `timeout` in milliseconds (2 minutes by default), a command still running then - or on Ctrl+B after 2s, or when you send a message - moves to the background instead of being killed, and the model reads a task's output file with `read`. The footer pill counts the running shells and monitors; ↓ from an empty prompt selects it and Enter opens the dialog. A shell writes its whole output to a file named in its start result and exit notification; `task_stop` stops it. A job notifies the model once when it exits, and once more if it goes quiet for 45s on what reads as an interactive prompt (`(y/n)`, `Press Enter`, …); the `monitor` tool turns each stdout line of a long-running command, or each frame of a WebSocket (`ws`), into an event that wakes the model (Claude Code's `Monitor`; stderr goes to the output file; every monitor expires after `timeout_ms`, 5 minutes by default and at most 30, with one notice so the model can re-arm it) |
| `/rewind` (or Esc twice on an empty prompt, as in Claude Code) | file checkpoints per turn; restores the files, the conversation, or both. Checkpoints are git commits kept under `refs/bluclawd/checkpoints/<session>/`: the newest 50 per session, and another session's refs are pruned after 30 days |
| `←` on an empty prompt (or `/agent-view`) | agent view, as Claude Code's `claude agents`: background sessions in Needs input (blocked on a prompt) / Working (a turn running) / Idle (nothing running) bands (empty ones hidden; ctrl+s: by directory, this one first, remembered), one line each — `✻`/spinner/`∙` + name, what it is doing (a working session's current tool), age. Type a task + enter to start a background session (ctrl+enter: start it and switch to it), shift+enter / alt+enter / ctrl+j adds a line, ctrl+g writes it in `$EDITOR`, ctrl+v attaches a clipboard image to the new-session composer, an unknown `/command` is sent as the task, `!<command>` runs it in your shell as a row of its own (its last output line while it runs, then done, `exit N — …` or stopped; enter shows its output, ctrl+x stops it then removes the row, and it is never run again), space peeks and replies (the reply is the session's next prompt, `/stop` stops it; a reply draft is kept per session), enter/→ switches this terminal to any session at once, including Working and Needs input (see [Session switching](#session-switching)), ↑↓ wrap, alt/ctrl+↑↓ jump between bands, alt+1-9 opens the Nth session in the focused one's directory, ctrl+x stops then deletes (this terminal's own session too: the terminal moves to agent view), ctrl+t pins, ctrl+r renames, shift+↑↓ reorders, `s:<state>` / `n:<name>` filter (ctrl+f turns the text into a name search), `/resume` brings a past session back and opens it, `/model <name>` (or `default`) sets the model for new ones, `/cd <dir>` sets the directory they start in (relative to the current one; bare `/cd` goes back), tab completes the model or directory (several matches are listed: ↑↓ and tab or enter pick one), typing `/` lists these commands (↑↓ to pick, tab or enter completes one that takes an argument, enter runs the rest), the hint line starts with the mode new ones start in (`⏵⏵ always` or `✕ never`; nothing at pi's default, `ask`), `?` shows the shortcuts, esc returns to your session, and ctrl+c twice (or `exit`, `/exit`) leaves tmux with the sessions still running. The footer shows `← for agents` / `← N agents` / `← N done`, and `Press ← again to open agents` after the first press. Every session is a pi of its own in tmux, so it keeps running after its terminal leaves or closes; a local daemon (`daemon/`, a Unix socket in `~/.pi/server`) only lists them. Agent View detects both changed daemon code and a changed Pi installation, and restarts an obsolete daemon. A session that was idle when its pi quit is kept as a row with no process (it resumes when opened or replied to); every row stays until ctrl+x deletes it |
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
The dependency this actually has on pi's internals: `ext/_shared/` vendors a
handful of small pi functions/tables that pi does not export publicly
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
- **`/theme`'s Auto applies fully only from the next start.** pi has no
  extension API for a light/dark pair setting: `/theme` saves the pair and
  shows the theme for the terminal's current appearance, but the session does
  not follow a light/dark switch until pi restarts or reloads. Claude Code's
  syntax-highlighting toggle and its "New custom theme…" editor have no pi
  counterpart; pi's other themes are listed after Claude Code's six.
- **Agent view differs from Claude Code's in a few places.** Row text comes from each
  session's own output, and its state from pi's own signals (a model error is Failed, an
  interrupted turn Stopped, a blocking prompt Needs input) — nothing is added to the system
  prompt and there is no Haiku-class summary, so it works with any provider. There are no pull-request badges (no Ready for review band), no `@repo` / `@agent` mentions, and no worktree isolation for background
  sessions, and there is no mouse support.
  A peek reply cannot answer a session's open dialog (enter opens it to answer), and each idle
  session is a running pi process. `tab` does not browse subagents.

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
`WebFetch(domain:x.com)`, `WebSearch(...)`, and MCP tools as `mcp__server`,
`mcp__server__*`, `mcp__server__tool` or `Mcp(server:tool)` — bluclawd ships no
web or MCP tools, so these apply to the `webfetch`/`websearch`/MCP tools another
pi package registers; `dir/**` covers
`dir` itself too. A bash rule also matches the command behind wrappers (`sudo`,
`timeout`, `nice`, `env`, `xargs`, `sh -c '…'`, `eval`, …), shell keywords,
quoting (`'rm'`, `\rm`), `/bin/…`, `$(…)`, and any part of a `&&`/`;`/`|` chain.
A `Read`/`Edit` rule also blocks a bash command that names a matching path —
`cat ~/.ssh/id_rsa`, `echo x > .git/config`, `cd secret && cat key`. Deny rules
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
