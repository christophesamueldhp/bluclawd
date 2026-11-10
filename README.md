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

For a Git installation, use `pi install git:github.com/christophesamueldhp/bluclawd`;
pi installs the package's production dependencies automatically. To update this package, use
`pi update git:github.com/christophesamueldhp/bluclawd`. Choose host upgrades separately;
`pi update --all` also updates pi itself. Restart pi or run `/reload` to load updated extensions.
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
themes/         the bluclawd themes: bluclawd's six palettes
daemon/         agent view's session registry (state in ~/.pi/server, or $PI_SERVER_DIR), and its client, tmux and row code the extensions share
ext/            the feature layer, one directory per extension
  _shared/      cross-extension state (via globalThis), settings readers, vendored pi internals
scripts/        probe-extensions.ts — headless report of what each extension registers
test/           vitest suites, self-contained — no monorepo, no fixture files
```

18 extensions. Pi's own packages are peers; the vendored sandbox runtime is a production dependency.

| Extension | Registers |
|---|---|
| `tmux-launch` | outside tmux, `pi` starts its session as an agent-view pane and attaches to it |
| `permissions` | deny-rule gate on every tool call; Alt+M |
| `sandbox` | `/sandbox`; the model's `bash` and `monitor` run in the sandbox runtime when it is on |
| `checkpoints` | `/rewind` |
| `background-bash` | `/tasks`; the `bash`, `monitor`, `schedule_wakeup` and `task_stop` tools |
| `subagents` | model-only `subagent` tool (`general-purpose`, `explorer`, `reviewer`, plus trusted `.pi/agents/*.md` and `~/.pi/agent/agents/*.md`) |
| `branding` | `/theme`; welcome header and mascot |
| `transcript` | the transcript's tool look: a collapsed tool call is one `⏺ Name(arg)` line with a `⎿` summary |
| `agent-view` | `/agent-view` (what `←` twice dispatches) |
| `remote` | `/remote-control` |
| `help` | `/help`, `/status`, `/context` |
| `vibes` | spinner verbs |
| `skills` | choose `/skill:name` from autocomplete anywhere in a terminal draft; selected markers show scope, package provenance, and instruction-file location, and delete as one unit. Typed or pasted references remain ordinary text, including at the beginning. |
| `prompt-assist` | `/prompt-assist`; prompt suggestions and automatic session titles with a selectable Pi model; manual rename stays available |
| `web` | `/web`; the `websearch` (Exa or OpenAI) and `webfetch` (Exa) tools |
| `memory` | `/memory`; the model-only `memory` tool, which keeps Memories of the Project across sessions |
| `accounts` | `/accounts`, `--models`, `--scoped`; named OAuth/API-key accounts and Active model selection in one chooser |
| `paste` | bluclawd's paste in the prompt and agent view's composer: a paste over 800 characters or 2 lines shows as `[Pasted text #N +L lines]`, a ctrl+v image as `[Image #N]` (sent as an image), and pasting the same thing again right after shows the text or the image's file |

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
budgets and the bounded conversation excerpt are bluclawd cost controls, not documented bluclawd limits.
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

**Web.** `websearch` sends a search to one of two search providers: **Exa** (ranked pages with
highlights) or **OpenAI** (a short cited answer plus its sources), through the ChatGPT/Codex
login pi already holds, whatever model you chat with. Store the Exa key like any other pi key:
**`/login`** → *Sign in with an API key* → **Exa** saves it in `~/.pi/agent/auth.json`, where a
`!command` value (e.g. `"!security find-generic-password -ws exa"`) keeps it in the Keychain
instead; `EXA_API_KEY` is the fallback. The key stays inside pi, out of the shell commands it runs. Each OpenAI search spends
Codex quota. `webfetch` reads up to 10 known URLs through Exa. **`/web`** opens a searchable
picker for the provider and for the Codex model OpenAI searches run on; **`/web exa`**,
**`/web openai`** and **`/web status`** work without it. The model can pick a provider per call;
when one cannot answer (rate limit, outage, no credits, no login), the other one does, and the
result says so. The choice is saved in `~/.pi/agent/bluclawd/web.json`. Why bluclawd ships its own
web tools: [ADR-0004](docs/adr/0004-bluclawd-ships-its-own-web-tools.md).

## Provider accounts

Run **`/accounts`** to open the unified **Accounts/Models** chooser. Type to search providers and
see connection status and active-account names; press **Tab** to move between sections. Choose a
provider, then **Add account…** to sign in with OAuth or an API key.
Give each account a name such as Personal or Work. A successful sign-in activates that account;
the previous login is preserved automatically. **Save current login…** names the login already
stored by Pi without signing in again; if already saved, this renames the active account rather
than duplicating its OAuth grant. Select a saved account to switch; `✓` marks the active one.
**`/accounts provider-id`** opens that provider directly, for example `/accounts openai-codex`.
Removing an inactive saved account requires confirmation; the active account cannot be removed.

Open **Models** directly with **`/accounts --models`** to browse across connected providers, or
**`/accounts --scoped`** to start in the read-only native Scoped view (not Edit scope).
These routes use the same Accounts/Models chooser and require the terminal UI. Use one route flag
alone, or a provider ID alone; unknown flags, providers, and combined arguments show usage guidance
without changing accounts.

**Models** groups the catalog by provider and shows each active account. Type to search, use
**Ctrl+P** to cycle provider filters, **Ctrl+S** for All/Scoped, and **Enter** to use an available
model. **Active model**, **Scoped**, and **Unavailable** are separate labels. **Ctrl+A (Show all)**
reveals models outside scope without changing scope. Successful sign-in opens that provider's
Models; choosing a model is optional, and closing the chooser keeps the login. Model selection
changes only the current session's Active model, not scope or defaults. Account switches refresh
availability and warn about lost access without substituting a model or changing scope.
The built-in `/login`, `/model`, and `/scoped-models` commands and native model-selection shortcuts
remain host-owned and unchanged. The `/accounts` routes are bluclawd entry points, not overrides
of those commands; this chooser does not edit scope or defaults.

Scope display is verified on unmodified stock pi **1.0.4** using the public
`ExtensionCommandContext.scopedModels` and `modelRegistry.getAll()` / `getAvailable()` contracts;
explicit selection uses `ExtensionAPI.setModel()`. An empty host scope means unrestricted
available models. A nonempty scope keeps its membership even when every member is unavailable:
those present in the host snapshot stay visible but cannot be selected. References absent from
that snapshot cannot be reconstructed. Reopening reads the current command context, including
after native scope changes, `/reload`, or session replacement. Native cycling, startup precedence,
and scope/default persistence remain pi-owned; the chooser does not infer startup intent.
See [Accounts compatibility and verification](docs/accounts-compatibility.md) for the exact
published package set checked, extension contracts, reproducible checks, and installation limits.

Accounts are per provider: switching OpenAI does not change Anthropic, Exa, or another provider.
The model, conversation, settings, and extensions stay unchanged. Changes apply to the shared Pi
credentials, including other sessions and future background requests; wait for other Pi sessions
to finish requests before switching. The command refuses changes while this session or its
background subagents are running. Use `/accounts` rather than `/login` to add another account;
`/login` replaces the currently active login. Environment variables and provider configuration
can override stored API keys; accounts manage stored logins, not ambient AWS profiles or other
external credential sources. Providers without interactive sign-in can only save an existing
stored login. Adding accounts requires the terminal UI; saved-account switching also supports RPC UI.

Saved credentials and account names are stored in `~/.pi/agent/bluclawd/accounts.json`, with
owner-only file permissions, alongside Pi’s active credentials in `auth.json`. Both follow
`PI_CODING_AGENT_DIR`. These are local plaintext credential files, not an encrypted keychain;
do not share them or commit them. Entered keys and authorization codes are masked and are not
sent into the conversation. OAuth sign-in shows the provider’s URL or device code; open it in
the browser account you want to add. Token refresh remains Pi’s responsibility; switching away
saves the latest refreshed credential for reuse.

## What it adds

bluclawd's names and behaviours, on top of pi's own commands:

| Command | What it does |
|---|---|
| `permissions.deny`, Alt+M | deny rules block matching tool calls; the footer shows pi's `defaultProjectTrust` (`⏵⏵ always` / `⏸ ask` / `✕ never`) and Alt+M cycles it — see [Permissions](#permissions) |
| `/tasks` | background tasks dialog: shells (`run_in_background`, Ctrl+B on the model's running bash, or a foreground command past its `timeout`), monitors, subagents (`subagent` with `background: true`), pending wake-ups (`schedule_wakeup`, `x` cancels one), and the model's bash still running in the foreground once it has run 2s (marked `foreground`; `x` kills it; bluclawd does not list these); running tasks only; Enter shows a task's output tail, `x` stops it (the model is told without a turn starting), and updates wait while the dialog is open. The model's bash is bluclawd's: `timeout` in milliseconds (2 minutes by default), a command still running then - or on Ctrl+B after 2s, or when you send a message - moves to the background instead of being killed, and the model reads a task's output file with `read`. The footer pill counts the running shells and monitors; ↓ from an empty prompt selects it and Enter opens the dialog. A shell writes its whole output to a file named in its start result and exit notification; `task_stop` stops shells, monitors, and background subagents (`sub_*`), and cancels wake-ups (`w*`). `schedule_wakeup` (orchestrators only, not runs) schedules a turn of the agent's own: `prompt` plus `delay` in seconds or `at` a local `HH:MM` (its next occurrence), due between 1 minute and 24 hours from now; when it is due a notice carrying the prompt and due time starts the next turn, after the running one ends. Wake-ups are kept in the session log: they survive a reload and a reopen of the session (`/resume`, or pi started on its file), and one that fell due while the session was closed fires once, late, saying when it was due. Ending the session cancels them: a quit, `/new`, a `/resume` of another session, a fork (the fork gets none), tree navigation, or a stop of its row in agent view. An interactive pi that crashes, or is ended by a signal bluclawd did not send (a closed terminal, a `kill`, a logout), keeps them: the daemon, which scheduling one starts, holds a copy, and when one falls due with that pi gone it reopens the session in agent view's tmux, where it fires, late if the daemon was down. A job notifies the model once when it exits, and once more if it goes quiet for 45s on what reads as an interactive prompt (`(y/n)`, `Press Enter`, …); the `monitor` tool turns each stdout line of a long-running command, or each frame of a WebSocket (`ws`), into an event that wakes the model (bluclawd's `Monitor`; stderr goes to the output file; every monitor expires after `timeout_ms`, 5 minutes by default and at most 30, with one notice so the model can re-arm it) |
| `subagent` tool | model-only delegation (`general-purpose`, `explorer` and `reviewer` bundled, plus custom Markdown definitions in trusted `<cwd>/.pi/agents/*.md` and `~/.pi/agent/agents/*.md`). Each run is a full pi session of its own in agent view's tmux server (subagents need tmux), with a fresh context in the same live checkout and the role as its launch flags; it cannot delegate further. It inherits the parent model and thinking level unless the role or the call picks others; a model picked without a thinking level gets pi's default for it. The `subagent_models` tool lists the models a run can use. A run stays open and reports after each of its turns until it is closed (`subagent_close`, `x`, or the end of the orchestrator's session), at most 8 open at once, never on a turn, tool-call, token, or time limit. A foreground call returns the run's first report; `background: true` returns at once. A run's usage is counted in its own session; `/status` shows the runs' total apart (see [Subagents](#subagents)) |
| `/rewind` (or Esc twice on an empty prompt) | bluclawd's rewind: a file checkpoint per message you send; lists your prompts newest first with what each changed (`a.ts +3 -1`, `No code changes`, `⚠ No code restore`), then Restore code and conversation / Restore conversation (the prompt returns to the editor) / Restore code / Never mind, with no further confirmation (the current files are checkpointed first and listed as `(before rewind)`, so `/rewind` undoes it). New files the agent created since the point (`write`, `bash`) are removed and your own are kept; unlike bluclawd it also restores files changed through bash or by hand. Checkpoints are git commits kept under `refs/bluclawd/checkpoints/<session>/`: the newest 50 per session, and another session's refs are pruned after 30 days |
| `←` on an empty prompt (or `/agent-view`) | agent view: background sessions in Needs input (blocked on a prompt) / Working (a turn running) / Idle (nothing running) bands (empty ones hidden; ctrl+s: by directory, this one first, remembered), one line each — `✻`/spinner/`∙` + name, what it is doing (a working session's current tool), age. Type a task + enter to start a background session (ctrl+enter: start it and switch to it), shift+enter / alt+enter / ctrl+j adds a line, ctrl+g writes it in `$EDITOR`, ctrl+v attaches a clipboard image to the new-session composer, an unknown `/command` is sent as the task, `!<command>` runs it in your shell as a row of its own (its last output line while it runs, then done, `exit N — …` or stopped; enter shows its output, ctrl+x stops it then removes the row, and it is never run again), space peeks and replies (the reply is the session's next prompt, `/stop` stops it; a reply draft is kept per session), enter/→ switches this terminal to any session at once, including Working and Needs input (see [Session switching](#session-switching)), ↑↓ wrap, alt/ctrl+↑↓ jump between bands, alt+1-9 opens the Nth session in the focused one's directory, ctrl+x stops then deletes (this terminal's own session too: the terminal moves to agent view; an orchestrator's runs go with it), an orchestrator's open runs fold into a `▸ N subagents` line under its row that enter shows and hides, ctrl+t pins, ctrl+r renames, shift+↑↓ reorders the Pinned band and directory view (Needs input, Working and Idle always list most recent first), `s:<state>` / `n:<name>` filter (ctrl+f turns the text into a name search), `/resume` brings a past session back and opens it, `/model <name>` (or `default`) sets the model for new ones, `/cd <dir>` sets the directory they start in (relative to the current one; bare `/cd` goes back), tab completes the model or directory (several matches are listed: ↑↓ and tab or enter pick one), typing `/` lists these commands (↑↓ to pick, tab or enter completes one that takes an argument, enter runs the rest), the hint line starts with the mode new ones start in (`⏵⏵ always` or `✕ never`; nothing at pi's default, `ask`), `?` shows the shortcuts, esc returns to your session, and ctrl+c twice (or `exit`, `/exit`) leaves tmux with the sessions still running, except the one `pi` started in this terminal, which ends with it while idle. The footer shows `← for agents` / `← N agents` / `← N done`, and `Press ← again to open agents` after the first press. Every session is a pi of its own in tmux, so it keeps running after its terminal leaves or closes; a local daemon (`daemon/`, a Unix socket in `~/.pi/server`) only lists them. Agent View detects both changed daemon code and a changed Pi installation, and restarts an obsolete daemon. A session that was idle when its pi quit is kept as a row with no process (it resumes when opened or replied to); every row stays until ctrl+x deletes it |
| `/remote-control` | bluclawd's Remote Control, for every agent-view session: a phone app (a PWA the daemon serves) lists them in agent view's bands, shows a session's conversation and its reply as it streams, sends it a prompt, stops its turn, starts sessions, switches the model, and notifies you; a message once sent is never edited from the phone, only stopped. `/remote-control` turns it on and shows a QR code that pairs your phone; once on, it offers a menu: pair a new phone, the paired phones (remove one or all), start at login (macOS), turn off — see [Remote control](#remote-control) |
| `/prompt-assist [on\|off\|provider/model\|default]` | enable/disable prompt suggestions and automatic session naming, or choose and save their Pi model without changing the coding model |
| `/status`, `/context` | `/status`: model, auth, project trust; `/context`: context window usage (session file, messages, tokens and cost stay in pi's `/session`) |
| `/theme` | bluclawd's theme picker: Auto (match terminal), Dark / Light mode, their colorblind-friendly and ANSI-only variants (bluclawd's six palettes, with the bluclawd mascot cyan as accent), then every other pi theme; the focused theme previews live over a `demo.js` diff, Enter saves it, Esc restores the saved one. `/theme <name>` sets one directly |
| `exit`, `/exit`, `quit`, `:q`, `:wq` alone at the prompt | as bluclawd's `/exit`: ends a normal session, detaches from a background one (see [Session switching](#session-switching)) |
| `/help` | all of the above, grouped |

bluclawd draws no footer of its own. Its footer items go through pi's `setStatus`, keyed so they
sort in this order: `⏵⏵ always (alt+m to cycle)`, then the background-task pill,
then `← for agents`. pi's own footer shows them on one line. For the ccstatusline
status line, install [pistatusline](https://github.com/christophesamueldhp/pistatusline): it draws
the same items under its lines, and the subagent panel as a block below them. Under pi's own footer,
which flattens every status onto one line, the panel stays below the prompt.

While the agent works, "Working..." becomes one of bluclawd's 186 spinner verbs, a new one
each turn, none repeated until all have shown, with the turn's elapsed time and the interrupt
key as you bound it: `Pondering… (12s · escape to interrupt)`, counted every second. bluclawd's prompt editors keep
the spinner in the prompt's top border, as pi's own editor does.

The welcome header is bluclawd's: the mascot beside name, model and cwd. In the
fullscreen renderer the mascot plays an entrance animation each time pi is launched,
picked at random from bluclawd's four (skip, jump, look, spin) and bluclawd's own
hand wave; `"prefersReducedMotion": true` in settings turns it off.

For a quieter start, set `"quietStartup": "header"` in `~/.pi/agent/settings.json`. It hides
pi's startup details (the `Model scope` line and the `[Context]`, `[Skills]` and `[Extensions]`
blocks) and keeps bluclawd's welcome header; `true` would hide the header too. bluclawd does not
change your settings itself.


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

To see how long each extension's handlers take, start pi with `BLUCLAWD_TIMING=1`: every handler call
(and each agent-view pane `heartbeat`, which a timer runs) is appended to
`~/.pi/agent/bluclawd/timing.jsonl` (under `$PI_CODING_AGENT_DIR` when set) as
`{pid, ext, event, ms, sinceProcessStart}`; a pi's prompt is ready at the end of its last `session_start`.
A pi in agent view's tmux takes the variable from the pi that started that tmux server.
Without it nothing is wrapped or written. Summarise the log per extension and event, slowest first:

```bash
jq -s 'group_by(.ext, .event) | map({ext: .[0].ext, event: .[0].event, calls: length, total_ms: (map(.ms) | add | round), max_ms: (map(.ms) | max | round)}) | sort_by(-.total_ms)[]' -c ~/.pi/agent/bluclawd/timing.jsonl
```

## Session switching

Agent view needs [tmux](https://github.com/tmux/tmux): every session is a full interactive pi of its
own, running in a private tmux server next to the daemon's socket (`~/.pi/server/tmux.sock`).
`pi` in a terminal starts its session there and attaches, so the terminal is only a viewer: all
sessions run at once, and enter/→ in agent view switches the terminal to another session
instantly — nothing waits, nothing is interrupted, and the one you left keeps working. A new
session from the composer is a new pane with the task as its first prompt; ctrl+enter switches to
it. Exit keys follow bluclawd's split between a normal session and a background one. The
session `pi` starts in a terminal is normal until ← opens agent view: ctrl+c twice, ctrl+d twice,
`exit` or `/exit` end it, and so does closing its terminal. Every other session is a background
one: ctrl+c twice, `exit` or `/exit` leave tmux while it keeps running, even with the terminal
closed, and so does a single ctrl+d; running `pi` again starts a new session and lists them all.
Ctrl+c while a turn runs stops the turn, and `/quit` ends any session. Ending a session kills a
turn in progress with its pi, and the session stays listed as a stopped row. In agent view,
ctrl+c twice or `exit` leave tmux, and ctrl+x on a running session ends its pi (the row stays,
stopped) and a second press deletes the row; on this terminal's own session the first press stops
its turn and the second moves the terminal to agent view with no session of its own once the session you came from is deleted: the list can be empty, and esc quits from
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
your tailnet, and shows that address, a QR code and a 6-digit code under it (10 minutes, single
use), drawn in the terminal's own colours. On the phone, also on your tailnet, scan it with the
camera.

On an iPhone, Safari then shows how to add the app to the Home Screen (Share → Add to Home
Screen): open it from there and type the 6-digit code, once. iOS gives a Home Screen app storage of
its own, apart from Safari's, so it is the app that pairs, and only it gets notifications. "Use in
Safari instead" pairs Safari itself with the QR code's secret, unless the app paired first. On
Android or a computer, the link pairs the browser at once, as it carries a one-time secret, and the
app added to the Home Screen from it opens already paired. Can't scan? Type the 6-digit code into
the app. Either code expired? Run `/remote-control` again for a new one.

On the iPhone, turn on VPN On Demand in the Tailscale app, so the phone is on your tailnet whenever
you open bluclawd, and keep the Mac awake on power (System Settings → Battery → Options → Prevent
automatic sleeping when the display is off). If the app cannot reach the Mac, it says so and keeps
retrying; it stays paired.

The phone keeps a token; the daemon keeps only its hash, in `~/.pi/server/remote.json`. If your tailnet has Serve
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
that prompt empty, but only as bluclawd's Remote Control runs commands: those whose result is
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
  **Alt+M**, not bluclawd's Shift+Tab, which pi binds to
  `app.thinking.cycle`; pi refuses the registration and logs a conflict.
- **An extension cannot add a theme colour.** pi's `ThemeColor` union is fixed,
  so the `acceptEdits` badge paints bluclawd's `#af87ff` with a raw truecolor
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
  only at the next start. bluclawd's
  syntax-highlighting toggle and its "New custom theme…" editor have no pi
  counterpart; pi's other themes are listed after bluclawd's six.
- **Agent view differs from bluclawd's in a few places.** Row text comes from each
  session's own output, and its state from pi's own signals (a model error is Failed, an
  interrupted turn Stopped, a blocking prompt Needs input) — nothing is added to the system
  prompt and there is no Haiku-class summary, so it works with any provider. There are no pull-request badges (no Ready for review band), no `@repo` / `@agent` mentions, and no worktree isolation for background
  sessions, and there is no mouse support.
  A peek reply cannot answer a session's open dialog (enter opens it to answer), and each idle
  session is a running pi process. `tab` does not browse subagents.

## Subagents

The orchestrator (the parent session) splits work across subagent runs. Each run is a full
interactive pi of its own in agent view's private tmux server, so subagents need tmux: without it,
the `subagent` tool refuses and says so. A run works in the **same live checkout** as the
orchestrator, loads your packages and settings (so the same deny rules, hooks and sandbox apply in
it), and starts in the orchestrator's trust for the project, never asking. There are no locks or
conflict detection: edits are live for everyone and the last write wins, so the orchestrator owns the
split, handoffs and final verification. A run cannot launch runs of its own. A run asks for approval
in its own session, such as the sandbox's network confirm: its panel row reads `needs input` and the
orchestrator's session gets a notice; open the run to answer.

Ask the parent to delegate distinct pieces of work with explicit files or areas in each task.
The model calls `subagent` with `{ "agent": "general-purpose", "task": "Add input validation to src/auth.ts" }`.
A foreground call waits for the run's first report and returns it; `"background": true` returns at
once. Either way the run stays open after it reports, and reports again after each later turn: its
last message of a turn reaches the orchestrator as a message from another session, never from you,
and wakes it when it is waiting. There is no `/agents` command.

Open runs show in the panel below the status line, as in Claude Code's agent panel: a `main` row for
the orchestrator, then one row per run (name, role, model, working / idle / needs input, elapsed time,
last report). Idle runs past the first three are counted in one row (`2 idle agents`). A run that
failed stays 30 s (`x` dismisses it), and closing a run leaves `/tasks to see subagents` for 30 s.
Runs also show in `/tasks` with the closed runs of the session. ↓ on an empty prompt
moves into the panel; Enter on a run, there or in `/tasks`, switches your terminal to it, and ← on its
empty prompt switches back to the orchestrator (to agent view for a run opened from there). Only your keys switch the terminal. What you type in a
run is noted to the orchestrator without starting its turn.

The orchestrator's tools:
- `subagent_status`: each open run's status, whether it is working or idle, task and elapsed time.
- `subagent_message({ to, content })`: a message to a run by name or `sub_…` run ID. A run reads it as a
  message from another session; a closed run resumes with it.
- `subagent_stop`: ends a run's turn in progress, or every run's with `"all"`, as Esc does. The run stays open.
- `subagent_close`: ends a run's pi without asking it. Its session is kept.
- `subagent_models`: the models a run can use, with auth status and supported thinking levels.

Inside a run, `subagent_message` reaches `parent` (its orchestrator) or a sibling by name. Nothing
closes an idle run for you: the orchestrator is told to close a run once its work is done, and holds
at most 8 open runs. `x` in the panel or `/tasks` closes a run too. Every run of an orchestrator's
session closes when that session ends: quit, `/new`, `/resume` of another session, fork or reload, and
also when the orchestrator's pi is gone for good (not while it is a Silent pane).

A closed run can be resumed with its earlier context: a message from the orchestrator does it, and so
does Enter on it in `/tasks`, for you to type in. It keeps its name, run ID, role, model and thinking
level, and is checked like a launch: the orchestrator's current deny rules apply. Runs from before runs
were pis of their own resume the same way, from their saved session.

Custom roles are Markdown files in `~/.pi/agent/agents/` or a trusted project's `.pi/agents/`.
A trusted project definition overrides a user definition, which overrides a bundled role.
For example, `.pi/agents/api-review.md`:

```markdown
---
name: api-review
description: Review explicitly supplied API handler files for defects.
tools: read, grep, find, ls, bash
model: inherit
---
Review only the supplied targets. Do not edit files. Cite path:line evidence and report exactly which checks ran.
```

Reload after changing definitions. Only `name`, `description`, `tools`, `model`, and `thinkingLevel`
are supported; the obsolete `maxTurns` field is rejected with a remove-field diagnostic. The role becomes
the run's launch flags: `tools` its tool list (pi's defaults when omitted), `model` and `thinkingLevel` its
model, and the body its added instructions. A role's tool list is an orchestration choice, not a
security boundary. Explicit models use `provider/model`; virtual routers and model aliases are
unsupported. A run gets a fresh conversation, not the parent's history.

The parent can also pass an inline role instead of a name:
`{ "agent": { "name": "schema-check", "description": "…", "instructions": "…" }, "task": "…" }`,
with optional `tools`, `model`, and `thinkingLevel`. An inline role is validated like a saved
one, recorded with source `inline`, and never written to disk.

A call may also set `model` (`provider/model` or `inherit`) and `thinkingLevel` (`off` … `max` or
`inherit`). Each is chosen independently: the call's value, else the role's. With neither, an
inherited model keeps the parent's thinking level, and a chosen model gets pi's default for it.
`inherit` on the call picks the parent even when the role sets a value. An unknown model, missing
auth, a virtual router, or an explicitly requested thinking level the model does not support fails
before the run starts; nothing is substituted.

Each run has a name, unique among the open runs of the session: the call's `name`, or `<role>-<n>`.
A run's session, task, instructions and latest report live outside the repository under
`<getAgentDir()>/bluclawd/subagents/<parent-session>/<run>/`. Test results in a report are
agent-reported; always recheck citations before acting on findings.

A run's usage is counted in its own session. `/status` and the phone's status sheet show the total
of the orchestrator's runs apart from its own totals, from `background-usage-ledger.json` in the
same directory: each of a run's sessions counted once, however many reports repeat its total.
Unpriced usage is labelled unknown, not free; price-table estimates are not subscription invoices.

Coordination is the orchestrator's job. It should give each run its own files or area, name who owns a
shared file, and tell the others to ask that owner through `subagent_message` instead of editing it.
A run that hits a failing command, a denied action or an unexpected change should report it rather than
work around it.

**Evaluation.** `test/subagents-evaluation.test.ts` checks the grading of
`scripts/eval-subagents.ts`: a run is graded by the fixture's own tests and the final tree, never by what
the transcript claims, so a run with failing tests is incorrect however confident its report is, and a
helper written twice is a duplicate even when the tests pass.

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
`mcp__server__*`, `mcp__server__tool` or `Mcp(server:tool)` — the web rules apply
to bluclawd's own `websearch` and `webfetch` (each of a fetch's URLs is checked), and
bluclawd ships no MCP tools, so those rules apply to another pi package's; `dir/**` covers
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
bluclawd), **web search/fetch and MCP** (install a pi package for those; deny
rules still cover them). Also not ported: **PDF input** (would mean reimplementing four
provider wire formats behind `before_provider_request` — a shared-type change
in pi's own `packages/ai`, not reachable through the extension API at all).

### Sandbox

Deny rules match the text of a call, so `grep -r KEY .` or a script that opens `.env`
still reads it. Turn on the sandbox to have the operating system stop that: the model's
`bash` and `monitor` commands, and everything they start, then run inside Anthropic's
[sandbox runtime](https://github.com/anthropics/sandbox-runtime), the one bluclawd uses.
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
- Process lifetime: when a command ends (it exits, is stopped, times out, or its session ends),
  its descendants end too, detached or double-forked ones included. On Linux the PID namespace
  guarantees it. On macOS Seatbelt does not limit process lifetime, so a best-effort reaper
  ([#29](https://github.com/christophesamueldhp/bluclawd/issues/29)) follows each command's processes by
  parent unique id, which survives reparenting to launchd, and by a cookie in their environment,
  then stops and kills them all. It does not catch a descendant that scrubs its environment and
  whose parent lived and exited between two scans (10 ms apart), e.g. a very fast double-fork; it
  reads the parent unique id through private SPI (`proc_pidinfo` flavor 17), which a macOS update
  could change; and it is compiled when the sandbox starts, so without the Command Line Tools
  (`xcode-select --install`) commands run unreaped, and pi warns at session start. An escaped
  descendant keeps the sandbox's limits.

| Platform | Needs |
|---|---|
| macOS | Nothing (Seatbelt); the Command Line Tools for the process reaper |
| Linux, WSL2 | `bubblewrap`, `socat` and `ripgrep` (`apt install bubblewrap socat ripgrep`). On Ubuntu 24.04+, unprivileged user namespaces must be allowed by AppArmor: see [Anthropic's notes](https://code.claude.com/docs/en/sandboxing) |
| Windows | Not supported; run pi in WSL2 |
