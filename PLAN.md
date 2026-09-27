# PLAN — Subagents at Claude Code 2.1.283 fidelity

Goal: bluclawd's subagent layer behaves like Claude Code 2.1.283's `Agent` tool, as seen by the
model (tool schema, roster, result text, notifications), by the user (rules, agent files,
rendering) and by the child (system prompt, tools, context).

Sources (2026-09-27): CC 2.1.283 binary strings + code.claude.com docs + CHANGELOG, and a
file:line map of `ext/subagents`, `ext/permissions`, `ext/sandbox/child-bash.ts`.
Working copies of both reports live in the job tmp dir (not durable); the facts that matter
are restated below.

## Gap table

Bucket: **R** = do regardless · **D1/D2/D3** = blocked on decision 1/2/3 · **OUT** = out of scope.

| # | Area | Claude Code 2.1.283 | bluclawd now | Bucket |
|---|---|---|---|---|
| 1 | Session rules in children | `--disallowedTools`, session grants and frontmatter `disallowedTools` apply to the child | child gate + acceptance gates read settings files only (`subagent-gate.ts:76`); `--disallowedTools` is bypassable by delegating | **R (security)** |
| 2 | Rule verb | `Agent(x)`, bare `Agent` (deny all), `Agent(model:x)`, `Agent(isolation:*)`; `Task(...)` alias | only `Task(x)`; `Agent(...)` and bare `Task` match nothing | R |
| 3 | Deny hides agent | a denied type is dropped from the listing; spawn refused with `Agent type 'X' has been denied by permission rule 'Agent(X)' from <source>.` | still listed, refused at call time | R |
| 4 | `tools:` names | CC names (`Read, Grep, Glob, Bash, Edit, Write, WebFetch, WebSearch, Agent, mcp__srv[__*]`); `Agent(a,b)` | lowercased only; `Glob`, `WebFetch`, `Agent`, `mcp__…` map to nothing, silently | R |
| 5 | Zero tools | refuses: `Agent 'X' would be spawned with zero tools — refusing. …` | runs with no tools | R |
| 6 | Default tool set | every tool minus a fixed exclusion set (AskUserQuestion, plan-mode tools, …); MCP tools always kept | read/bash/edit/write only — no grep/find/ls, no web tools, no monitor, no unnamed MCP | R |
| 7 | Child system prompt | def body **replaces** the default; then the authority sentence, the `Notes:` block and the `# Environment` block (verbatim) | body appended to pi's full default prompt; no env/date block | R |
| 8 | Child first message | CLAUDE.md hierarchy + git status as a `<system-reminder>` context message; skills preloaded as messages; then the prompt | context files via pi's loader (trusted only); prompt sent as `Task: <task>` | R |
| 9 | `omitClaudeMd` | frontmatter field | hardcoded for bundled explore/planner only | R |
| 10 | `permissionMode` | `default, acceptEdits, auto, dontAsk, bypassPermissions, plan` | `plan`/`dontAsk` silently ignored | R (map `dontAsk`→ask-with-no-prompts; `plan` → nearest read-only posture) |
| 11 | `color` | colours the agent's name in the transcript | parsed, never used | R |
| 12 | Built-ins | `general-purpose`, `Explore`, `Plan` (CC prompts verbatim, Explore/Plan read-only + one-shot) | `general-purpose`, `explore`, `planner`, `code-reviewer`, `oracle`, `worker` | R (rename + CC prompts); extras → D2 |
| 13 | Name lookup | exact, then case/separator-insensitive (`Code Reviewer` → `code-reviewer`), ambiguity error | exact only (`Unknown agent`) | R |
| 14 | Limits | depth 3, 20 concurrent; `maxTurns` partial note text | depth 2, 8 tasks / 4 concurrent | R |
| 15 | Tool surface | `Agent{description, prompt, subagent_type?, model?, run_in_background?, isolation?}`; continue via `SendMessage{to, message, summary}`; `TaskStop{task_id}` | `task{agent, task, tasks, chain, workflow, resume, worktree, fork, …}` + `task_message`/`task_wait`/`task_stop` | **D1** |
| 16 | Roster | `<system-reminder>` message: `Available agent types for the Agent tool:` + `- type: whenToUse (Tools: …)` | `<available_agents>` block in the system prompt | D1 |
| 17 | Result text | report + `agentId: <id> (use SendMessage …)` + `<usage>subagent_tokens/tool_uses/duration_ms</usage>`; provenance header; Explore/Plan return no footer | report + `[agent id: … pass resume …]` | D1 |
| 18 | Background | on by default (`run_in_background: false` opts out); `Async agent launched successfully. …` text; completion as `<task-notification>` XML | opt-in; `Started background subagent …`; `[subagent id · agent finished]` message | D1 |
| 19 | Fork | `subagent_type: "fork"` + `<fork-boilerplate>` directive | `fork: true` boolean + own framing | D1 |
| 20 | `model` param | enum `sonnet/opus/haiku/fable` | none (def only) | D1 — string, resolved via `subagents.models` alias map → `provider/id` → unique bare id → parent (provider-neutral rule) |
| 21 | Rendering | `Explore(description)` header coloured; `Done (N tool uses · X tokens · Ys)`; grouped `Running N agents…` | `task <agent>` + own usage line | D1 |
| 22 | Extras CC lacks | parallel = several Agent calls in one message; chain = model sequences; no supervisor tool | `tasks[]`, `chain`, `workflow`, `gate`, `outputSchema`, `mission`, `task_schedule`, `task_wait`, `manage_agents`, `contact_supervisor`, `runner`, `toolBudget`, `maxTokens`, `/review-loop`, `oracle`/`worker`/`code-reviewer`, `/agents new/edit/delete` | **D2** |
| 23 | Def sources | managed > `--agents` JSON > project `.claude/agents` > `~/.claude/agents` > plugin > built-in | bundled < `~/.pi/agent/agents` < `.pi/agents` | **D3** |
| 24 | `/agents` | wizard removed; prints a pointer to `.claude/agents/` | list / new / edit / delete / show / stop | D2 |
| 25 | Hooks | `SubagentStart` / `SubagentStop`, frontmatter `hooks` | none | OUT — hooks extension was deleted at the user's request (2026-09-02); revisit only if hooks return |
| 26 | CC-only | agent teams, `isolation: "remote"`, coordinator mode, observer agents, `statusline-setup`, `claude-code-guide`, `web-fetch`, `claude` built-ins, SubagentHandback | — | OUT (Anthropic-account or Claude-Code-product specific) |

Known breakage to announce: renaming `explore`/`planner` to `Explore`/`Plan` (row 12) changes the
names in user rules like `Task(explore)`; row 13's normalised lookup keeps old spellings resolving
in calls, but rule subjects follow the new names.

## Decisions (user, 2026-09-27)

1. **Tool surface = exact CC schema.** `agent{description, prompt, subagent_type?, model?,
   run_in_background?, isolation?}`, `send_message{to, message, summary?}` (steers a running child,
   resumes a finished one), `task_stop{task_id}`. `task` is removed; `Task(...)` stays a rule alias.
   Tool names follow bluclawd's lowercase convention (`webfetch`, `task_stop`); rule verbs use CC
   casing (`Agent(...)`). Live-verify `isolation`/`run_in_background` with a default-filler model;
   if `isolation` is auto-filled, report before mitigating.
   `model` keeps CC's enum (`sonnet|opus|haiku|fable`), resolved provider-neutrally:
   `subagents.models[alias]` → a model of the parent's provider whose id contains the alias → parent.
2. **Extras removed** (row 22 + `/agents` wizard): pure CC surface; `/agents` prints CC's pointer
   message (with `.pi/agents` paths). Also gone: `timeoutMs`, `toolTimeoutMs`, `maxSpawns`,
   `forkCompactAbove`, `/agents show|stop` (`/tasks` covers them, as in CC).
3. **Definition sources stay `.pi` only**; CC tool names in `tools:`/`disallowedTools:` are mapped.
   T7 is dropped.

## Tiers

Each tier: failing test first → implement → `npx vitest run` + `npm run typecheck` → live tmux
verify with a default-filler model (opencode-go) where the model-facing shape changes → commit
(after asking). Order: T0 → T6 (removal shrinks everything after it) → T1 → T2 → T3 → T4 → T5.

- [x] **T0 — security: session rules reach children** (row 1)
  - publish the live merged rules (settings + `sessionRules` + `cliAllowRules`) via a sharedRef from
    `ext/permissions/index.ts`; `createSubagentGate` and `host-command.ts` read it, falling back to
    `loadParentRules` only when no parent published
  - test: parent with `--disallowedTools "Bash(touch *)"` → child `touch` blocked; a "yes for this
    session" grant is honoured in the child
- [x] **T1 — rules** (rows 2–3): `Agent` verb + `Task` alias, bare verb, `model:`/`isolation:` param
  rules (deny/ask only, literal match, never on omitted params); denied types dropped from the roster
- [x] **T2 — agent files** (rows 4, 5, 9, 10, 11, 13): CC tool-name map + `mcp__` grants, zero-tools
  refusal with CC text, `omitClaudeMd`, `permissionMode` values, `color` in render, fuzzy lookup
- [x] **T3 — child runtime** (rows 6, 7, 8, 14): default pool minus exclusions, prompt replacement +
  CC Notes/Environment blocks, context as first message, depth 3 / concurrency 20
- [x] **T4 — built-ins** (row 12): `general-purpose`, `Explore`, `Plan` with CC prompts adapted to pi
  tool names; Explore/Plan one-shot
- [x] **T5 — tool surface** (rows 15–21)
- [x] **T6 — remove extras** (rows 22, 24)
- ~~T7 — definition sources~~ (decision 3: `.pi` only)

## Live findings (2026-09-27, opencode-go gpt-5.6-luna, tmux + `pi -p`)

- Verified: agent listing message (only deltas; not sent to Explore/Plan), foreground Explore
  one-shot result (hand-back header, no footer), background launch text + `<task-notification>`,
  `send_message` resume of a finished agent (same id, background, notification with
  `<result>`/`<usage>`), fork (inherits the conversation, answered from it), worktree + branch
  removed when unchanged, `--disallowedTools "Bash(touch *)"` blocks the child's `touch` (T0).
- **Default-filler, as predicted (decision 1 says: report first).** luna fills every optional enum
  even when told not to: `model: "sonnet"` (harmless: resolves to the parent model) and
  `isolation: "worktree"` on every call — every agent then works on a worktree of `origin/HEAD`,
  without the uncommitted work (Explore could not find a function that exists only in the working
  tree), and in one run the model stopped and relaunched its own agent 4× over it. **User decision:
  neutral first values** — `model: ["inherit", …]`, `isolation: ["none", …]`, both meaning "omitted".
  Re-verified live: luna now sends `inherit`/`none`, no worktree, correct answer.
- Result texts not found in the 2.1.283 binary and so written in its style (INFERRED): the
  `send_message` resume reply. Found and used verbatim: `Message queued for delivery to <id> at its
  next tool round.`, `Successfully stopped task: <id> (<description>)`.
- Fixed after the test rewrite: Explore/Plan were registered for `send_message` continuation
  (now never; verified live — refused); at the depth cap a child's tool pool still named
  `agent`/`send_message` (now `canSpawn` reaches the engine; a `tools: [Agent]` def is refused).
- Checks: `npx vitest run` 81 files / 1167 tests green, `tsc` clean, biome clean (1 pre-existing
  warning in ext/web/render.ts).
- Housekeeping: 56 untracked iCloud conflict copies (`* 2.ts`/`* 2.md`, created 2026-09-26 23:29–
  01:22, each byte-identical to HEAD or the current file) broke `tsc`; moved to
  `~/.Trash/bluclawd-icloud-dupes-2026-09-27`. A broken ref `refs/heads/main 2` (+ `origin/main 2`)
  is still there — same iCloud cause, left for the user. **Update:** the user OK'd removal; it, `.git/index 2|3|4`
  and `general-purpose 3.md` (identical to HEAD) went to the same Trash folder; `git fsck` clean.
- Live-verified after commit: an ask-mode child's write prompts in the parent UI ("Subagent
  "general-purpose" needs permission"), Yes lets it write; a worktree agent that leaves changes
  keeps its worktree + branch and the footer carries `worktreePath:` / `worktreeBranch:`.
- Not a gap: a bare `Read`/`Edit` deny adds nothing to the sandbox lists (`sandboxListsFromRules`
  says so on purpose: no path, and deny-write-everywhere would break every bash call).
- Flaky, unrelated: `test/exit-status.test.ts` "grep exit 1" failed once in 3 full-suite runs
  under load, 6/6 alone.
