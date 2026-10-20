# Sandbox for the model's shell commands

Goal: the contents of a secret file such as `.env` never reach the model through pi, including
commands that read it without naming it (`grep -r KEY .`, `rg KEY`, a script that opens it).
Deny rules match the text of a call, so they cannot close that gap. An operating-system sandbox
around the process can.

Reference: Claude Code's sandbox (<https://code.claude.com/docs/en/sandboxing>), built on
Anthropic's open source `@anthropic-ai/sandbox-runtime` (`srt`,
<https://github.com/anthropics/sandbox-runtime>). bluclawd uses the same library and follows the
same model: the sandbox wraps shell commands, and deny rules keep governing pi's in-process tools.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Engine | `@anthropic-ai/sandbox-runtime`, pinned to `0.0.81` | Maintained by Anthropic, used by Claude Code, covers macOS (Seatbelt) and Linux/WSL2 (bubblewrap). Hand-written Seatbelt profiles are easy to get wrong |
| Scope | Reads, writes and network | `srt` always isolates all three, and Anthropic's model needs both layers: without file isolation a process can read secrets, without network isolation it can send them out |
| Activation | Opt-in: `sandbox.enabled: true` in global settings | Same default as Claude Code. Other bluclawd users are not blocked by an update |
| Settings scope | Global settings only (`~/.pi/agent/settings.json`) | A repository's files must not loosen or switch off the sandbox |
| Unlisted network host | Ask the user, once per host per session; deny without a UI | Same as Claude Code's default |
| Sandbox cannot start | Fail closed: the model's `bash` and `monitor` are refused with the reason | Same as Claude Code's `failIfUnavailable`. A secret is never exposed by a silent fallback |
| Escape hatch | None | No `excludedCommands`, no unsandboxed retry. The user can still run a command with `!`, which is not sandboxed (same as Claude Code) |
| Native Windows | Unavailable, "use WSL2" | Claude Code runs unsandboxed there; `srt`'s Windows support is alpha and needs an elevated install |
| `powershell` tool | Blocked while the sandbox is on | It is pi's own tool and does not run through bluclawd's exec, so it would bypass the sandbox |
| Nested Docker | No `enableWeakerNestedSandbox` | Anthropic says it "considerably weakens security" |

## Settings

```json
{
  "sandbox": {
    "enabled": true,
    "network": { "allowedDomains": ["registry.npmjs.org", "github.com"] },
    "filesystem": { "allowWrite": ["~/.npm"], "denyRead": ["~/**/.env*"], "denyWrite": [] }
  },
  "permissions": { "deny": ["Read(**/.env*)"] }
}
```

- `enabled`: boolean, default `false`.
- `network.allowedDomains`: hosts the model's commands may reach without asking. `srt` wildcard
  syntax (`*.example.com`, optional `:port`). Default empty.
- `filesystem.allowWrite`: paths writable besides the working directory and the temp directory.
- `filesystem.denyRead` / `filesystem.denyWrite`: extra paths, merged with the paths taken from
  deny rules.
- Path entries accept `~/…`, absolute paths, and paths relative to the working directory.

The resulting `srt` config:

| `srt` field | Comes from |
|---|---|
| `filesystem.denyRead` | Every `Read(<path>)` deny rule (global and, for a trusted project, project), plus `sandbox.filesystem.denyRead` |
| `filesystem.denyWrite` | Every `Edit(<path>)` and `Write(<path>)` deny rule, plus `sandbox.filesystem.denyWrite` |
| `filesystem.allowWrite` | The working directory, `os.tmpdir()`, plus `sandbox.filesystem.allowWrite` |
| `network.allowedDomains` | `sandbox.network.allowedDomains` |
| `network.deniedDomains` | Empty |

Rule paths are converted to absolute paths, because `srt` on Linux skips a pattern whose first
path component is a wildcard:

| Rule subject | Sandbox path |
|---|---|
| `**/.env*`, `.env`, `secrets/**` (relative) | `<cwd>/**/.env*`, `<cwd>/.env`, `<cwd>/secrets/**` |
| `~/.ssh/**` | `<home>/.ssh/**` |
| `//etc/hosts` | `/etc/hosts` |
| `/abs/path` | `/abs/path` |

This anchors relative rules at the working directory, as Claude Code does. For pi's own tools, a
`**/…` deny rule matches anywhere on the filesystem; for the sandbox, only under the working
directory. A secret elsewhere goes in `sandbox.filesystem.denyRead`. The README states this.

The sandbox cannot tell an append from an overwrite, so under it a `Write(<path>)` rule blocks
`>>` as well as `>`, where the deny rule alone lets `>>` through. A `Read` rule does not affect
writes, so `Read(**/.env*)` alone still lets the model append to `.env`.

## Units

### U1. `ext/sandbox/config.ts`: settings to `srt` config

- `sandboxSettings(sm)`: reads `sandbox` from global settings only. Returns
  `{ enabled: false }`, `{ enabled: true, settings }`, or `{ invalid: reason }` when `sandbox` is
  not an object, `enabled` is not a boolean, or a list holds a non-string.
- `runtimeConfig(settings, denyRules, cwd, home)`: pure function returning `SandboxRuntimeConfig`,
  following the tables above. Rules that are not `Read`/`Edit`/`Write` with a path are ignored.
- An invalid `sandbox` with `enabled` not explicitly `false` counts as on and unavailable, so a
  typo never switches the sandbox off.

### U2. `ext/sandbox/runtime.ts`: the per-process sandbox

- State, held with `sharedRef` so every extension instance in the process sees the same one:
  `{ kind: "off" }`, `{ kind: "ready" }`, or `{ kind: "unavailable", reason }`.
- `start(config, ask)`:
  - Native Windows: `unavailable`, "the sandbox needs macOS, Linux or WSL2; on Windows run pi in
    WSL2".
  - `!SandboxManager.isSupportedPlatform()`: `unavailable` with the platform name.
  - `SandboxManager.checkDependencies()` reports errors (for example bubblewrap or socat missing):
    `unavailable` with those errors and the install hint (`apt install bubblewrap socat`; on
    Ubuntu 24.04+ the AppArmor user-namespace setting, linked from the README).
  - Otherwise `SandboxManager.initialize(config, ask, true)` (log monitor on, for violations).
    A throw is `unavailable` with its message. Success is `ready`.
  - Already `ready` (a second `session_start` in the same process): `SandboxManager.updateConfig`.
- `stop()`: `SandboxManager.reset()`, state `off`.
- `wrapExec(exec)`: returns an `exec` with the same signature (`BashOperations["exec"]`):
  - `off`: calls `exec` unchanged.
  - `unavailable`: rejects with `Error("The sandbox is on but cannot run: <reason>")`. The command
    does not run.
  - `ready`: `commandId = randomUUID()`;
    `wrapped = await SandboxManager.wrapWithSandbox(command, shellPath, undefined, options.signal, { commandId, commandText: command })`;
    then `exec(wrapped, cwd, options)`. After it settles,
    `SandboxManager.annotateStderrWithSandboxFailures(commandId, "")` gives the violations seen
    while it ran (blocked paths and hosts); when that text is not empty it is appended to the
    output through `options.onData`. Then `SandboxManager.cleanupAfterCommand()`.
- Exec stays asynchronous. `srt`'s proxy runs on pi's event loop: a synchronous spawn starves it
  and every connection times out (seen in the prototype).

### U3. `ext/sandbox/index.ts`: the extension

- Registered in `package.json` right after `./ext/permissions/index.ts`, so a deny rule still
  blocks a call before the sandbox sees it.
- `session_start`: read settings and deny rules (`ext/_shared/settings.ts`). When on, build the
  config and `start()` it. When it ends `unavailable`, notify once:
  `Sandbox is on but cannot run: <reason>. The model's bash and monitor are refused.`
- `session_shutdown` with `reason: "quit"`: `stop()`. Background shells outlive `/new`,
  `/resume` and `/fork`, so any other shutdown keeps the sandbox, and the next `session_start`
  updates its config and network callback.
- `tool_call`: while the sandbox is not `off`, block `powershell` with
  `The sandbox is on and powershell does not run inside it; use bash.`
- Network ask callback, given to `start()`:
  - Answers cached per session, keyed `host:port`, both allow and deny.
  - Concurrent asks for the same key share one pending promise, so one dialog appears.
  - `ctx.hasUI` false: deny.
  - Otherwise `ctx.ui.confirm("Network access", "Allow the model's commands to reach <host>:<port> for this session?")`.

### U4. `ext/background-bash/index.ts`: one line

```ts
exec: wrapExec((command, cwd, options) => createLocalBashOperations({ shellPath }).exec(command, cwd, options)),
```

with `shellPath` passed through to `wrapWithSandbox`. This is the only path the model's `bash`
(foreground and `run_in_background`), `monitor` and subagent shells run through.

### U5. Dependency and docs

- `package.json`: `"dependencies": { "@anthropic-ai/sandbox-runtime": "0.0.81" }`. bluclawd has
  no `dependencies` yet; pi installs a git package's dependencies on install (`docs/packages.md`),
  so every machine that installs bluclawd gets `srt`.
- README, Permissions section: a Sandbox subsection with the settings, the platform table, the
  difference in `**/` anchoring, what runs outside the sandbox, and the Linux setup.

## Platforms

| Platform | Mechanism | Needs | When missing |
|---|---|---|---|
| macOS | Seatbelt (`sandbox-exec`) | Nothing | — |
| Linux, WSL2 | bubblewrap, socat, optional seccomp filter | `bubblewrap` and `socat` packages; on Ubuntu 24.04+ unprivileged user namespaces allowed by AppArmor | `unavailable` with the install hint |
| Native Windows | — | — | `unavailable`, "use WSL2" |
| Inside Docker | bubblewrap often cannot create namespaces | Privileged namespaces | `unavailable` |

## Outside the sandbox

- Commands the user types with `!`, from the terminal or the phone.
- pi's in-process tools (`read`, `grep`, `find`, `ls`, `edit`, `write`): governed by deny rules,
  including the folder-grep filter.
- MCP servers, other extensions, and pi itself.
- Credential masking and TLS inspection (`srt`'s `credentials` and `tlsTerminate`).

A program the model runs inside the sandbox cannot read a denied `.env` either, so an app that
loads `.env` at start fails under the sandbox. The user runs it with `!`.

## Testing

- `config.ts` (unit): rule-to-path table (relative, `**/`, `~/`, `//`, absolute), `Edit`/`Write`
  to `denyWrite`, non-path rules ignored, settings merged, invalid settings reported, project
  `sandbox` keys ignored.
- `runtime.ts` (unit, fake `SandboxManager`): `off` passes the command through unchanged; `ready`
  runs the wrapped command with the same cwd, env, signal and timeout; `unavailable` rejects and
  runs nothing; violations are appended; native Windows and failed dependency checks give
  `unavailable` with their reasons; a second start updates the config.
- `index.ts` (unit): `powershell` blocked only while the sandbox is on; one warning when
  unavailable; ask callback caching, one dialog for concurrent asks, deny without a UI.
- `registration.test.ts`: the new extension's event count.
- Integration with the real `srt`, skipped where the platform or its dependencies are missing:
  - `grep -r A .` in a folder holding `.env` prints the other file's line and not `.env`'s.
  - `echo x >> .env` in the working directory succeeds; writing to the home directory fails.
  - A host outside the allowlist, denied by the ask callback, fails with the proxy's 403.
