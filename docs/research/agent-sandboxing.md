# Confining a coding agent: how others sandbox, and what bluclawd lacks

This compares how coding agents confine what the model can do, which isolation technologies they rest on, and where bluclawd stands. Sources were read on 2026-11-25. Source code is cited at these commits: `openai/codex` `ebd0765`, `anthropic-experimental/sandbox-runtime` `0bbebed` (srt 0.0.83), `google-gemini/gemini-cli` `08e9a20`, and pi 1.5.2 as installed. Where a behaviour of srt matters to bluclawd, it was also checked in the vendored `0.0.81-bluclawd.4`. A bracketed number points into [Sources](#sources). "Unconfirmed" means no primary source was found for the claim.

## Short answer

No sandbox on a shared kernel guarantees confinement. Seatbelt, Landlock, seccomp and bubblewrap are enforced by the kernel, but only for the processes placed inside them. An escape needs a kernel bug or a channel the policy left open, such as an allowed Unix socket, Mach service or Apple Event [10]. Claude Code's own docs say its sandbox "is not a complete isolation boundary" [10].

The strongest practical option is a VM or microVM that holds the whole agent, with only the project mounted and egress through an allowlisting proxy [14][35]. That costs a VM boot or an always-on VM, Linux binaries only, and a mounted checkout (ADR-0001). Even then, the agent can still change the mounted project and leak whatever it can read to an allowed host [14].

The larger practical gap is scope, not strength. A sandbox around `bash` does not cover tools that run in the agent's own process. In bluclawd, those are pi's `read`, `edit`, `write`, `grep`, `find` and `ls`.

## Agents compared

| | Mechanism | Files by default | Read-only mode | In-process file tools confined | Network | Secret scrubbing | Protected config paths | Subagents | Platforms |
|---|---|---|---|---|---|---|---|---|---|
| **Codex CLI** | Seatbelt; bwrap + seccomp (Landlock is legacy) [1][3] | `workspace-write` in a git repo, else `read-only` [8] | `read-only` mode [7] | Yes. `apply_patch` writes go through a helper run under the same sandbox [4] | Off by default; managed proxy with allow/deny lists [6][8] | Opt-in `KEY`/`SECRET`/`TOKEN` filter, off by default [5] | `.git`, `.agents`, `.codex` (docs); also `.aws` (source) [2][8] | Inherit the parent's sandbox; an agent file cannot override it [9] | macOS, Linux, WSL2, Windows [7] |
| **Claude Code** | srt: Seatbelt or bwrap + seccomp, plus proxy [10][16] | cwd + temp writable; reads most of the machine [10] | Plan mode (a permission mode, not the sandbox) [12] | No. Gated by permission rules; wrap the whole process with `srt` to confine them [14] | Proxy, allowlist starts empty [10] | `sandbox.credentials` deny/mask, list only; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` [10] | Two lists: sandbox and permission system (below) [10][12] | Same process and sandbox; `tools`/`disallowedTools`; cannot gain `bypassPermissions` [10][13] | macOS, Linux, WSL2 [10] |
| **Gemini CLI** | Whole CLI relaunched in Seatbelt, Docker, Podman, gVisor or LXC [17] | Project writable, reads everywhere (`permissive-open`) [17][18] | None found; `strict-*` profiles also restrict reads [17] | Yes when on: the whole process is inside. Tool-level mode exists, off by default [17][18] | `*-proxied` profiles [17] | Unconfirmed | `~/.gemini` and credential files write-denied; project `.gemini/` not in that profile [18] | Not checked | macOS, Linux, Windows [17] |
| **Cursor** | Seatbelt; Landlock + seccomp; WSL2 on Windows [20][21] | Workspace read/write [20] | Unconfirmed | Unconfirmed [20] | Blocked, opened by `sandbox.json` [20] | Unconfirmed | `.git/config`, `.git/hooks`, `.vscode`, `.cursorignore`, most of `.cursor` [20][21] | Unconfirmed | macOS, Linux (kernel 6.2+) [20] |
| **OpenHands** | Docker; the agent server runs in the container [25] | What is mounted, `rw` by default in the example [25] | Mount mode only [25] | Yes, if they run in the agent server, as the docs imply (unconfirmed) [25] | Unconfirmed | Unconfirmed | Not applicable | Unconfirmed | Docker hosts |
| **Copilot coding agent** | Actions runner or cloud sandbox, plus a firewall [23] | The runner's checkout | Unconfirmed | Unconfirmed | Allowlist, for processes the agent's Bash tool starts [23] | Unconfirmed | Pushes only to its `copilot/` branch; workflows need approval [24] | Not applicable | GitHub-hosted |
| **bluclawd** | srt (vendored) around `bash` and `monitor` [36] | Orchestrator: off by default. Runs: worktree + temp [36] | No | No. Text deny rules only [36] | Proxy; asks once per host [36] | Runs: by name pattern. Orchestrator: list only [36] | `~/.pi/agent`, own sockets, srt's list [36] | Always sandboxed, own worktree, process lifetime contained [36] | macOS, Linux, WSL2 [36] |

Claude Code keeps two protected-path lists. The **sandbox list** covers `.claude` settings, skills, agents, commands, hooks and `.mcp.json` in the working directory and above. In the working directory only, it covers shell rc files, `.gitconfig`, `.vscode`, `.idea`, and `.git/hooks` and `.git/config`. It also covers files that would make the folder a bare repository, and most of `~/.claude` [10]. The **permission list** gates the file tools. It adds `.husky`, `.cargo`, `.devcontainer`, `.npmrc`, `.envrc`, `.pre-commit-config.yaml` and others, and allow rules cannot pre-approve them [12].

## Isolation technologies

| Technology | What it guarantees | Escape surface | Platform | Overhead |
|---|---|---|---|---|
| Seatbelt (`sandbox-exec`) | Kernel-enforced file, network and IPC policy for a process and its children [3][18] | Allowed Mach/XPC services, Apple Events, an allowed socket such as Docker's [10]. Does not limit process lifetime (ADR-0001). Undocumented SBPL | macOS; `sandbox-exec` is marked "DEPRECATED" in its man page [26] | No figure found |
| Landlock | Unprivileged, stackable filesystem rules; TCP bind/connect since ABI 4; abstract-socket and signal scoping since ABI 6 [27] | Coarse ioctl; rename/link and truncate uncontrollable on older ABIs [27]. Codex rejects its legacy Landlock path for filesystem-restricted policies, since it "cannot isolate app-server Unix sockets" [1] | Linux 5.13+ [27] | No figure found |
| seccomp-bpf | Syscall filtering. The kernel docs: "System call filtering isn't a sandbox" [28] | A filter that misses a syscall. Codex also blocks `io_uring` so socket rules cannot be bypassed [1] | Linux | No figure found |
| bubblewrap + user namespaces | Mount, PID, network and user namespaces. Strength "is entirely determined by the arguments passed" [29] | "Everything mounted into the sandbox can potentially be used to escalate privileges" [29]. Kernel bugs reachable from user namespaces (unconfirmed). Ubuntu's AppArmor can forbid them [10] | Linux | No figure found |
| Containers (Docker, Podman) | Namespaces + cgroups + dropped capabilities + a default seccomp allowlist [30][31] | Shared host kernel (not stated on the pages read). A mounted Docker socket gives control of the host [10][18] | Linux; VM-backed on macOS (unconfirmed) | No figure found |
| gVisor (`runsc`) | A user-space application kernel between the container and the host [32] | Bugs in the Sentry and Gofer. Smaller host-kernel surface [32] | Linux | "higher per-system call overhead"; poor for syscall-heavy loads [32] |
| microVM (Firecracker; Apple Containerization; Docker Sandboxes) | A separate guest kernel; Firecracker adds a jailer as "a second line of defense" [33][34][14] | The hypervisor, and whatever is shared or mounted | Firecracker: Linux KVM [33]. Containerization: Apple silicon, macOS 26 [34] | Firecracker: under 125 ms boot, under 5 MiB per VM [33]. Containerization: "sub-second start times" [34] |
| Virtualization.framework | Full VMs on macOS. Containerization is built on it [34] | Hypervisor and shared directories (unconfirmed) | macOS | Unconfirmed |

## Confinement parameters seen in the wild

| Parameter | Who offers it |
|---|---|
| Folder scope (writes to cwd) | Codex `workspace-write` [7]; Claude Code [10]; Gemini [17]; Cursor [20]; bluclawd [36] |
| Read scope (deny reads outside) | Codex per-path `none` [1]; Claude Code `denyRead` + `allowRead` [10]; Gemini `strict-*` [17]; Cursor `readBoundary` [20]; bluclawd `denyRead` [36] |
| Read-only mode | Codex `read-only` [7]; Claude Code plan mode, enforced by permissions, not the OS [12] |
| Writable roots | Codex `writable_roots` [7]; Claude Code `allowWrite` [10]; Gemini `--include-directories` [18]; bluclawd `allowWrite` [36] |
| Ignore file as boundary | Cursor: `.cursorignore` enforced by its sandbox per the blog, while its ignore-files page says terminal and MCP tools "cannot block access" [21][22]. Gemini's `.geminiignore` affects only tools that respect it [19]. None found for `.gitignore` itself |
| Network allowlist via proxy | Codex [6]; Claude Code [10]; Gemini `*-proxied` [17]; Cursor [20]; Copilot [23]; bluclawd [36] |
| Env scrubbing | Codex, opt-in [5]; Claude Code, list or `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` [10]; bluclawd runs, by pattern [36] |
| Credential masking | Claude Code / srt `mask` via TLS termination [10]; bluclawd passes it through [36] |
| Protected config paths | Codex [2]; Claude Code [10][12]; Gemini, home dir only [18]; Cursor [20]; bluclawd, agent dir only [36] |
| Process lifetime | Codex PID namespace [1]; bluclawd PID namespace and Seatbelt identity [36]; not found in the Claude Code pages read |
| Resource limits (CPU, memory) | Containers (cgroups) [30] and VMs; not found in any host sandbox read here |

On `.gitignore`: both Codex and srt deliberately search with ignore files turned off. Codex expands deny globs with `rg --files --hidden --no-ignore` [1]. srt's scan for protected names says "Ignore files (`.gitignore`, `.ignore`) do not hide anything from it" [16]. Claude Code borrows only gitignore's pattern syntax for its rules [11]. A `.gitignore` lists build output as well as secrets, so using it as a read boundary would hide `node_modules` and `dist` from the model.

## Best practice

1. **Put every tool inside the boundary, or check each tool against the same policy.** Codex runs `apply_patch` writes through a sandboxed helper process [4]. Claude Code tells unattended users to wrap the whole process, "so that file tools, MCP servers, and hooks are also inside the boundary" [14]. pi's own docs rank "built-in tools only" isolation as "narrower" [35].
2. **Deny writes to whatever the agent later loads as code or config.** "A command that could edit those files could grant itself permissions, or add a hook or MCP server that Claude Code runs outside the sandbox" [10]. Codex keeps `.git`, `.agents` and `.codex` read-only under writable roots [2].
3. **No allow rule may reopen those paths.** "If you add an `allowWrite` entry or an `Edit` allow rule that covers one of these paths, the protection still applies" [10]. Settings allow rules do not pre-approve protected-path writes [12].
4. **Deny before allow, and resolve symlinks both ways.** Rules are evaluated deny, then ask, then allow [11]. A deny matches if either the requested path or its target matches [11]. Compare paths case-insensitively on case-insensitive filesystems, as srt does in its own checks [16].
5. **Fail closed.** `sandbox.failIfUnavailable` refuses commands when the sandbox cannot start [10]. srt refuses a settings file it cannot parse [14]. Codex rejects bubblewrap on WSL1 rather than run unsandboxed [1].
6. **Filesystem and network isolation together.** Without network isolation, a compromised agent "could exfiltrate sensitive files like SSH keys" [10]. Broad domains such as `github.com` allow domain fronting [10].
7. **Unattended runs need a container, VM or whole-process sandbox, not a shell sandbox.** The per-command sandbox "is not sufficient for fully unattended runs" [14].
8. **Keep project settings from widening the policy.** Claude Code ignores repository `credentials` entries [10]. A Codex agent file cannot override `sandbox_mode` [9]. bluclawd reads the policy from global settings only [36].
9. **Keep credentials out rather than hiding them.** Do not mount host secrets. Prefer scoped, short-lived tokens [15][35].

## bluclawd gap analysis

Kept out of the repository until the gaps it names are fixed. ADR-0016 records what bluclawd will do.

## Sources

1. `openai/codex` `ebd0765`: `codex-rs/linux-sandbox/README.md`
2. `openai/codex` `ebd0765`: `codex-rs/protocol/src/permissions.rs` (`PROTECTED_METADATA_PATH_NAMES`, default read-only subpaths)
3. `openai/codex` `ebd0765`: `codex-rs/sandboxing/src/seatbelt.rs`, `seatbelt_base_policy.sbpl`
4. `openai/codex` `ebd0765`: `codex-rs/core/src/tools/runtimes/apply_patch.rs`, `exec-server/src/fs_sandbox.rs`, `exec-server/src/local_file_system.rs`, `file-system/src/lib.rs` (`should_write_into_sandbox`)
5. `openai/codex` `ebd0765`: `codex-rs/protocol/src/config_types.rs` (`ShellEnvironmentPolicy` and its default), `protocol/src/shell_environment.rs`
6. `openai/codex` `ebd0765`: `codex-rs/network-proxy/README.md`
7. https://learn.chatgpt.com/docs/sandboxing (redirected from developers.openai.com/codex/sandboxing)
8. https://learn.chatgpt.com/docs/agent-approvals-security
9. https://learn.chatgpt.com/docs/agent-configuration/subagents
10. https://code.claude.com/docs/en/sandboxing
11. https://code.claude.com/docs/en/permissions
12. https://code.claude.com/docs/en/permission-modes
13. https://code.claude.com/docs/en/sub-agents
14. https://code.claude.com/docs/en/sandbox-environments
15. https://code.claude.com/docs/en/devcontainer
16. `anthropic-experimental/sandbox-runtime` `0bbebed`: `README.md`, `src/sandbox/sandbox-utils.ts`. Checked against the vendored `node_modules/@anthropic-ai/sandbox-runtime` 0.0.81-bluclawd.4
17. `google-gemini/gemini-cli` `08e9a20`: `docs/cli/sandbox.md`
18. `google-gemini/gemini-cli` `08e9a20`: `packages/cli/src/utils/sandbox-macos-permissive-open.sb`, `packages/cli/src/config/settingsSchema.ts` (`toolSandboxing`)
19. `google-gemini/gemini-cli` `08e9a20`: `docs/cli/gemini-ignore.md`
20. https://cursor.com/docs/agent/security/run-modes
21. https://cursor.com/blog/agent-sandboxing (2026-02-18)
22. https://cursor.com/docs/context/ignore-files
23. https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall
24. https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations
25. https://docs.openhands.dev/openhands/usage/runtimes/docker
26. `sandbox-exec(1)`, macOS 27.2 man page
27. https://docs.kernel.org/userspace-api/landlock.html
28. https://docs.kernel.org/userspace-api/seccomp_filter.html
29. https://github.com/containers/bubblewrap/blob/main/README.md
30. https://docs.docker.com/engine/security/
31. https://docs.docker.com/engine/security/seccomp/
32. https://gvisor.dev/docs/
33. https://firecracker-microvm.github.io/
34. https://github.com/apple/containerization/blob/main/README.md
35. pi 1.5.2: `node_modules/@earendil-works/pi-coding-agent/docs/security.md`, `docs/configuration.md`
36. bluclawd `415f50e`: `README.md` (Permissions, Sandbox), `docs/sandbox-settings.md`, `ext/sandbox/config.ts`, ADR-0001, 0002, 0011, 0012, 0014
