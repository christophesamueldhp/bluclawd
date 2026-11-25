# Subagent confinement, nesting and context

This follows `agent-sandboxing.md` and `subagent-best-practice.md` and does not repeat them. It covers what the user's four decisions need: nesting to three levels, a light fork, confined in-process file tools, and a `.gitignore` setting that runs follow. Sources were read on 2026-11-25. Source code is cited at `openai/codex` `ebd0765`, `google-gemini/gemini-cli` `08e9a20`, pi 1.5.2 as installed, and bluclawd `415f50e`. Claude Code is closed source, so its rows rest on its docs only. "Unconfirmed" means no primary source was found.

## Short answer

- No vendor confines a subagent more than its parent, and no agent definition can ask for a different sandbox [2][7][9][15]. bluclawd's always-sandboxed runs are stricter than all three.
- Claude Code nests 3 layers and forks by default, sharing the parent's prompt cache [8][11]. Codex's v1 tools allow depth 1 and an opt-in, stripped fork. Its v2 tools, which most bundled models select, have no depth limit and fork everything by default [1][3][4]. Gemini has neither nesting nor forks [15].
- Codex confines file writes with a sandboxed helper [5]. Gemini checks paths in process and can sandbox writes and search [16]. All three treat `.gitignore` as a search filter, and only Gemini also refuses reads of ignored files [18].

## A. Confinement when the parent's sandbox is off

| | Child's sandbox | Definition can tighten it | Can widen | What still narrows |
|---|---|---|---|---|
| **Codex** | The spawning turn's permission profile and approval policy, applied after the role. Full access under `danger-full-access` [2] | No. A role sets model fields and instructions, and can only switch features and skills off [2][7] | No [2][7] | `shell_tool`, `apps`, `plugins`, `memories`, `request_permissions_tool` set false [2]. Instructions "don't create a separate read-only sandbox" [7] |
| **Claude Code** | Same process and configuration. Bash is sandboxed "when sandboxing is enabled in the parent session" [9] | No sandbox field. `permissionMode` applies only under a `default` or `dontAsk` parent; under `bypassPermissions`, `acceptEdits` or auto it is ignored [8] | Sandbox: no. Mode: yes under a `default` parent, except `bypassPermissions` [8] | `tools`, `disallowedTools`, hooks. `isolation: worktree` adds path checks, not OS rules [8][10] |
| **Gemini CLI** | Same `Config` and sandbox manager, a no-op without `--sandbox` or `security.toolSandboxing` [15][16] | No [14] | Policy rules scoped with `subagent =` can allow; the docs' example allows `git push` [14] | `tools` list, all tools if omitted [14]. The workspace path check holds with the sandbox off [16] |

## B. Nesting

| | Codex v1 | Codex v2 | Claude Code |
|---|---|---|---|
| Depth | `[agents] max_depth`, default 1. At the limit the spawn tools are withheld, and a spawn returns "Agent depth limit reached. Solve the task yourself." [1][3] | Not enforced (test `multi_agent_v2_spawn_agent_ignores_configured_max_depth`) [3] | 3 layers, set by `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`. `Agent` is withheld at the limit [8] |
| Concurrency | 6, in a registry "shared by all agents in the same user session", so the whole tree. Past it, the spawn fails [1][3] | 4 including the primary [1] | 20 running, then the spawn fails [8]. Whether nested subagents count: unconfirmed |
| Narrowing | Each child copies its spawner's profile; roles only remove [2] | Same | Mode follows the main conversation. A nested child takes its own definition's tools and its spawner's model [8]. Whether a parent's tools cap a child's: unconfirmed |
| Writes | Spawner's cwd; no worktree [2] | Same | Same checkout unless `isolation: worktree`, which branches from the default branch, or with `baseRef: "head"` from the enclosing worktree's HEAD [10] |
| Results | The parent calls `wait` [3] | The final answer goes to the parent; names are paths such as `/root/task1/task_3` [3] | The spawner waits; "only the top-level subagent's summary returns to you" [8] |

Which Codex version runs depends on a config override, then the model's catalog entry, then the feature flag, which gives v1 [1]. The bundled catalog selects v2 for most listed models: the gpt-6.x models and `gpt-5.6-sol`/`terra`. It selects v1 for `gpt-5.6-luna` [1]. Whether the server's catalog differs is unconfirmed. `subagent-best-practice.md` [S9] reports depth 1; that holds only for v1. Gemini drops agent tools from a subagent's registry [15].

## C. Context passed to a subagent

**Claude Code.** A fork "inherits the entire conversation so far": the same system prompt, tools, model and history. Only its result returns [8], and "its first request reads the parent's cache" [11]. Fork mode is on by default since v2.1.302. `CLAUDE_CODE_FORK_SUBAGENT=0` turns it off, and a fork cannot fork [8]. No truncation is documented; a fork compacts when its own window fills [8].

**Codex.** v1 `fork_context`: "false or omitted starts with only the initial prompt" [3], and a fork cannot take a role [2]. A v1 fork keeps system, developer and user messages and the assistant's answers. It drops reasoning, tool calls and outputs, messages between agents, and the parent's multi-agent instructions [4]. v2's `fork_turns` defaults to `"all"`, and a turn count now forks everything too [3]. With `preserve_fork_prefix` on (the default), v2 keeps every item, so the cached prefix survives. It then adds: "Inherited tool calls are historical records; live tool sessions and process handles are not inherited" [1][4].

**Gemini.** The agent tool takes `agent_name` and a `prompt`, which it describes as "The COMPLETE query … Include all context" [15]. The child gets no parent history.

**Guidance.** Claude Code recommends a fork "when any other subagent would need too much background to be useful" [8]. Anthropic recommends clean sub-agent contexts and calls tool-result clearing "the safest lightest touch" compaction [19]. No vendor still forks the last N turns. The two ways to make a fork cheap conflict: stripping it (Codex v1) breaks the byte-identical prefix that the cache needs (Claude Code, Codex v2).

## D. Confining in-process file tools

**Codex** [5]. `apply_patch` and `view_image` take the shell's permission profile. A read goes through the sandbox only if the policy restricts reads, and a write only if it restricts writes. Each sandboxed operation starts the `codex` binary as a helper under Seatbelt or bwrap. The request goes in as JSON on stdin, with the environment cut to `PATH` and the temp variables. The helper can open, read, write, mkdir, stat, canonicalize, list, walk, remove and copy. Under `workspace-write`, reads are direct and each write costs a process. Codex has no read, grep or glob tool [5].

**Gemini** [16][17]. Tool sandboxing is per call, with no relaunch. `write_file` and `edit` write through `sh -c 'tee …'` under the sandbox, after a realpath check against the workspace. `read_file` reads in process after `validatePathAccess`. `glob` and `ls` filter their results with the same check. Search runs `rg` under the sandbox.

**Cost.** No vendor publishes a figure. Locally, on macOS at load 5.5, `/bin/cat` took about 7 ms under `sandbox-exec` with a trivial profile, against 1.3 ms without it [22]. srt's full profile will cost more.

**pi's hooks.** An extension can block or rewrite calls in `tool_call`. It can replace `read`, `edit`, `write`, `grep`, `find` and `ls` with a tool of the same name, keeping the built-in renderer. The tool factories accept `*Operations` objects, so I/O can be swapped without rewriting the tools. Grep's operations cover only the directory check, so grep needs an `execute` override [20].

## E. `.gitignore`

| | Direct read | Search and listing | Setting |
|---|---|---|---|
| **Codex** | No read tool | The TUI's `@` search respects it [6] | An internal file-search option; no user setting found [6] |
| **Claude Code** | Unconfirmed; Grep reaches an ignored file when given its path [12] | Grep respects it; Glob does not by default [12] | `CLAUDE_CODE_GLOB_NO_IGNORE`. `respectGitignore` covers only the `@` picker [12][13] |
| **Gemini CLI** | Refused: "is ignored by configured ignore patterns". Found in source; the tests cover `.geminiignore` only [18] | glob, ls and rg respect it. The model can override it per call [18] | `respectGitIgnore`, default true [18] |
| **pi** | Not filtered | `grep` and `find` respect it; `ls` does not [20] | None [20] |

None of them enforces ignore files on shell commands. Gemini's ignored files stay "visible to other services" [18]. Subagents use the parent's tools and settings; for Claude Code that is unconfirmed.

## Recommendations for bluclawd

1. **Keep runs always sandboxed.** The other vendors' subagents share the parent's process, so they inherit its sandbox. A bluclawd run is a separate pi in its own worktree, and an unsandboxed shell there could write into the user's checkout, which defeats the isolation. The cost is that commands needing host resources, such as a container socket or the keychain, fail in runs. Let a role or call make a run stricter, for example with a read-only profile, but never wider. That follows Codex: roles "reduce its capabilities, but never replace the parent session's authority" [2].

2. **Nesting to three levels.**
   - Record depth on the run. Refuse a spawn past 3 at admission, and withhold `subagent` at the limit, as Codex v1 and Claude Code do.
   - Make a child's policy the intersection of its parent's admitted policy and its role. Tools, network and shell access can only shrink, and deny rules accumulate.
   - Take a writer child's baseline from its parent's worktree as it stands. `captureRunBaseline` uses the launching cwd, and Integration writes to `baseline.source`, so a child would integrate into its parent's worktree [21]. This comes from reading the code and is untested from inside a linked worktree.
   - Only top-level runs integrate into the user's checkout. A parent's Evidence lists its children's Integrations. srt lets each run write only its own worktree.
   - Send reports and messages to the parent run, and show the tree in the panel.
   - **Deadlock risk.** The cap is 4 runs daemon-wide, and extra runs queue (`subagent-best-practice.md`). If a parent waiting on its children keeps its slot, which was not checked, four such parents would deadlock. Either lend a blocked parent's slot to its descendants, or fail nested spawns at the cap, as Codex and Claude Code do [3][8].

3. **A light fork.** Vendors fork only where the child can reuse the parent's cache prefix [8][11], or as an opt-in stripped copy (Codex v1). A run has its own tools and prompt, so it cannot share the prefix. A stripped, opt-in fork is the practice that applies. Never use it for `reviewer` or for nested runs.
   - Copy pi's latest compaction summary, then the user messages and the assistant's final text after it.
   - Drop tool calls and results, thinking, and delegation-tool traffic.
   - Cap the copy at a token budget, keeping the newest turns.
   - Label it as history, as Codex does, and append the brief.

   The trade-off is no cache reuse and a stale view of files, for a bounded size. This revises ADR-0010.

4. **Confining the file tools.** There are three ways to do it with pi's hooks:
   1. A path check in `tool_call`, which runs already do for writes [21]. It checks text, and the file can change between the check and the open.
   2. `*Operations` that check the policy after realpath, at open time. This is cheap, but the kernel does not enforce it.
   3. `*Operations` backed by an srt-wrapped helper, as Codex does. The kernel enforces it, at a few milliseconds a call.

   Use option 3 for `write` and `edit`. Every run has a `denyRead` list, so Codex's rule would send every read through a helper. Use option 2 for `read`, `ls` and `find` instead, and run grep's `rg` under srt so that it cannot open denied files. Apply the same policy in the orchestrator when its sandbox is on.

5. **"Respect `.gitignore`" means search visibility only.** When it is on, which is the default and matches pi, `grep` and `find` skip ignored files. When it is off, they pass `--no-ignore`. pi has no switch, so this needs `execute` overrides. `find` also passes its custom operations a `node_modules` exclusion [20]. Do not deny reads, because the model needs `node_modules` and `dist` for types and build output. Do not filter the shell: no vendor does, and srt and Codex ignore ignore files on purpose (`agent-sandboxing.md`). Secrets belong in `denyRead`. Keep the value in global settings and pass it in the admitted policy, so runs and their children follow the orchestrator and no role can flip it.

## Sources

1. `openai/codex` `ebd0765`: `codex-rs/core/src/config/mod.rs` (`DEFAULT_AGENT_MAX_DEPTH`, `DEFAULT_AGENT_MAX_THREADS`, `DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION`, `multi_agent_version_for_model`, `preserve_fork_prefix`), `codex-rs/features/src/lib.rs`, `codex-rs/models-manager/models.json`
2. Same commit: `codex-rs/core/src/agent/child_config.rs`, `agent/role.rs`
3. Same commit: `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs`, `multi_agents_v2/spawn.rs`, `multi_agents_spec.rs`, `multi_agents_tests.rs`, `tools/spec_plan.rs`, `agent/registry.rs`
4. Same commit: `codex-rs/core/src/agent/history.rs` (`keep_forked_rollout_item`, `prepare_forked_history`)
5. Same commit: `codex-rs/exec-server/src/fs_sandbox.rs`, `fs_helper.rs`, `local_file_system.rs`, `codex-rs/file-system/src/lib.rs`, `core/src/tools/runtimes/apply_patch.rs`, `core/src/tools/handlers/` (tool list)
6. Same commit: `codex-rs/file-search/src/lib.rs`
7. https://learn.chatgpt.com/docs/agent-configuration/subagents
8. https://code.claude.com/docs/en/sub-agents
9. https://code.claude.com/docs/en/sandboxing ("Scope")
10. https://code.claude.com/docs/en/worktrees
11. https://code.claude.com/docs/en/prompt-caching
12. https://code.claude.com/docs/en/tools-reference (Glob, Grep)
13. https://code.claude.com/docs/en/settings-reference (`respectGitignore`)
14. `google-gemini/gemini-cli` `08e9a20`: `docs/core/subagents.md`
15. Same commit: `packages/core/src/agents/local-executor.ts`, `agent-tool.ts`
16. Same commit: `packages/core/src/config/config.ts`, `services/sandboxedFileSystemService.ts`, `services/sandboxManagerFactory.ts`, `sandbox/utils/sandboxReadWriteUtils.ts`, `tools/read-file.ts`, `utils/fileUtils.ts`, `tools/glob.ts`, `tools/ripGrep.ts`
17. Same commit: `docs/cli/sandbox.md` ("Tool sandboxing"), `packages/cli/src/config/settingsSchema.ts`
18. Same commit: `docs/reference/configuration.md` (`fileFiltering`), `docs/cli/gemini-ignore.md`, `packages/core/src/services/fileDiscoveryService.ts`, `tools/read-file.ts`, `tools/read-file.test.ts`, `tools/ls.ts`
19. Anthropic, "Effective context engineering for AI agents" ([S6] in `subagent-best-practice.md`)
20. pi 1.5.2: `docs/extensions.md` (`tool_call`, "Overriding Built-in Tools", "Remote Execution"), `dist/core/tools/grep.js`, `find.js`
21. bluclawd `415f50e`: `ext/subagents/rpc-child.ts` (loaded into runs by `rpc-runs.ts`), `run-shell.ts`, `run-worktree.ts`, `integration.ts`, `admission.ts`
22. Local measurement, macOS 27.2, 2026-11-25; not a vendor figure
