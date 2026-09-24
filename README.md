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
shows up in the welcome banner and nowhere else; there is no rebrand.

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
package.json    the pi package manifest (pi.extensions, dependencies)
bin.mjs         convenience entry point for local runs
themes/         the bluclawd theme
daemon/         agent view's background-session daemon
ext/            the feature layer
  _shared/      settings readers/writers, process runner, vendored pi internals
scripts/        probe-extensions.ts — headless report of what each extension registers
test/           self-contained — no monorepo, no fixtures pi doesn't publish
```

16 extensions: `permissions`, `statusline`, `memory`,
`checkpoints`, `subagents`, `web`, `mcp`, `sandbox`, `background-bash`,
`branding`, `diagnostics`, `agent-view`, `help`, `plugin`, `shell`, `vibes`.

## What it adds

Claude Code's names and behaviours, on top of pi's own commands:

| Command | What it does |
|---|---|
| `/mode`, `/permissions` | permission modes and allow/ask/deny rules. `/mode` picks from a list; Alt+M cycles `ask → edits → auto` |
| `/sandbox` | OS-level sandbox for bash (`@anthropic-ai/sandbox-runtime`), configured with Claude Code's `sandbox` keys. `/sandbox` is a switch — on or off (`/sandbox on|off`, or pick from the menu) — saved to the project's `.pi/settings.json` (session-only in an untrusted project); on, the model's shell commands run confined and without a permission prompt, which is what makes it the safety net for agentic work. The finer keys below still apply when written in settings.json. Writes: the working directory and a per-session `$TMPDIR`; a linked worktree also gets the repository's shared `.git` (not its hooks or config). Protected inside those, whatever `allowWrite` says: the agent's config (`.pi/settings.json`, `mcp.json`, `hooks.json`, `extensions/`, `skills/`, `agents/`, ... — but not `.pi/worktrees/`, where subagents work), the agent dir, bare-repository files (`HEAD`, `objects`, `refs`, `config`), plus the runtime's own list (shell rc files, `.gitconfig`, `.mcp.json`, `.git/hooks`, `.git/config`, ...). Network: no host is pre-allowed; the first connection to a host asks — "Yes" holds for the session, "Yes, and don't ask again" saves a `WebFetch(domain:…)` allow rule. Permission rules feed the sandbox as in Claude Code: `Edit`/`Write` allow and deny → write lists, `Read` deny → `denyRead`, `WebFetch(domain:…)` → domain lists. Relative paths resolve against the project root in project settings and against the agent dir in user settings. Sandboxed commands run without a permission prompt (`autoAllowBashIfSandboxed`, default true; deny rules and content-scoped ask rules still apply). A denied command's result names the path or host in `<sandbox_violations>`; the model may retry with `dangerouslyDisableSandbox`, which goes through the normal permission flow labelled "(unsandboxed)" — `allowUnsandboxedCommands: false` ignores that parameter. `excludedCommands` (`Bash(...)` patterns, e.g. `docker *`) always run outside. `failIfUnavailable` (formerly `strict`) makes bluclawd exit with an error at startup when the sandbox was enabled but cannot start. Settings edits apply to the running session. Commands you type yourself (`!` and bash mode) run outside the sandbox, as in Claude Code. User settings only (ignored in a project, as in Claude Code): `allowAppleEvents`, `filesystem.disabled`, `network.strictAllowlist`, `network.tlsTerminate`, `ripgrep`, and credential `mask` entries, `allowPlaintextInject`, `awsPairs`, `sigv4`. Everything else (`credentials`, `filesystem.allowRead`, `network.allowLocalBinding`, `ignoreViolations`, ...) passes straight through to the runtime. Like Claude Code, no credential is blocked by default: a `Read(...)` deny rule (e.g. `Read(~/.ssh/**)`) blocks it for the read tool and, through the sandbox, for every bash subprocess too. Not available: per-command allowed domains in auto mode (needs Claude Code's classifier) |
| `/tasks` | background tasks dialog (alias `/bashes`): shells (`run_in_background`, Ctrl+B on the model's running bash, or a foreground command past its `timeout`), monitors and background subagents; Enter shows a task's output tail, `x` stops it. The footer pill counts the running shells and monitors (subagents get their own rows); ↓ from an empty prompt selects it and Enter opens the dialog. A shell writes its whole output to a file named in its start result and exit notification; `task_output` returns new output or waits for the exit (`block`), `task_stop` stops it. A job notifies the model once when it exits, and once more if it goes quiet for 45s on what reads as an interactive prompt (`(y/n)`, `Press Enter`, …); the `monitor` tool turns each stdout line of a long-running command, or each frame of a WebSocket (`ws`), into an event that wakes the model (Claude Code's `Monitor`; stderr goes to the output file) |
| `/agents` | subagents via the `task` tool — single, parallel, chain, saved workflows, nesting, forked context, background runs with `task_output`/`task_message`/`task_stop`/`task_wait`, schedules, acceptance gates, tool/token budgets, questions to you mid-run, external CLI runners. `/agents new\|edit\|delete <name>` manage user defs (the model can too, with `manage_agents`); `/agents show <id>` shows a child's transcript, `/agents stop <id>` stops a background run. See [Subagents](#subagents) |
| `/review-loop` | review/fix loop: parallel `code-reviewer` rounds, fixes by a `worker`, until clean or 3 rounds |
| `/mcp` | MCP servers from `mcp.json` / `.mcp.json`; project servers need `/mcp approve` (enable/disable of a project server is kept in your settings, never written into `.mcp.json`). Server instructions go into the system prompt, server prompts run as `/mcp__<server>__<prompt> args…`, `list_changed` refreshes tools live, and a result over 50KB is cut with the full text saved to a temp file. Resources: `mcp_list_resources` / `mcp_read_resource`, and `@server:uri` in a prompt attaches one; both prompt commands and `@server:` resources autocomplete in the editor (Tab after `@server:` lists them). A server can ask you for input (form elicitation) or ask your current model for a completion (sampling, confirmed per request, any provider). To confirm before chosen tools run, use an ask rule such as `Mcp(github:delete_*)`. Claude Code's timeouts (per-server `timeout`, `MCP_TOOL_TIMEOUT` ≈28h default, idle `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` 30 min stdio / 5 min remote, `MCP_TIMEOUT` connect) and `${VAR}` / `${VAR:-default}` in `command`, `args`, `env`, `url`, `headers`; a remote server whose url or header would carry a model/cloud credential is refused |
| `webfetch`, `websearch` | Claude Code's `WebFetch`/`WebSearch`, extended; see [Web](#web). Rules: `WebFetch(domain:example.com)` (what "don't ask again" persists), `WebSearch(<query glob>)`, checked per query in a batch |
| `/memory`, `# note` | persistent memory, injected into the system prompt. `/memory edit [scope]` and `/memory search <text>`; a bare `#` opens an editor for a multi-line note; `@name.md` lines pull in a sibling file |
| `/rewind` | file checkpoints per turn; restores the files, the conversation, or both |
| `/bash-mode`, `/stash` | bash mode (Ctrl+Shift+B or `/bash-mode`): the prompt drives a persistent shell, so `cd`, `export` and functions carry between commands; output shows below the editor instead of in the conversation, Escape leaves, Ctrl+C interrupts, Up/Down walk its commands. Alt+S stashes the prompt you are writing and brings it back into an empty editor; `/stash` inserts an older one |
| `←` twice on an empty prompt | agent view, as Claude Code's `claude agents`: background sessions in Needs input / Working / Completed bands (ctrl+s: by directory, remembered), one line each — `✻`/spinner/`∙` + name, what it is doing, age. Type a task + enter to start a background session (ctrl+enter: start it here), shift+enter / ctrl+j adds a line, ctrl+g writes it in `$EDITOR`, space peeks and replies (1-9 answers a pending question), enter/→ opens a session in this window (this one keeps running in the background), alt+1-9 opens the Nth session in the focused one's directory, ctrl+x stops then deletes, ctrl+t pins, ctrl+r renames, shift+↑↓ reorders, `s:<state>` filters, `/resume` brings a past session back, `/model` sets the model for new ones. The footer shows `← for agents` / `← N agents` / `← N done`, and `Press ← again to open agents` after the first press |
| `/status`, `/context`, `/usage` | model, auth, safety, session, context window, spend, plan usage |
| `/plugin`, `/theme` | packages, theme |
| `/help` | all of the above, grouped |

The status line itself comes from [pistatusline](https://github.com/christophesamueldhp/pistatusline)
(ccstatusline as a pi package); install it next to bluclawd. Under it, bluclawd shows Claude Code's
mode row — `⏵⏵ auto mode on (alt+m to cycle)`, then the background-task pill, then `← for agents` —
and one row per running subagent (agent, what it is doing, elapsed time, tool count; three at most,
then `+N more`). Without pistatusline, pi's own footer shows the same items on one line.

`/usage` names how the cost is billed: `(subscription)` when the amount is
what the tokens would have cost at API rates, `(per token)` when it is what the
session actually costs. The subscription side follows pi's OAuth-subscription
rule plus `kimi-coding` and `opencode-go`; add other subscription-billed
provider ids with `statusline.subscriptionProviders` in settings.json. `statusline.currency`
(`IDR`, `EUR`, `JPY`, ...) shows the cost in another currency, converted from USD at a
daily rate.

While the agent works, "Working..." becomes one of Claude Code's 187 spinner verbs
("Pondering...", "Clauding..."), a new one each turn, none repeated until all have shown.

Bash mode, the stash, the currency conversion and the welcome
banner's sidebar are adapted from [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer)
(MIT, Nico Bailon).

## Subagents

The `task` tool delegates to agents defined in markdown (Claude Code's format),
found bundled < `~/.pi/agent/agents` < `.pi/agents` in a trusted project. The
roster, saved workflows and this project's recent missions are in the system
prompt, so the model delegates unprompted. An untrusted project's agents and
workflows are not offered at all; trust the project to use them.

**Calling it.** `{agent, task}`; `tasks[]` in parallel; `chain[]` in sequence,
where `{previous}` is the prior step's output and a step may be `{parallel: [...]}`
(its outputs reach the next step together); `{workflow, input}` for a saved
workflow. Options: `run_in_background`, `resume: "<agent id>"`, `worktree: true`,
`fork: true` (the child starts from a copy of this conversation — compacted first
when it is over `subagents.forkCompactAbove` tokens), `gate: "npm test"` (must
pass after the child; a failure is sent back to it `subagents.gateRetries`
times, then the task fails), `outputSchema: {…}` (a JSON Schema: the child must
finish by calling `structured_output` with a matching value, which becomes its
output — the parent's result and the next chain step's `{previous}` are that JSON;
a child that ends in prose is reminded once — a turn `maxTurns` counts — then fails; no `$ref`), `mission: "<label>"` (groups runs so a later session can find and
resume them). `gate` and `outputSchema` also go on each `tasks[]` item, chain
step and workflow step.

**Background runs.** Ids are Claude Code's, `a` and 16 hex characters; a run with one child is known by that child's agent id. `task_output <id>` waits for the result (up to its
`timeout`; `block: false` shows progress instead), `task_message` steers a
running child without restarting it, `task_stop` stops it and returns what it had
(it can be resumed), and `task_wait` blocks until the given runs (or all) finish and
returns their results in place of the completion messages. For you: `/agents show <id>` prints a child's
transcript (its text, tool calls and results; every child of a parallel run),
`/agents stop <id>` stops a run and tells the model you did. `resume: "<id>"`
works for a run with one child; a parallel run's children are resumed by agent id. `task_schedule` starts a task or workflow later (`in: "10m"`)
or repeatedly (`every: "1h"`); schedules end with the session.

**Questions mid-run.** With a UI, children have `contact_supervisor`: a child that
reaches a decision nobody made asks it, the question appears in your session
(queued with permission prompts), and your answer goes back to the child. Esc lets
it decide on its own and say what it assumed. The parent's model cannot answer —
it is waiting on the `task` call — so you are the supervisor. Headless, the tool
is absent.

**Limits.** Per def or for every child via `subagents.*` settings: `maxTurns`,
`timeoutMs` (the whole run), `toolTimeoutMs` (one tool call; time a permission
prompt waits on you does not count), `maxTokens` (input + output + cache), and
`toolBudget: {soft, hard, block}` — at `soft` calls the child is told to wrap up,
past `hard` the `block` tools are refused (default: `read`, `grep`, `find`, `ls`,
so an edit is never cut off halfway; `"*"` blocks everything). A child stopped by
a limit returns what it had, marked partial and naming the limit. A cost cap is
left out on purpose: subscription providers report no cost, so it would never fire.

**Nesting.** Children get their own `task` tool down to `subagents.maxDepth`
(default 2: main → child → grandchild; 1 turns nesting off), with at most
`subagents.maxSpawns` children per top-level call (default 32). Nested children
run in the foreground, share the root's permission prompts and transcript
directory, and have no control tools.

**Definitions.** Frontmatter: `name`, `description`, `tools`, `disallowedTools`,
`model` (`inherit`, `provider/id`, or a `subagents.models` alias),
`permissionMode`, `maxTurns`, `timeoutMs`, `toolTimeoutMs`, `maxTokens`,
`toolBudget`, `skills`, `memory`, `background`, `fork: true` (start from this
conversation unless it is not saved; pi-subagents' `defaultContext: fork` also
works), `isolation: worktree` (removed afterwards unless the child changed or
committed something; quitting waits up to 10s for aborted runs to clean theirs up),
`effort`, `color`, `gate`, `outputSchema`, `mcpServers: [github, docs]` (the child
gets those servers' tools and instructions, borrowing this session's connections —
only connected servers, so a project server still needs `/mcp approve`; names only,
no inline server configs; a `deferTools` server's tools are all active in the
child), and `runner` — `runner:
{command: claude, args: [-p]}` runs that CLI instead of a pi child, with the
prompt on stdin and its stdout as the result (no tools, fork, resume,
steering, structured output or MCP). Bundled: `explore`, `planner`, `code-reviewer`, `general-purpose`,
`oracle` (a read-only second opinion from a copy of this conversation: what was
decided, where the plan drifts) and `worker` (implements an agreed plan from a copy
of this conversation, asks instead of deciding).
`/agents new|edit|delete <name>` edits user defs; `manage_agents` lets the model
list, read, create, update and delete them — every write asks you first, in every
mode, and a def may not declare a `permissionMode` above the session's.

**Workflows.** Markdown files with `name`, `description` and a `chain` in
frontmatter (`{input}` is the call's input), found bundled < `~/.pi/agent/workflows`
< `.pi/workflows` in a trusted project. Bundled: `parallel-review`,
`scout-and-plan`, `implement-and-review`. They are declarative on purpose: a
workflow *script* would need a JS sandbox, and node's `vm` is not a security
boundary — a script escaping it would bypass every permission rule.
`/review-loop [target]` covers the loop a chain cannot express: reviewers in
parallel, the parent merges and triages (P0/P1/P2), a `worker` fixes what is worth
fixing, repeat until clean or 3 rounds. `oracle`, `worker` and `/review-loop` are
adapted from [pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT, Nico Bailon).

**Safety.** Children run under the parent's rules, protected paths and sandbox;
when the parent has a UI their permission prompts appear there, named per
subagent. Gate commands and external runners are judged as bash by the parent's
rules and mode and run in the sandbox. A resume is judged by the agent the
resumed child actually runs. Child output that imitates the harness (tags,
`Human:` lines, bluclawd's own `[agent id: …]` notes) is escaped before the
parent sees it. Finished children are recorded in `~/.pi/agent/subagents/runs.jsonl`,
which is also how a child is resumed from another session.

## Web

**webfetch** returns a page's main content as Markdown (Readability; the whole page
when extraction keeps too little), a PDF's text, or an image for models that read
images. Page text is marked untrusted. It blocks private addresses (checked at
connect time) and reports a redirect to another host instead of following it.
Special URLs:
- **github.com**: through your `gh`/`git` — a repository is shallow-cloned under
  the temp dir (tree + README, then read/grep the clone; not while the bash sandbox
  is on), a `/blob/` file comes from the API, issues and PRs as ordered Markdown.
- **YouTube**: title, channel, description and the caption transcript with
  timestamps. No video model involved; YouTube sometimes withholds captions from
  anonymous clients, and the output says so.
- **Next.js pages** that render client-side are read from their flight payload.

Pages over 2000 lines / 50KB return their start plus a temp file with all of it.
Every page and search result is kept for the session under an id (`f1`, `s2`):
`get_search_content` pages through or searches it, `source_check` judges claims
against it (supported / contradicted / unclear / missing-evidence, with a quote
verified to be in the source), and `/web` browses it. `format: "raw"` skips
conversion.

**websearch** works with no key (Exa's hosted endpoint) and takes
`allowed_domains`/`blocked_domains`, `recency` (`day`…`year`) and `queries` (up
to 10 searches in one call). Providers: `exa`, `brave`, `tavily`, `jina`,
`perplexity`, `kagi`, `serper` (keys from `EXA_API_KEY`, `BRAVE_API_KEY`, …),
`searxng` (`websearch.searxngUrl`), `duckduckgo` (keyless). Settings:

```json
"websearch": {
  "routing": ["brave", "searxng", "exa"],
  "fallbackOn": ["transient", "quota", "network"],
  "apiKeyEnvs": { "serper": "MY_SERPER_KEY" },
  "searxngUrl": "https://searx.example.org",
  "keyless": true
},
"webfetch": {
  "timeoutSeconds": 60,
  "allowRanges": ["198.18.0.0/15"],
  "hosts": { "intranet.example.com": { "headersEnv": { "Cookie": "INTRANET_COOKIE" } } },
  "fallbacks": { "remote": true }
}
```

`routing` is tried in order: a provider without its key is skipped, and a failure
of a kind in `fallbackOn` moves on. `allowRanges`, `hosts` and `fallbacks` are
read from your user settings only, never a project's: they open private
addresses, attach your secrets, or send URLs to a third party. `hosts` headers are
sent to that exact host only and those pages are never cached. With
`fallbacks.remote`, a page that is blocked (403/429/503) or needs JavaScript is
read by Firecrawl (`FIRECRAWL_API_KEY`) or Jina Reader, and the output says so.

## Updating

```bash
npm update    # bump the @earendil-works/pi-* peer/dev dependency versions
npm test      # confirm nothing broke against the new pi
```

There is no upstream merge here — this repo owns no pi source to merge into.
The dependency this actually has on pi's internals: `ext/_shared/` vendors a
handful of small pi functions/tables that pi does not export publicly
(`stripAnsi`, `openBrowser`, path getters, the built-in slash-command list, a
security-relevant path resolver, MCP auth-header resolution). Each is documented in its own file with what drifts
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
  Commands here have their canonical name only.
- **An extension cannot rebind a pi keybinding.** Permission-mode cycling is
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
  session per window), so a turn in progress is cut off rather than carried over. `←`
  always takes two presses (Claude Code opens on one when the prompt was already
  empty), and `tab` does not browse subagents.

## Permission modes

Claude Code's three modes. Rules decide first in every one of them: `deny`
blocks, `ask` prompts, `allow` allows, with precedence deny > ask > allow.
Reads and read-only bash never prompt. The mode only says what happens to a
call no rule names:

| Mode | A call no rule names |
|---|---|
| `ask` | every edit/write and every non-read-only command prompts |
| `edits` | edit/write run; everything else prompts |
| `auto` | everything runs |

`auto` is the bypass mode with the rules still on: an empty rule set makes it
approve everything, and `deny: ["Bash(rm -rf **)"]` is how you put a guard
back. Claude Code's names (`default`, `acceptEdits`, `bypass`) and the older
`always` are still accepted anywhere a mode is named — the bypass spellings
resolve to `auto` — so stored settings and scripts keep working. A subagent
child keeps a parent's `edits` or `auto` mode; under `ask` it runs in the mode
its def declares (`ask` if none). With a UI its prompts reach you; headless it
gets the parent's deny rules only, and whatever would prompt is blocked. `task_output`, `task_message`, `task_stop`, `task_wait`
and `task_schedule list|cancel` never prompt — they only touch this session's own
runs and shells — and `manage_agents` asks for every write itself, in every mode.

A prompt has Claude Code's rows: **Yes**, a row for "from now on", and **No**. A
digit picks a row, Esc is No, and Tab on No types a note the model receives. Where
pi cannot draw that dialog (RPC mode, agent view's background sessions) the same rows
come as a plain list, with **No, and tell the model what to do differently** as its
own row.
The middle row depends on the call: a command offers `Yes, and don't ask again for
npm test commands in <project>`, saved as `Bash(npm test:*)` — the prefix alone or
with arguments, never `npm testx` — in the project's settings (one rule per command
of a compound line; interpreters, wrappers and `$(…)` get the exact command
instead); an edit no rule names offers `Yes, and switch to edits mode for this
session`; a credential read is allowed for the session; a protected write gets
no middle row. In an untrusted project "don't ask again" lasts the session.

A trusted session starts in `auto`; set `permissions.defaultMode` in global
settings to start in `ask` or `edits` instead.

**Project trust pins the mode.** In a project pi has not been told to trust,
every mode above `ask` is refused — from settings, CLI flags, `/mode` and
Alt+M alike. pi already withholds an untrusted repository's settings,
extensions and skills; a mode that auto-approves edits or skips prompts would
hand back what that gate withholds. `/trust` is the way out, and the refusal
message says so.

Deliberately not ported: **PDF input** (would mean reimplementing four
provider wire formats behind `before_provider_request` — a shared-type change
in pi's own `packages/ai`, not reachable through the extension API at all).
