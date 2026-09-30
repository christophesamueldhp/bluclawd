# bluclawd

A feature layer for [pi](https://github.com/earendil-works/pi), installed as an
ordinary pi package — not a fork. **Nothing here modifies a file pi owns**, and
nothing here bundles pi's own source: install pi normally, then install this on
top.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # pi itself
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
| What a feature does | `ExtensionAPI`: `registerCommand`, `registerTool`, `registerShortcut`, `appendEntry` + `registerEntryRenderer`, `ui.custom`, `setHeader`, `switchSession`, `resources_discover`, … |

`bin.mjs` is a convenience entry point for trying this out without a separate
`pi install` (imports `@earendil-works/pi-coding-agent` as a normal
dependency); it is not how `pi install` loads this package.

## What ships

```
package.json    the pi package manifest (pi.extensions, pi.themes, peer dependencies)
bin.mjs         convenience entry point for local runs
themes/         the bluclawd theme
daemon/         agent view's background-session daemon (state in ~/.pi/server, or $PI_SERVER_DIR)
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
| `background-bash` | `/tasks`, `/bashes`; the `bash`, `monitor` and `task_stop` tools |
| `branding` | `/theme`; welcome header and mascot |
| `diagnostics` | `/status`, `/context` |
| `agent-view` | `/agent-view` (what `←` twice dispatches) |
| `help` | `/help` |
| `vibes` | spinner verbs |

## What it adds

Claude Code's names and behaviours, on top of pi's own commands:

| Command | What it does |
|---|---|
| `permissions.deny`, Alt+M | deny rules block matching tool calls; the footer shows pi's `defaultProjectTrust` (`⏵⏵ always` / `⏸ ask` / `✕ never`) and Alt+M cycles it — see [Permissions](#permissions) |
| `/tasks` | background tasks dialog (alias `/bashes`): shells (`run_in_background`, Ctrl+B on the model's running bash, or a foreground command past its `timeout`), monitors; running tasks only; Enter shows a task's output tail, `x` stops it (the model is told without a turn starting), and updates wait while the dialog is open. The model's bash is Claude Code's: `timeout` in milliseconds (2 minutes by default), a command still running then - or on Ctrl+B after 2s, or when you send a message - moves to the background instead of being killed, and the model reads a task's output file with `read`. The footer pill counts the running shells and monitors; ↓ from an empty prompt selects it and Enter opens the dialog. A shell writes its whole output to a file named in its start result and exit notification; `task_stop` stops it. A job notifies the model once when it exits, and once more if it goes quiet for 45s on what reads as an interactive prompt (`(y/n)`, `Press Enter`, …); the `monitor` tool turns each stdout line of a long-running command, or each frame of a WebSocket (`ws`), into an event that wakes the model (Claude Code's `Monitor`; stderr goes to the output file; every monitor expires after `timeout_ms`, 5 minutes by default and at most 30, with one notice so the model can re-arm it) |
| `/rewind` | file checkpoints per turn; restores the files, the conversation, or both. Checkpoints are git commits kept under `refs/bluclawd/checkpoints/<session>/`: the newest 50 per session, and another session's refs are pruned after 30 days |
| `←` twice on an empty prompt (or `/agent-view`) | agent view, as Claude Code's `claude agents`: background sessions in Needs input / Working / Completed bands (ctrl+s: by directory, remembered), one line each — `✻`/spinner/`∙` + name, what it is doing, age. Type a task + enter to start a background session (ctrl+enter: start it here), shift+enter / ctrl+j adds a line, ctrl+g writes it in `$EDITOR`, space peeks and replies (1-9 answers a pending question), enter/→ opens a session in this window (this one keeps running in the background), alt+1-9 opens the Nth session in the focused one's directory, ctrl+x stops then deletes, ctrl+t pins, ctrl+r renames, shift+↑↓ reorders, `s:<state>` filters, `/resume` brings a past session back, `/model` sets the model for new ones. The footer shows `← for agents` / `← N agents` / `← N done`, and `Press ← again to open agents` after the first press. Background sessions run under a local daemon (`daemon/`, a Unix socket in `~/.pi/server`), so they keep running after pi exits or its terminal closes, and so does a turn that was in progress in this window when you quit or switched away: the daemon resumes it with a "continue where you left off" prompt. A session that was idle when pi exited is kept as a row with no process (it resumes when opened or replied to); every row stays until ctrl+x deletes it; it reports presence to radius.pi.dev only when a radius credential or `RADIUS_API_KEY` is configured |
| `/status`, `/context` | model, auth, safety, session, context window |
| `/theme` | theme |
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

## What this layer cannot do

Recorded so nobody re-litigates it. Each was found by running the thing, not by
reading the API:

- **Hidden command aliases are impossible.** `registerCommand` has no alias
  field, and pi's `input` event fires only after the interactive command chain.
  An alias is a second, visible command (`/bashes` for `/tasks`).
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
- **`newSession()` takes no model**, so agent view's ctrl+enter (start a task in this
  window) says so when `/model` chose a different one.
- **Agent view differs from Claude Code's in a few places.** Row text comes from each
  session's own output — background sessions are asked to end a turn with a `result:` /
  `needs input:` / `failed:` line — not from a Haiku-class summary, so it works with any
  provider. There are no pull-request badges (no Ready for review band), no `!` shell-job
  rows, no `@repo` / `@agent` mentions, and no worktree isolation for background
  sessions. Opening a session here stops its background process first (pi holds one
  session per window), and a session leaving this window goes to a new background process, so
  a turn in progress is cut off and resumed with a "continue" prompt rather than carried over
  mid-tool: a running command starts again. `←`
  always takes two presses (Claude Code opens on one when the prompt was already
  empty), and `tab` does not browse subagents.

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
