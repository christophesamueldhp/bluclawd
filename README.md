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
daemon/         FleetView's session daemon
ext/            the feature layer
  _shared/      settings readers/writers, process runner, vendored pi internals
scripts/        probe-extensions.ts — headless report of what each extension registers
test/           self-contained — no monorepo, no fixtures pi doesn't publish
```

16 extensions: `permissions`, `statusline`, `memory`,
`checkpoints`, `subagents`, `web`, `mcp`, `sandbox`, `background-bash`,
`branding`, `diagnostics`, `fleet`, `help`, `plugin`, `shell`, `vibes`.

## What it adds

Claude Code's names and behaviours, on top of pi's own commands:

| Command | What it does |
|---|---|
| `/mode`, `/permissions` | permission modes and allow/ask/deny rules. `/mode` picks from a list; Alt+M cycles `ask → edits → auto` |
| `/sandbox` | OS-level sandbox for bash (`@anthropic-ai/sandbox-runtime`), configured with Claude Code's `sandbox` keys. No host is pre-allowed: the first connection to a host asks you (a yes holds for the session; `network.allowedDomains` pre-allows). Sandboxed commands run without a permission prompt (`autoAllowBashIfSandboxed`, default true; deny rules and content-scoped ask rules still apply). A denied command's result names the path or host in `<sandbox_violations>`; the model may retry with `dangerouslyDisableSandbox`, which goes through the normal permission flow labelled "(unsandboxed)" — `allowUnsandboxedCommands: false` ignores that parameter. `excludedCommands` (`Bash(...)` patterns, e.g. `docker *`) always run outside. `failIfUnavailable` (formerly `strict`) refuses to run bash at all when the sandbox was enabled but failed to start. Commands you type yourself (`!` and bash mode) run outside the sandbox, as in Claude Code. Everything else (`filesystem.allowRead`, `network.allowLocalBinding`, `credentials`, ...) passes straight through to the runtime; `allowAppleEvents` is honoured from user settings only |
| `/tasks` | background bash jobs (`run_in_background`, `bash_output`, `kill_bash`) and monitors. A job notifies the model once when it exits; the `monitor` tool turns each output line of a long-running command into an event that wakes the model (Claude Code's `Monitor`, minus the WebSocket source; stdout and stderr are both events because pi's shell backend merges them) |
| `/agents` | subagents via the `task` tool (single, parallel, chain; `run_in_background`, `resume`, `worktree: true`). The roster is in the system prompt, so the model delegates unprompted. Defs are Claude Code's markdown: `tools`, `disallowedTools`, `model` (`inherit`, `provider/id`, or a `subagents.models` alias), `permissionMode`, `maxTurns`, `skills`, `memory`, `background`, `isolation`, `effort`, `color`. Children get the parent's deny rules and protected paths, its sandbox, and — when it has a UI — its permission prompts, named per subagent. `/agents new\|edit\|delete <name>` manage user defs (editing a bundled one starts from its text); bundled: `explore`, `planner`, `code-reviewer`, `general-purpose` |
| `/mcp` | MCP servers from `mcp.json` / `.mcp.json`; project servers need `/mcp approve` (enable/disable of a project server is kept in your settings, never written into `.mcp.json`). Server instructions go into the system prompt, server prompts run as `/mcp__<server>__<prompt> args…`, `list_changed` refreshes tools live, and a result over 50KB is cut with the full text saved to a temp file. Resources: `mcp_list_resources` / `mcp_read_resource`, and `@server:uri` in a prompt attaches one. Claude Code's timeouts (per-server `timeout`, `MCP_TOOL_TIMEOUT` ≈28h default, idle `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` 30 min stdio / 5 min remote, `MCP_TIMEOUT` connect) and `${VAR}` / `${VAR:-default}` in `command`, `args`, `env`, `url`, `headers`; a remote server whose url or header would carry a model/cloud credential is refused |
| `webfetch`, `websearch` | Claude Code's `WebFetch`/`WebSearch`, extended; see [Web](#web). Rules: `WebFetch(domain:example.com)` (what "Always allow" persists), `WebSearch(<query glob>)`, checked per query in a batch |
| `/memory`, `# note` | persistent memory, injected into the system prompt. `/memory edit [scope]` and `/memory search <text>`; a bare `#` opens an editor for a multi-line note; `@name.md` lines pull in a sibling file |
| `/rewind` | file checkpoints per turn; restores the files, the conversation, or both |
| `/bash-mode`, `/stash` | bash mode (Ctrl+Shift+B or `/bash-mode`): the prompt drives a persistent shell, so `cd`, `export` and functions carry between commands; output shows below the editor instead of in the conversation, Escape leaves, Ctrl+C interrupts, Up/Down walk its commands. Alt+S stashes the prompt you are writing and brings it back into an empty editor; `/stash` inserts an older one |
| `/vibe` | themed working messages: `/vibe star trek` turns "Working..." into short in-theme lines. Off by default; uses the session's model (`/vibe model <provider/id>` picks another), or `/vibe generate <theme> [count]` + `/vibe mode file` for no calls at all |
| `/fleet` | session roster in the shape of Claude Code's `/resume` picker: title + `time · branch · N messages · path`, grouped by project path (ctrl+g: by Running / Saved instead, remembered) with status glyphs, type to search, ctrl+a current/all projects, enter opens, ctrl+t peeks, ctrl+n starts one; restarts a stale daemon by itself when it owns no running session |
| `/status`, `/context`, `/usage` | model, auth, safety, session, context window, spend, plan usage |
| `/plugin`, `/theme` | packages, theme |
| `/help` | all of the above, grouped |

The footer replicates a ccstatusline configuration (model, effort, context
slider, git owner/branch/changes, plan-usage sliders, token stats). The context slider turns yellow past 70% and red past 90%, follows a reply while it streams, and
shows an estimate (the counter reads `~N tokens`) right after a compaction. The git change
counts refresh as soon as a tool, a `!` command or a bash-mode command finishes. Plan usage
is provider-neutral: one line per source that has data (Claude subscription via
an Anthropic OAuth login, OpenCode Go via `OPENCODE_GO_WORKSPACE_ID` +
`OPENCODE_GO_AUTH_COOKIE`), compacted before truncation on narrow terminals.
The cost figure always names its billing: `(subscription)` when the amount is
what the tokens would have cost at API rates, `(per token)` when it is what the
session actually costs. The subscription side follows pi's OAuth-subscription
rule plus `kimi-coding` and `opencode-go`; add other subscription-billed
provider ids with `statusline.subscriptionProviders` in settings.json. `statusline.currency`
(`IDR`, `EUR`, `JPY`, ...) shows the cost figure in another currency, converted from USD at a
daily rate. `statusline.command`
runs an external script whose first stdout line joins the status line.

Bash mode, the stash, vibes, the footer's currency and context-color behaviour and the welcome
banner's sidebar are adapted from [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer)
(MIT, Nico Bailon).

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
- **`newSession()` takes neither a directory nor a model**, so FleetView's "New
  session" panel says which part of the choice it could not honour.

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
resolve to `auto` — so stored settings and scripts keep working. Subagent
children are evaluated as `auto` with the parent's deny rules only.

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
