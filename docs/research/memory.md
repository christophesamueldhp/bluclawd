# Memory: how Claude Code does it, and what pi offers to build it

Superseded in part by ADR-0006: runs are now pi sessions of their own, not in-process SDK sessions.

Researched 2026-11-04. Claude Code facts come from the official docs at code.claude.com (fetched that day). pi facts come from the installed `@earendil-works/pi-coding-agent` **1.0.4** (`node_modules/@earendil-works/pi-coding-agent/package.json`). Its `dist/` line numbers are compiled output and will drift on upgrade.

Every claim is labelled with one of:
- **Doc**: stated in an official doc, with the URL.
- **Source**: read in pi's code, with file and line.
- **Observed**: seen in one local install (`~/.claude/projects/<project>/memory/`) and not documented.
- **Inference**: my reading. Not stated anywhere.

Abbreviations: `MEM` = https://code.claude.com/docs/en/memory, `PI` = `node_modules/@earendil-works/pi-coding-agent`.

---

## 1. Claude Code: two systems

| | CLAUDE.md files | Auto memory |
|---|---|---|
| Written by | the user | Claude |
| Holds | instructions and rules | learnings and patterns |
| Scope | project, user, or org | per repository, shared across worktrees |
| Loaded | every session | every session (first 200 lines or 25KB of `MEMORY.md`) |

**Doc**: [MEM#claude-md-vs-auto-memory](https://code.claude.com/docs/en/memory#claude-md-vs-auto-memory). The same page says both are "context, not enforced configuration", and that hard blocks belong in a PreToolUse hook instead.

## 2. The CLAUDE.md hierarchy

### Locations and load order (**Doc**, [MEM#choose-where-to-put-claude-md-files](https://code.claude.com/docs/en/memory#choose-where-to-put-claude-md-files))

Load order runs from broadest to most specific, so later files appear later in context:

1. **Managed policy**: `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS), `/etc/claude-code/CLAUDE.md` (Linux/WSL), `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows). It can also be set inline with the `claudeMd` key in managed settings ([MEM#deploy-organization-wide-claude-md](https://code.claude.com/docs/en/memory#deploy-organization-wide-claude-md)). `claudeMdExcludes` cannot exclude it.
2. **User**: `~/.claude/CLAUDE.md`, plus `~/.claude/rules/*.md`. User rules load before project rules ([MEM#user-level-rules](https://code.claude.com/docs/en/memory#user-level-rules)).
3. **Project**: `./CLAUDE.md` or `./.claude/CLAUDE.md`, plus `.claude/rules/**/*.md`. Rules without `paths` load at launch with the same priority as `.claude/CLAUDE.md` ([MEM#organize-rules-with-claude/rules/](https://code.claude.com/docs/en/memory#organize-rules-with-claude/rules/)).
4. **Local**: `./CLAUDE.local.md`. It is personal and meant to be gitignored, and it is appended after `CLAUDE.md` in the same directory.

### Directory walk (**Doc**, [MEM#how-claude-md-files-load](https://code.claude.com/docs/en/memory#how-claude-md-files-load))
- At launch, Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from the cwd and **every ancestor**. Files are **concatenated, not overridden**, ordered from the filesystem root down to the cwd.
- A `CLAUDE.md` in a subdirectory loads **on demand**, the first time Claude reads, writes, or edits a file in that subdirectory. A `cat` or `head` through Bash counts as a read.
- Block-level HTML comments are stripped before the content is injected.
- With `--add-dir`, the added directory's memory files load only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set ([MEM#load-from-additional-directories](https://code.claude.com/docs/en/memory#load-from-additional-directories)).
- Path-scoped rules use `paths:` glob frontmatter, the only rule field Claude Code reads. They load when Read, Write, or Edit touches a matching file ([MEM#path-specific-rules](https://code.claude.com/docs/en/memory#path-specific-rules)).

### Imports (**Doc**, [MEM#import-additional-files](https://code.claude.com/docs/en/memory#import-additional-files))
- The syntax is `@path/to/file`. Relative paths resolve from the **importing file**. Absolute paths and `~` paths work.
- Imports can be **recursive, up to 4 hops**. Imports inside code spans or fenced blocks are skipped. A path with spaces needs `\ ` escapes.
- Imports **do not reduce context cost**, because imported files load together with the file that imports them.
- An import that resolves outside the working directory, inside a project-level file, needs a one-time approval dialog. User-scope files are trusted without the dialog.

### AGENTS.md (**Doc**, [MEM#agents-md](https://code.claude.com/docs/en/memory#agents-md))
- By default (`claude-md-or-agents-md`), Claude reads `AGENTS.md` / `.claude/AGENTS.md` only when there is no `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` in the cwd or any ancestor. `~/.claude/CLAUDE.md` and the managed file do not count for this check.
- The `/config` **Project instructions** setting can be `claude-md-or-agents-md`, `claude-md-and-agents-md`, `claude-md`, or `managed-only` ([MEM#choose-which-instruction-files-load](https://code.claude.com/docs/en/memory#choose-which-instruction-files-load)). In a settings file it lives at `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles`. Requires v2.1.277 or later.
- `AGENTS.local.md`, `AGENTS.override.md`, and `.agents/` are **not** read.

### Size and delivery
- **Doc**: the recommended size is under 200 lines per CLAUDE.md. A file over **4 MiB** is skipped entirely. Otherwise "Claude gets the whole of each CLAUDE.md file that loads at launch" ([MEM#how-it-works](https://code.claude.com/docs/en/memory#how-it-works), [MEM#my-claudemd-is-too-large](https://code.claude.com/docs/en/memory#my-claude-md-is-too-large)).
- **Doc**: files that load on demand (subdirectory CLAUDE.md, rules files) are truncated past **40,000 characters** with a 200K context window. With a 1M window the cap is 200,000 characters on Opus/Sonnet 4.6 and 150,000 on later models ([MEM#claude-ignores-the-end-of-my-subdirectory-claude-md](https://code.claude.com/docs/en/memory#claude-ignores-the-end-of-my-subdirectory-claude-md)).
- **Doc**: "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself" ([MEM#claude-isnt-following-my-claudemd](https://code.claude.com/docs/en/memory#claude-isnt-following-my-claude-md)). For system-prompt-level text, the docs point to `--append-system-prompt`.
- **Doc**: after compaction, the project-root CLAUDE.md, unscoped rules, and **auto memory** are "re-injected from disk". Nested CLAUDE.md and path-scoped rules reload on demand ([context-window#what-survives-compaction](https://code.claude.com/docs/en/context-window#what-survives-compaction)).

## 3. Auto memory

### What is saved (**Doc**, [MEM#auto-memory](https://code.claude.com/docs/en/memory#auto-memory))
Claude saves one note per memory and records a `type` field in the file's frontmatter:
- `user`: the user's role, expertise, and working preferences.
- `feedback`: corrections the user gives Claude, and approaches the user confirms.
- `project`: ongoing work, deadlines, and decisions that Claude can't derive from the code or git history.
- `reference`: where to find information outside the project, such as an issue tracker or dashboard.

Claude **skips** anything it can derive from the codebase (architecture, file paths, debugging fixes) and anything the CLAUDE.md files already say. "Claude doesn't save something every session. It decides what's worth remembering based on whether the information would be useful in a future conversation."

When the user says "remember X", Claude saves it to auto memory. "Add this to CLAUDE.md" goes to CLAUDE.md instead ([MEM#view-and-edit-with-/memory](https://code.claude.com/docs/en/memory#view-and-edit-with-%2Fmemory)).

### Save, update, and delete decisions: mostly undocumented
- **Doc**: beyond the criteria above, the docs describe no decision procedure. The only documented push toward updating or deleting is the index-size feedback: near a limit, Claude Code "reminds Claude to shorten it: keep one line per entry, move detail into topic files, and merge or drop stale entries". Over a limit, the write succeeds but returns an error telling Claude to rewrite the index ([MEM#how-it-works](https://code.claude.com/docs/en/memory#how-it-works), [errors#memory-index-is-over-its-read-limit](https://code.claude.com/docs/en/errors#memory-index-is-over-its-read-limit)). The error text quoted there is "Rewrite it to under 140 lines now: keep one line per entry, move detail into topic files, and merge or drop stale entries."
- **Doc** (from the subagent page, which describes the same mechanism): with memory enabled, "the subagent's system prompt includes instructions for reading and writing to the memory directory", and Read, Write, and Edit are auto-enabled ([sub-agents#enable-persistent-memory](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory)). Main-session memory also uses "its standard file tools" ([MEM#how-it-works](https://code.claude.com/docs/en/memory#how-it-works)).
- **Inference**: memory is **prompt instructions plus ordinary file tools**, not a dedicated memory tool. The exact prompt text that decides what to save is not public.

### Storage (**Doc**, [MEM#storage-location](https://code.claude.com/docs/en/memory#storage-location))
- The default directory is `~/.claude/projects/<project>/memory/`. `<project>` is derived from the **git repository**, so every worktree and subdirectory of a repo shares one directory. Outside git, the project root is used.
- The directory holds `MEMORY.md` (the index, "one line per memory, loaded into every session") and **one topic file per memory**, for example `user_role.md` or `feedback_testing.md`.
- Memory is machine-local and not synced. It is excluded from the `cleanupPeriodDays` transcript sweep.
- `autoMemoryDirectory` overrides the location. It must be absolute or `~/`-prefixed. From project or local settings it is honoured only under workspace trust ([settings-reference#automemorydirectory](https://code.claude.com/docs/en/settings-reference#automemorydirectory)).
- On every memory write that starts with YAML frontmatter, Claude Code writes the write time into a `modified` frontmatter field as ISO 8601.

### What is loaded, and the size limits (**Doc**, [MEM#how-it-works](https://code.claude.com/docs/en/memory#how-it-works))
- At the start of every conversation, Claude Code loads **the first 200 lines or the first 25KB of `MEMORY.md`, whichever comes first**. Content past that is not loaded.
- Frontmatter and block HTML comments are stripped before the index is measured, as of v2.1.211 ([errors#memory-index-is-over-its-read-limit](https://code.claude.com/docs/en/errors#memory-index-is-over-its-read-limit)).
- Topic files are **not** loaded at startup. Claude reads them on demand with its file tools.
- The main session's auto memory is **not** loaded into subagents, except a fork. A subagent can have its own memory through the `memory: user|project|local` frontmatter field, stored at `~/.claude/agent-memory/<agent>/`, `.claude/agent-memory/<agent>/`, or `.claude/agent-memory-local/<agent>/` ([sub-agents#enable-persistent-memory](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory)).
- The UI reports activity as "Saved N memories" / "Recalled N memories".

### File format: documented vs observed
- **Doc**: only the `type` field (one of four values) and the `modified` field are documented. The index is described as "one line per memory".
- **Observed** (one install, structure only):
  - **Index line**: `- [Title](file.md) — one-line hook`.
  - **Topic filename**: a kebab-case slug of the fact, not the `type_topic.md` pattern from the docs example.
  - **Frontmatter**:
    ```yaml
    ---
    name: <slug, same as filename>
    description: <one sentence>
    metadata:
      node_type: memory
      type: project | feedback | ...
      originSessionId: <session uuid>
      modified: <ISO 8601>
    ---
    ```
    Here `type` sits under `metadata`, not at the top level.
  - **Body**: a statement of the fact, then a `**Why:**` line and a `**How to apply:**` line (sometimes a bullet list).
- **Observed, and in tension with the docs**: in this very research session, which ran as a *subagent*, the project's `MEMORY.md` contents arrived inside a `<system-reminder>` in the first user turn, next to the CLAUDE.md/AGENTS.md contents. The docs say main-session auto memory isn't loaded into subagents, and they don't say where main-session `MEMORY.md` is placed: system prompt or user message. Left unresolved here.

### Turning it off, and the /memory command
- **Doc**: auto memory is on by default in local sessions. It can be turned off in three ways ([MEM#enable-or-disable-auto-memory](https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory), [settings-reference#automemoryenabled](https://code.claude.com/docs/en/settings-reference#automemoryenabled), [env-vars](https://code.claude.com/docs/en/env-vars)):
  - `autoMemoryEnabled: false` in any settings file, including per project.
  - The `/memory` toggle, which writes `autoMemoryEnabled` to `~/.claude/settings.json`.
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. `=0` forces memory on, even over `--bare` or `autoMemoryEnabled: false`. When disabled, Claude neither creates nor loads memory files.
- **Doc**: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` blocks every CLAUDE.md file *and* auto memory ([env-vars](https://code.claude.com/docs/en/env-vars)).
- **Doc**: `/memory` lists CLAUDE.md, CLAUDE.local.md, and the other memory locations. Files that don't exist yet are listed too, and selecting one creates it. `/memory` also toggles auto memory and opens the memory folder; files open in `$EDITOR` ([MEM#view-and-edit-with-/memory](https://code.claude.com/docs/en/memory#view-and-edit-with-%2Fmemory), [commands](https://code.claude.com/docs/en/commands)).
- **Doc**: `/context` shows which memory files loaded ([context-window](https://code.claude.com/docs/en/context-window)). The `InstructionsLoaded` hook logs which files loaded and why ([MEM#claude-isnt-following-my-claudemd](https://code.claude.com/docs/en/memory#claude-isnt-following-my-claude-md)).

---

## 4. What pi already loads as context

### Context files
- **Doc**: pi loads context files from the agent dir (`~/.pi/agent`, overridable with `PI_CODING_AGENT_DIR`), then from the cwd and its ancestors. Context-file loading does not require project trust (`PI/docs/configuration.md:41-47`). The `-nc` / `--no-context-files` flag turns it off (`PI/docs/cli.md:214-215`). Context files "load regardless of project trust" (`PI/docs/security.md:57`).
- **Source**: pi takes **one file per directory**: the first one that exists in the order `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. The file is read raw (`PI/dist/core/resource-loader.js:115-135`).
- **Source**: the agent-dir file comes first, then the ancestors from root down to cwd, de-duplicated. A nested linked worktree's copy shadows the main repo's copy (`resource-loader.js:136-192`).
- **Source**: the files are rendered into a `project_context` section as `<project_instructions path="...">...</project_instructions>` blocks, inside the **system prompt** (`PI/dist/core/system-prompt.js:25-30, 99-100`).
- **Source**: an SDK host can replace the discovered list with `agentsFilesOverride` (`resource-loader.js:461-470`).

### System prompt files and flags
- **Doc + Source**: `SYSTEM.md` replaces the prompt and `APPEND_SYSTEM.md` appends to it. For each, a trusted project `.pi/` file wins over the agent-dir file, and the two are not combined (`PI/docs/configuration.md:19-20, 32-39`; `resource-loader.js:940-961`).
- **Doc + Source**: `--system-prompt` and `--append-system-prompt <text|path>` (repeatable) take precedence over the discovered files (`PI/docs/cli.md:224-234`; `resource-loader.js:471-490`).
- **Source**: the appended text becomes the `addendum` section (`system-prompt.js:97-98`).

### Prompt structure and persistence
- **Source**: the prompt is a set of named sections: `preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`, plus any custom sections. Every section except `preamble` is wrapped as `<name>…</name>` (`system-prompt.js:68-121`).
- **Doc + Source**: sections are **persisted in the session transcript** as system messages. A later change is appended as a patch of only the sections that differ, and `null` removes a section (`system-prompt.js:140-151`; `PI/docs/session-format.md:80-84`; `PI/docs/message-types.md:108`).
- **Doc**: at compaction, the replayed sections become the leading system message of the compacted context (`PI/docs/session-format.md:134`).

### Contrast with Claude Code

| | Claude Code | pi 1.0.4 |
|---|---|---|
| Files per directory | `CLAUDE.md` **and** `CLAUDE.local.md` (+ `.claude/CLAUDE.md`), concatenated | **one**: first match of `AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD` |
| `AGENTS.md` vs `CLAUDE.md` | `AGENTS.md` only when no `CLAUDE.md` exists (default) | `AGENTS.md` wins over `CLAUDE.md` in the same directory |
| `@path` imports | yes, recursive, 4 hops | **no** (raw read, `resource-loader.js:124-127`) |
| `.local.md` variant | `CLAUDE.local.md` | none |
| Subdirectory files on demand | yes | no (cwd and ancestors only) |
| Rules dir / `paths:` scoping | `.claude/rules/` | none built in (an example extension exists, see §5) |
| Size caps | 4 MiB skip; on-demand truncation | none found in the loader |
| Where it lands | user message after the system prompt | inside the system prompt (`project_context`) |
| Auto memory | built in | **none**. No memory feature in pi's docs or source. |

## 5. pi extension hooks that could implement memory

### Injection: `before_agent_start`
- **Source**: `before_agent_start` fires once per user prompt, after the prompt is submitted and before the agent loop starts. It is **not** fired per model request (`PI/dist/core/extensions/types.d.ts:701-711`; `PI/dist/core/agent-session.js:1584-1630`).
- **Source**: the event carries `prompt`, `images`, the rendered `systemPrompt`, and a **mutable** `systemPromptOptions`. Later handlers see earlier handlers' changes. After the handlers run, pi diffs the result against the transcript's current sections and unshifts a patch message (`agent-session.js:1299-1305, 1622-1628`).

Ways to inject, in the order pi's docs prefer them (`PI/docs/extensions.md:103`):

1. **A custom section**, e.g. `event.systemPromptOptions.sections.memory = indexText`. Section names must match `/^[a-z][a-z0-9_-]*$/` and cannot be `preamble` (`system-prompt.js:7, 71-75, 111-114`). Pi's reference example of this pattern is `PI/examples/extensions/prompt-customizer.ts:40-48`. The section is persisted as a transcript diff, so an unchanged index costs nothing on later prompts. **Inference**: because sections are replayed into the compacted head, this route survives compaction without a re-inject hook.
2. **A pushed context file**: `event.systemPromptOptions.contextFiles.push({ path, content })`. The field is part of the mutable options type (`PI/dist/core/system-prompt.d.ts:45`), and the file would render as another `<project_instructions>` block. **Inference**: no example does this.
3. **A custom message for this turn**: return `{ message: { customType, content, display } }` and it is added after the user message (`types.d.ts:1090-1094`; `agent-session.js:1612-1621`). This is the closest analogue to Claude Code's documented "user message after the system prompt" delivery. **Inference**: as conversation content, it gets summarized at compaction.
4. **A whole-prompt replacement**: return `{ systemPrompt }`. The docs discourage this because it bypasses section diffs. `PI/examples/extensions/claude-rules.ts:64-85` still does it, to list `.claude/rules/` files.

### Hooks that don't fit
- **Source**: `context` fires before each LLM call, but it sees messages *without* the system messages. pi restores prompt state afterwards, so it can't carry a prompt-level memory (`types.d.ts:655-663`; `PI/docs/extensions.md:115`). `context_with_system` can, but it then owns the whole transcript.
- **Source**: `resources_discover` fires after `session_start` with reason `startup` or `reload`. It can return **only** `skillPaths`, `promptPaths`, and `themePaths`, which are fed to `extendResources` and trigger `_rebuildSystemPrompt` (`types.d.ts:531-542`; `agent-session.js:2618-2632`; `resource-loader.js:319-343`). It **cannot add context files or prompt text**. At most it could expose memory as a skill: a description in the prompt, with the body read on demand. **Inference**: that maps loosely onto "index loaded, topic files on demand", but skills are meant for procedures, not facts.

### Write path, `/memory`, and lifecycle
- **Source**: `pi.registerTool()` can add a model-callable tool such as a hypothetical `remember`/`forget` (`types.d.ts:1194`). Its `promptSnippet` and `promptGuidelines` feed the `tools` and `rules` sections (`types.d.ts:449-451`). The alternative is Claude Code's approach: prompt instructions plus the built-in `read`/`write`/`edit` tools.
- **Source**: `pi.registerCommand()` can implement `/memory` (`types.d.ts:1196`). Command handlers get `ExtensionCommandContext`, with reload and other session-control operations (`PI/docs/extensions.md:214-215`).
- **Source**: `session_start` can load the index once, and `session_shutdown` can clean up (`types.d.ts:1154`; `PI/docs/extensions.md:56-60`). `agent_end`, `turn_end`, and `agent_before_settle` can also observe the session (`types.d.ts:1174-1180`). **Inference**: a "reflect and save at the end" pass would need its own model call (`ctx.modelRegistry.streamSimple()`, `PI/docs/extensions.md:212`) or a continuation, because no event writes memory by itself.
- **Doc**: `pi.appendEntry()` holds durable per-session data that the model never sees. Data that outlives one session needs external storage, such as a memory directory (`PI/docs/extensions.md:224-231`).

## 6. Overlaps in bluclawd

- **No memory feature exists.** `ext/` has no memory or remember code, and a search of GitHub issues for "memory" turned up no related issue.
- **`before_agent_start` is already used** by `ext/prompt-assist/index.ts:297-300` (session naming) and `ext/vibes/index.ts:12-14` (spinner text). Neither one touches the prompt. Handlers run in the load order of `package.json`'s `pi.extensions` (see `ext/index.ts:1-17`), so a memory extension would compose with them.
- **Subagents already shape child context.** `ext/subagents/runner.ts:333-351` builds a `DefaultResourceLoader` that sets `noContextFiles` for untrusted projects. In that case `agentsFilesOverride` keeps only the agent-dir context file, and `appendSystemPrompt` carries the child's instructions. A memory extension needs the same two decisions: whether children inherit memory (Claude Code says no, except forks), and whether project-scoped memory is trust-gated.
- **The sandbox limits shell writes.** `ext/sandbox/config.ts:129` sets `allowWrite` to `[cwd, tmp, ...settings.allowWrite]`, and it applies to shell commands (`ext/sandbox/index.ts:1-9`). A memory directory under `~/.pi/agent/` or `~/.claude/` is therefore not writable from sandboxed `bash` unless it is added to `sandbox.filesystem.allowWrite`. **Inference**: pi's `write`/`edit` tools don't run through the sandbox, so file-tool writes would still work.
- **Permissions deny rules apply.** `ext/permissions/index.ts:1-9` blocks tool calls that match `permissions.deny`. A rule covering the memory path would block memory writes.
- **`resources_discover` timing.** `ext/branding/index.ts:4-7` records that `resources_discover` runs too late for startup theme resolution, which confirms it fires after session start.
- **Claude Code's directory can be reused.** It is per-repository, plain markdown, and already populated for this repo. **Inference**: a pi memory extension could read `~/.claude/projects/<slug>/memory/MEMORY.md` directly to share memory with Claude Code, or keep its own directory under the agent dir. The `<slug>` derivation, the cwd path with `/` replaced by `-` as in `-Users-…-bluclawd`, is **Observed**, not documented.
