# Skills referenced in a prompt: Claude Code vs pi

Research date: 2026-11-04. Versions read: `@earendil-works/pi-coding-agent` 1.0.4 and `@earendil-works/pi-tui` 1.0.4 (the dist line numbers below hold only for these versions). Claude Code: the docs at code.claude.com as served on that date.

Each claim is marked **[doc]** (a primary source says it, cited), **[code]** (read in source, file:line cited), or **[inference]** (my reading, not stated anywhere).

## TL;DR

- Claude Code runs a skill only when its `/name` **starts** the message. Up to six skills can be stacked at the start of one terminal message. A `/name` later in the message runs nothing: it gives Claude permission to use that skill in its reply.
- The Claude Code `/` menu completes `/name` mid-prompt too. Plugin skills are namespaced `plugin:skill`, and typing the bare skill name also finds them. The only per-entry source labels the docs describe are the claude.ai marking for synced skills and `(MCP)` for MCP prompts. The docs describe no `(user)`/`(project)` label.
- Pi expands a skill only when the whole prompt starts with `/skill:` (one skill, with the rest of the line as arguments). Its slash autocomplete opens only on the editor's first line, at the start. Each skill carries `sourceInfo {scope, source, origin, baseDir}`, which the menu shows as a description prefix: `[u]`, `[p]` or `[t]`, or `[<u|p|t>:npm:…]` / `[<u|p|t>:git:…]` for packages.
- Extension hooks: `input` is the only hook that can rewrite prompt text, and it runs **before** skill expansion. `before_agent_start` sees the expanded text but cannot change it. `ui.addAutocompleteProvider` wraps the completer, but pi-tui refuses `/` as a trigger character.
- bluclawd's prompt-assist does **not** list skills. It produces ghost-text suggestions and session titles, and it suppresses suggestions on `/` drafts. bluclawd lists skills in `/help` and in the remote pane command list, and both drop source information.

---

## 1. Claude Code

### 1.1 Where a skill name can appear in a prompt

- **[doc]** "To run a skill directly, put its name at the start of your message. After plain text, the name gives Claude permission to run the skill but doesn't run it." The table on that page: `/deploy staging` at the start means "Claude Code runs the skill directly". `go ahead and /deploy to staging` ("after plain text, as a separate word with no punctuation attached") means "Nothing runs directly. The name counts as your permission for that message: Claude can run the skill while it responds, and judges from your wording whether you asked it to." "To write about the skill without permitting a run, leave off the slash." See https://code.claude.com/docs/en/skills (section "Where you write the skill's name").
- **[doc]** "A command is only recognized at the start of your message. Text that follows the command name becomes its arguments." See https://code.claude.com/docs/en/commands.
- **[doc]** The interactive-mode shortcut table lists "`/` at start: Command or skill". See https://code.claude.com/docs/en/interactive-mode (section "Quick commands").
- **[inference]** With a mid-prompt name, Claude itself decides to load the skill (presumably through its Skill tool) during the turn. The harness does not expand it textually. The docs say only that Claude "can run the skill while it responds". They do not describe the mechanism.

### 1.2 Several skills in one prompt

- **[doc]** "When you type at the Claude Code prompt in your terminal, you can stack several skills at the start of one message. Through the Agent SDK or `claude -p`, Claude Code loads only the first skill, with the rest of the line as its arguments. At the terminal prompt, typing `/write-tests /fix-issue 123` loads both skills and passes the trailing text `123` as `$ARGUMENTS` to each of them." See https://code.claude.com/docs/en/skills (section "Stack several skills in one message").
- **[doc]** "Claude Code expands the first skill plus up to five more stacked after it. Expansion stops at the first token that isn't an inline user-invocable skill. If you stack a skill that runs as a forked subagent, such as `/code-review`, or one whose arguments may start with another command, such as `/loop`, expansion ends there. That token and everything after it become the argument text for every expanded skill." (same page). The commands page puts it as "Up to six skills can be chained." See https://code.claude.com/docs/en/commands.
- **[inference]** A message can therefore combine directly expanded skills (a run at the start) with permission-only mentions later in the text. The docs do not say this explicitly, but it follows from 1.1 and 1.2.

### 1.3 How arguments reach a skill

- **[doc]** Arguments are available through `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N`, with shell-style quoting. "If you invoke a skill with arguments but no placeholder in the skill's content receives one, Claude Code appends `ARGUMENTS: <your input>` to the end of the skill content." See https://code.claude.com/docs/en/skills.

### 1.4 The `/` menu (typeahead): what each entry shows

- **[doc]** "The `/` menu lists built-in commands, bundled and user-authored skills, and commands contributed by plugins and MCP servers." See https://code.claude.com/docs/en/interactive-mode (section "Commands").
- **[doc]** Completing mid-prompt: "Command completion also works partway through a prompt: type `/` after a space, then the first letters of a name, as in `run the tests, then /com`. Only commands whose names start with those letters match, so a file path such as `/tmp/notes.md` doesn't keep a list open. Claude Code runs a command itself only when the command starts your message." Outside fullscreen the top match shows as ghost text with a count such as `+2`, and Tab inserts it or opens the list. "press `Tab` on a bare mid-prompt `/` to list every command." See https://code.claude.com/docs/en/interactive-mode (section "Complete a command mid-prompt").
- **[doc]** Bare-name matching for plugins: "A plugin skill matches on its bare name too, so `/deploy` finds a skill named `myplugin:deploy-app`. When you insert the match, Claude Code writes the full `/myplugin:deploy-app`." (same section).
- **[doc]** Naming by source. A personal skill (`~/.claude/skills/`) and a project skill (`.claude/skills/`) both appear as `/name`. A plugin skill appears as `/plugin-name:skill-name`. A nested skill whose name collides with another appears as `/apps/web:deploy`, and "its description names the directory it applies to". See https://code.claude.com/docs/en/skills (sections "Where skills live" and the monorepo/nested section) and https://code.claude.com/docs/en/plugins/components ("Command name: `/<plugin>:<directory>`").
- **[doc]** Name conflicts: enterprise beats personal, personal beats project. A skill beats a `.claude/commands/` file of the same name. A user skill replaces a bundled one ("but not its aliases"). Plugin skills never conflict because they are namespaced. See https://code.claude.com/docs/en/skills.
- **[doc]** Per-entry source labels that the docs actually name:
  - synced skills: "the `/` command menu marks them as coming from claude.ai", and `/skills` and `/context` group them under `claude.ai sync`. See https://code.claude.com/docs/en/skills.
  - MCP prompts: "Claude Code lists each MCP prompt as `/servername:promptname (MCP)`. Typing `/mcp__servername__promptname` also runs it." See https://code.claude.com/docs/en/mcp (section "Use MCP prompts as commands").
  - bundled skills in the commands reference are "marked **Skill** in the Purpose column". See https://code.claude.com/docs/en/skills and https://code.claude.com/docs/en/commands.
  - `/skills` (a separate list, not the typeahead): "Type to filter the list by name, description, or source." See https://code.claude.com/docs/en/commands.
- **[doc]** Description and hint: `description` (or, failing that, the first non-empty line of the body) is the skill's description. `argument-hint` is a "Hint shown during autocomplete to indicate expected arguments", and it "shows after the command name". `name` is the "Command name shown in the `/` menu". See https://code.claude.com/docs/en/skills (frontmatter reference and troubleshooting).
- **[doc]** Visibility: `user-invocable: false` hides a skill from the `/` menu. `skillOverrides` can set a skill to `on`, `name-only`, `user-invocable-only` or `off` (only `off` hides it from the menu). See https://code.claude.com/docs/en/skills.
- **Not documented (unverified):** a `(user)` / `(project)` / `(project:subdir)` tag after the description. A web search returned snippets saying the older slash-commands docs (including localized ones) had such tags. The current English page (`/docs/en/slash-commands` now serves the skills content), the commands page and the interactive-mode page say nothing about them, and the Korean page now returns 404. Treat them as historical or undocumented. The current docs also say nothing about how the menu visually marks a plugin skill beyond its `plugin:` prefix.

---

## 2. pi (1.0.4)

Paths below are relative to `node_modules/@earendil-works/`.

### 2.1 Parsing `/skill:name` in a prompt: start of prompt only, one skill

- **[code]** `AgentSession._expandSkillCommand` (`pi-coding-agent/dist/core/agent-session.js:1661-1684`):
  - `if (!text.startsWith("/skill:")) return text;` means expansion happens only when the **whole prompt text** begins with `/skill:` (no `trimStart` here; the TUI editor trims the draft before submit, `pi-tui/dist/components/editor.js:1140` and `interactive-mode.js:2526-2527`, so a leading space typed in the TUI is harmless, while an RPC or extension caller must send the text with no leading whitespace).
  - The name runs up to the first space. Everything after it is `args` (trimmed). An unknown name passes through unchanged as plain text.
  - The output is `<skill name="…" location="<SKILL.md path>">\nReferences are relative to <baseDir>.\n\n<body without frontmatter>\n</skill>`, followed by `\n\n<args>` if any. There is no `$ARGUMENTS` substitution: the arguments are appended as a following user request. A read error emits `skill_expansion` through the extension error channel and returns the original text.
- **[code]** Only one skill is expanded. A second `/skill:x` inside the args stays literal text.
- **[code]** Prompt templates follow the same start-only rule. `expandPromptTemplate` returns early unless `text.startsWith("/")` and matches `^\/([^\s]+)(?:\s+([\s\S]*))?$` (`pi-coding-agent/dist/core/prompt-templates.js:247-259`).
- **[doc]** pi's docs agree: "Arguments after `/skill:name` are appended to the loaded instructions as a user request", and "`enableSkillCommands` … controls whether skill commands appear in interactive command discovery; manually entered `/skill:name` commands still work." See `pi-coding-agent/docs/skills.md:45-53`.

### 2.2 The prompt pipeline (order matters for any transform)

`AgentSession.prompt` (`pi-coding-agent/dist/core/agent-session.js:1520-1621`):

1. Extension commands: if the text starts with `/` and names a registered extension command, its handler runs and nothing is sent (`:1521-1529`, `_tryExecuteExtensionCommand` at `:1632`).
2. **`input` handlers** (`:1533-1539`, `_runInputHandlers` at `:1472-1484`) run before expansion, as the code comment there says.
3. `_expandSkillCommand`, then `expandPromptTemplate` (`:1540-1545`).
4. **`before_agent_start`** gets the expanded text (`:1587`). The user message is built from `expandedText` (`:1596`), not from anything the handler returns, so this hook can add `messages` and edit `systemPromptOptions` but **cannot rewrite the prompt text**.

Steer and follow-up messages queued while streaming go through the same steps 2→3 (`_queueUserInput`, `:1686-1700`).

- **[code]** `input` handlers chain. Each handler sees the previous handler's `transform`, and `handled` stops the chain (`pi-coding-agent/dist/core/extensions/runner.js:1202-1232`). The result type is `{action:"continue"} | {action:"transform", text, images?} | {action:"handled"}`. The event carries `text`, `images`, `source: "interactive"|"rpc"|"extension"` and `streamingBehavior` (`pi-coding-agent/dist/core/extensions/types.d.ts:873-895`).
- **[code]** `pi.sendUserMessage(content, { expandPromptTemplates })` sends extension-originated prompts through the same dispatch and expansion (`types.d.ts:1227-1235`).
- **[inference]** An extension could therefore support mid-prompt or multiple skills by handling `input` and rewriting `…/skill:a … /skill:b …` itself (for example, inlining `<skill>` blocks the way `_expandSkillCommand` does, and reading the file from `sourceInfo.path`). Pi's own expansion only fires when the transformed text still starts with `/skill:`.

### 2.3 Metadata pi keeps about a skill's origin

- **[code]** `Skill = { name, description, filePath, baseDir, sourceInfo, disableModelInvocation }` (`pi-coding-agent/dist/core/skills.d.ts`, interface `Skill`).
- **[code]** `SourceInfo = { path, source: string, scope: "user"|"project"|"temporary", origin: "package"|"top-level", baseDir? }` (`pi-coding-agent/dist/core/source-info.d.ts:2-10`).
- **[code]** How the fields get filled:
  - Auto-discovered user or project dirs: `source: "auto"` with scope `user` or `project` (`pi-coding-agent/dist/core/package-manager.js:1986-1997`). Settings-listed local paths get `source: "local"` (precedence comment, `package-manager.js:50-61`). CLI paths get `source: "cli", scope: "temporary"` (`resource-loader.js:396-400`).
  - Packages: `{ source: <the package source string, e.g. "npm:foo" or a git URL>, scope, origin: "package" }` (`package-manager.js:1008`). A package's identity lives only in that `source` string. There is no separate package-name field.
  - Fallback: anything under `<agentDir>/skills` is `local/user`, under `<cwd>/.pi/skills` is `local/project`, and anything else is `local/temporary` (`resource-loader.js:741-779`). `createSkillSourceInfo` in `skills.js:90-111` is the loader-level default.
  - Skills added by an extension through `resources_discover` → `skillPaths` (`types.d.ts:532-542`) take the metadata attached in `extendResources` (`resource-loader.js:319-335`).
- **[code]** Collision handling: the first one loaded wins and a `collision` diagnostic is recorded (`skills.js:325-353`). Precedence is: project settings entry, then project auto, then user settings, then user auto, then package (`package-manager.js:50-61`). pi's docs: "Name collisions keep the first discovered skill and produce a warning." (`docs/skills.md:85`).
- **[doc]** Other discovered locations include `~/.agents/skills/` and `.agents/skills/` (walking ancestors up to the repo root). See `pi-coding-agent/docs/skills.md:59-61`.
- **[code]** Extensions can read skills through `pi.getCommands()`, which returns `{ name: "skill:<name>", description, source: "skill", sourceInfo }` (`agent-session.js:2677-2696`, type `SlashCommandInfo` in `dist/core/slash-commands.d.ts`). `sourceInfo.path` is the SKILL.md path (`resource-loader.js:634-639` together with `createSourceInfo(resourcePath, …)`). RPC `get_commands` returns the same shape (`dist/modes/rpc/rpc-mode.js:558-566`). I found no direct `getSkills()` on the extension API.

### 2.4 Autocomplete: how pi lists skills and shows their source

- **[code]** The interactive mode builds the menu from built-ins, prompt templates, extension commands and, when `enableSkillCommands` is set, one `skill:<name>` entry per skill (`pi-coding-agent/dist/modes/interactive/interactive-mode.js:462-541`, skills at `:526-538`).
- **[code]** Source tag (`interactive-mode.js:422-448`). Each description is prefixed with `[tag]`:
  - `u`, `p` or `t` for scope user, project or temporary, when the source is `auto`, `local` or `cli`.
  - `<u|p|t>:npm:<pkg>` for npm packages and `<u|p|t>:git:<host>/<path>[@<ref>]` for git packages. The letter always comes from `sourceInfo.scope`.
  - nothing at all for `builtin` sources (and for built-in commands).
  - So a user skill shows as `skill:pdf-tools  [u] Extract text…`, and a package skill as `[u:npm:pi-skills] …`.
- **[code]** Matching (`pi-tui/dist/autocomplete.js:232-260`). The `/` branch runs only when `textBeforeCursor.trimStart()` starts with `/` and has no space yet. `skill:` entries fuzzy-match on the bare name first (`/pdf` finds `skill:pdf-tools`) and then on the full name (`:248-251`), much like Claude Code's bare-name plugin matching. `argumentHint` is shown as `<hint> — <description>`.
- **[code]** The editor auto-opens the slash menu only on the **first line**, at the start: "Slash menu only allowed on the first line of the editor", `isSlashMenuAllowed() { return cursorLine === 0 }`, and `isAtStartOfMessage()` (`pi-tui/dist/components/editor.js:1833-1847`, trigger at `:1021-1023`). Pi has no mid-prompt `/` completion today.
- **[code]** Extension hook `ctx.ui.addAutocompleteProvider(factory)`, where `factory: (current) => AutocompleteProvider` wraps the provider chain (`types.d.ts:66, 141`, wiring in `interactive-mode.js:542-557, 2074-2077`). A wrapper can add, filter or relabel items. bluclawd already does this: `withoutAgentViewCommand` in `ext/agent-view/index.ts:62-74`, registered at `:485`. `ui.setEditorComponent` can replace the editor entirely. Both are no-ops in RPC mode (`pi-coding-agent/docs/rpc-extension-ui.md:18`).
- **[code]** Limits for mid-prompt completion. `setAutocompleteTriggerCharacters` **drops `/`** from provider trigger characters (`pi-tui/dist/components/editor.js:1952-1962`; the defaults are `@` and `#`). Typing `/` mid-line therefore never calls a provider. Tab mid-line does: `handleTabCompletion` calls the provider with `force: true` (`editor.js:1895-1912`), so a wrapper could recognise a ` /ski` token on a forced request. The other routes are a different trigger character or a custom editor component.

---

## 3. bluclawd today

- **[code]** `ext/prompt-assist` does not list or know about skills. It does two things:
  - LLM ghost-text "next prompt" suggestions (`ext/prompt-assist/index.ts:261-285`, `editor.ts:10-116`). These are suppressed whenever the draft starts with `/` or `!`: `!/^\s*[!/]/.test(editor.getText())` (`editor.ts:30-31`).
  - Automatic session titles, from `before_agent_start`'s `event.prompt` (`index.ts:297-300`). That text is **post-expansion** (§2.2), so a `/skill:x` prompt is titled from the skill body plus its arguments, not from what the user typed. **[inference]** This is likely an unintended side effect.
  - Note: the working tree had an uncommitted change in `ext/prompt-assist/index.ts` (a model picker) when this was read. It does not touch skills.
- **[code]** `/help` lists skills from `pi.getCommands()` filtered on `source === "skill"`, showing only name and description. It drops `sourceInfo`, so there is no user/project/package marker (`ext/help/index.ts:98-122`, rendering at `:78-87`).
- **[code]** The remote pane protocol carries `PaneCommand { name, description?, source: "builtin"|"extension"|"prompt"|"skill" }`, again with no origin (`daemon/ipc/protocol.ts:196-201, 248-266`). A phone may run skills and prompt templates (`phoneMayRun`, `:261-266`). The phone's command parse is start-only (`/^\/([\w.:-]+)(?:\s|$)/`, `daemon/remote/phone-control.ts:125-128`).
- **[code]** Existing `input` handlers in bluclawd, whose order matters for any new transform: `ext/paste/index.ts:217`, `ext/background-bash/index.ts:380`, `ext/remote/index.ts:334`.

---

## 4. Gap summary (Claude Code behaviour vs what pi has)

| Behaviour | Claude Code | pi 1.0.4 | Hook to bridge it in pi |
|---|---|---|---|
| Direct run at start | yes [doc] | yes, `/skill:` only [code] | n/a |
| Stack several at start | up to 6, terminal only [doc] | no, only the first [code] | `input` transform |
| Mid-prompt mention | permission, not expansion [doc] | literal text [code] | `input` transform (expand or annotate) |
| Mid-prompt completion | yes, `/` after a space [doc] | no, line 0 at the start only [code] | provider wrapper on Tab (`force`), another trigger char, or a custom editor |
| Bare-name match for namespaced skills | yes, plugins [doc] | yes, `skill:` prefix [code] | n/a |
| Source label in menu | claude.ai marking, `(MCP)`; plugin via the `plugin:` prefix [doc] | `[u]`/`[p]`/`[t]`, `[<scope>:npm:…]`, `[<scope>:git:…]` [code] | provider wrapper can relabel |
| Argument substitution | `$ARGUMENTS`/`$N`, else an `ARGUMENTS:` suffix [doc] | args appended after the `<skill>` block [code] | `input` transform |
