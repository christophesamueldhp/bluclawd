# Sandbox settings

Every key of Anthropic's sandbox runtime (`srt`, `@anthropic-ai/sandbox-runtime` 0.0.81) that a
JSON file can hold, and how to set it for bluclawd. The README's
[Sandbox](../README.md#sandbox) section covers what the sandbox is for; `srt`'s own README
(`node_modules/@anthropic-ai/sandbox-runtime/README.md`) has the full detail of each key.

## Where settings go

Everything goes under `sandbox` in `~/.pi/agent/settings.json`. A project's `.pi/settings.json`
is ignored, so a repository cannot loosen the sandbox. The key names are `srt`'s, unchanged:
`srt`'s `network.deniedDomains` is `sandbox.network.deniedDomains`.

```json
{
  "sandbox": {
    "enabled": true,
    "network": { "allowedDomains": ["github.com"], "deniedDomains": ["*:22"] },
    "filesystem": { "denyRead": ["~/.ssh"], "allowRead": ["~/.ssh/known_hosts"] },
    "credentials": { "envVars": [{ "name": "OPENAI_API_KEY", "mode": "deny" }] }
  },
  "permissions": { "deny": ["Read(**/.env*)"] }
}
```

What bluclawd adds before it hands the config to `srt`:

| Key | bluclawd's part |
|---|---|
| `enabled` | bluclawd's own switch; not sent to `srt` |
| `network.allowedDomains` | Sent as written |
| `network.deniedDomains` | Empty when unset (`srt` requires the key) |
| `filesystem.denyRead` | Plus every `Read(<path>)` deny rule |
| `filesystem.denyWrite` | Plus every `Edit(<path>)` and `Write(<path>)` deny rule |
| `filesystem.allowWrite` | Plus the working directory and the temp directory |
| Everything else | Sent as written |

These four lists take strings only. bluclawd turns their paths absolute: `~/x` is under home,
and a relative path is under the working directory; a trailing `/` is dropped. `srt`'s `{ "path": …, "literal": true }`
form works in `filesystem.allowRead`, but not in these four lists. Paths in other keys
(`allowRead`, `credentials.files`) reach `srt` as written: `srt` expands `~`, and resolves a
relative path against pi's own working directory.

### Commands

- `/sandbox`: open a status/on/off menu (without a UI, show status).
- `/sandbox on` or `/sandbox off`: save `sandbox.enabled` globally, preserving all other
  settings, and apply it after the agent is idle. Restart existing background jobs; their
  sandbox mode does not change. Other running pi instances pick it up on reload or restart.
- `/sandbox status`: show the current runtime state and any startup failure, without writing settings.

The command changes only `enabled`; configure domains, filesystem rules and credentials in
`settings.json`. Enabling without a policy adds no deny rules or allowed domains. Unreadable
or malformed global settings are not overwritten. If activation fails, the setting stays on
and the model's shell commands remain blocked until the configuration is fixed or sandbox is disabled.

### When a change applies

- `/reload`, or a new session: the file and network lists, `credentials` deny entries, and most
  other keys.
- Only after quitting pi and starting it again: what `srt` reads when its proxy starts:
  `tlsTerminate`, `mitmProxy`, `parentProxy`, `httpProxyPort`, `socksProxyPort` and the
  request-filter keys (`allowPlaintextHeaderSet`, `stripResponseHeaders`, `refuseOpaqueTunnels`,
  `requireHostMatch`, `ambiguousRequestTarget`). bluclawd keeps the sandbox running across
  `/new`, `/resume`, `/fork` and `/reload`. If in doubt, quit and restart.

### A wrong setting

`srt`'s schema checks the whole config at every session start. A value it refuses, or a key it
does not know (for example `credential` instead of `credentials`), leaves the sandbox
unavailable: pi says why, naming the key, and the model's `bash` and `monitor` are refused until
it is fixed. A misspelled protection never just goes missing.

## Network

All traffic goes through `srt`'s proxy. A host in neither list makes pi ask once per host and
port per session (no UI: refused).

| Key | Value | What it does |
|---|---|---|
| `allowedDomains` | `string[]` | Hosts reachable without asking: `github.com`, `*.npmjs.org`, `api.example.com:443`. IPv6 in brackets: `[::1]:3000` |
| `deniedDomains` | `string[]` | Always refused, checked first. `"*"` refuses everything else, `"*:22"` refuses port 22 |
| `deniedDomainReasons` | `{entry: reason}` | What the model is told when that `deniedDomains` entry refuses: `{"*:22": "SSH is blocked; use an https remote"}` |
| `strictAllowlist` | boolean | A host outside `allowedDomains` is refused without asking: pi's network dialog never opens |
| `deniedResolvedAddresses` | `string[]` | IPs/CIDRs an allowed hostname must not resolve to, e.g. private ranges `["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]`. Loopback, link-local, cloud metadata and this machine's own addresses are refused already |
| `allowLocalBinding` | boolean | macOS: commands may listen on and reach local ports directly (dev servers). Linux: ignored, the sandbox has its own loopback |
| `allowUnixSockets` | `string[]` | macOS: Unix sockets allowed, e.g. `["/var/run/docker.sock"]`. Linux: ignored |
| `allowMachLookup` | `string[]` | macOS: extra XPC/Mach services, trailing `*` allowed, e.g. `["2BUA8C4S2C.com.1password.*"]` for the 1Password CLI |
| `httpProxyPort`, `socksProxyPort` | number | Use your own proxy on this port instead of `srt`'s. That proxy does the filtering, so pi's dialog no longer applies |
| `parentProxy` | `{ http?, https?, noProxy? }` | Send outbound traffic through a corporate proxy. Without it, `srt` uses its own `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` |
| `mitmProxy` | `{ socketPath, domains }` | Route these domains through a proxy on that Unix socket; the allow/deny lists still apply |

### TLS termination (experimental)

`tlsTerminate` makes `srt` decrypt HTTPS so it can inspect requests, and is required for
credential masking. Commands are given a trust bundle with `srt`'s CA in it.

| Key | Value | What it does |
|---|---|---|
| `tlsTerminate.caCertPath`, `caKeyPath` | path | Your own CA, both or neither. Without them a CA is made per session |
| `tlsTerminate.excludeDomains` | `string[]` | Not decrypted: hosts using client certificates (mTLS) or certificate pinning. Masked credentials are not injected there |
| `tlsTerminate.extraCaCertPaths` | `string[]` | Extra CA certificates for the trust bundle, e.g. an internal root |
| `tlsTerminate.maxTunnels` | 1–65536 | Tunnels decrypted at once (default 256) |
| `tlsTerminate.handshakeTimeoutMs` | 100–600000 | Handshake deadline (default 10000) |

`{ "tlsTerminate": {} }` turns it on with defaults. Go programs (`gh`, `gcloud`, `terraform`,
`kubectl`) on macOS may also need `enableWeakerNetworkIsolation`, see below.

Request filtering, valid only with a `filterRequest` callback (library code, not JSON, so it does
nothing from settings): `allowPlaintextHeaderSet`, `stripResponseHeaders`, `refuseOpaqueTunnels`,
`requireHostMatch`, `ambiguousRequestTarget` (`"refuse"`, `"asSpelled"`, `"normalize"`).

## Filesystem

| Key | Value | What it does |
|---|---|---|
| `denyRead` | paths | Not readable (plus `Read` deny rules) |
| `allowRead` | paths | Readable again inside a `denyRead` area; wins over `denyRead`. E.g. deny `~/.ssh`, allow `~/.ssh/known_hosts` |
| `allowWrite` | paths | Writable (plus the working directory and temp) |
| `denyWrite` | paths | Not writable even inside `allowWrite`; wins over `allowWrite` |
| `allowGitConfig` | boolean | Commands may write `.git/config` (e.g. `git remote set-url`); `.git/hooks` stays protected |

Paths take globs: `*`, `**`, `?`, `[abc]`. On Linux, `allowWrite`/`denyWrite` take literal paths
only (a trailing `/**` is dropped), and a read glob whose first component is a wildcard
(`/**/*.pem`) is skipped and hides nothing. bluclawd makes its four lists absolute, which avoids
that for them.

Always protected from writes, even inside the project: shell rc files (`.bashrc`, `.zshrc`,
`.profile`, …), `.gitconfig`, `.gitmodules`, `.ripgreprc`, `.mcp.json`, `.git/hooks`,
`.git/config`, `.vscode`, `.idea`, `.claude/commands`, `.claude/agents`.

## Credentials

Keep secrets out of what the model's commands can see. Only the entries listed are affected.

```json
"credentials": {
  "envVars": [
    { "name": "OPENAI_API_KEY", "mode": "deny" },
    { "name": "GITHUB_TOKEN", "mode": "mask", "injectHosts": ["api.github.com"] }
  ],
  "files": [{ "path": "~/.config/gh/hosts.yml", "mode": "deny" }]
}
```

- `mode: "deny"`: the command does not see the variable, or cannot read the file.
- `mode: "mask"`: the command sees a placeholder. On the way out to `injectHosts` (default: every
  host in `allowedDomains`), `srt`'s proxy swaps in the real value, so a tool can use a key the
  model never sees. Needs `network.tlsTerminate`, and every `injectHosts` entry must be covered by
  `allowedDomains`. Files are masked on Linux only; macOS and Windows deny a masked file instead.

| Key in an entry | Value | What it does |
|---|---|---|
| `name` (envVars) / `path` (files) | string | The variable, or the file or directory. `path` takes `~` and globs, not the `literal` form |
| `mode` | `"deny"`, `"mask"` | As above |
| `injectHosts` | `string[]` | Where the real value may go (mask only) |
| `extract` | regex | Mask only capture group 1 of each match and keep the rest, e.g. `"API_KEY=(\\S+)"` (mask only) |
| `decode` | `"jwt"` | Find JWTs and mask them as JWTs, so tools that parse the token keep working (mask only) |
| `maskClaims` | `string[]` | With `decode`: mask only these claims of the token (mask only) |
| `maskDuplicates` | boolean | Also mask the same value where `extract` does not reach, e.g. in a comment (mask only) |
| `onExtractNoMatch` | `"warn"`, `"deny"`, `"error"` | When `extract`/`decode` finds nothing: warn and leave it readable (default), deny it, or refuse to run (mask only) |

Other keys of `credentials`:

| Key | Value | What it does |
|---|---|---|
| `allowPlaintextInject` | boolean | Inject masked values over plain HTTP too. For test setups only |
| `awsPairs` | `[{ accessKeyIdVar, secretAccessKeyVar, sessionTokenVar? }]` | Masked AWS keys with non-standard names, so the proxy can re-sign requests. `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` pair on their own |
| `sigv4` | `{ streaming?, presigned?, sigv4a? }`, each `"deny"` or `"passthrough"` | AWS requests the proxy cannot re-sign (default `"deny"`) |

A `.env` file is better kept out entirely with `Read(**/.env*)`: a program that loads it then
fails in the sandbox; run it yourself with `!`.

## Other

| Key | Value | What it does |
|---|---|---|
| `ignoreViolations` | `{ "<command pattern>": [paths] }` | Leave these out of the `<sandbox_violations>` report; `"*"` matches every command. Access is still refused |
| `git.safeDirectories` | `string[]` | Directories git treats as `safe.directory` inside the sandbox; grants no writes |
| `allowPty` | boolean | macOS: commands may open a pseudo-terminal |
| `mandatoryDenySearchDepth` | 1–10 | Linux: how deep under the working directory the always-protected names are looked for (default 3) |
| `ripgrep` | `{ command, args?, argv0? }` | Linux: how `srt` runs ripgrep (default `{ "command": "rg" }`) |
| `bwrapPath`, `socatPath` | absolute path | Linux: these binaries instead of the ones on `PATH` |
| `seccomp` | `{ applyPath?, argv0? }` | Linux: a different `apply-seccomp` binary |
| `javaAgentJarPath` | absolute path | The JVM proxy agent, only for a repackaged `srt` |
| `windows` | object | Native Windows only, which bluclawd does not run on |

## Keys that weaken the sandbox

Each of these reopens something the sandbox otherwise closes. Turn one on only for a reason.

| Key | What it gives up |
|---|---|
| `filesystem.disabled: true` | Every file rule, including the deny rules' paths, `credentials.files` and the always-protected names. `.env` becomes readable |
| `network.allowAllUnixSockets: true` | All Unix sockets (a Docker socket gives full control of the machine). On Linux, VM sockets too |
| `allowAppleEvents: true` | macOS: commands can launch other apps with `open` and script them; those apps run outside the sandbox |
| `enableWeakerNetworkIsolation: true` | macOS: access to `com.apple.trustd.agent`, a possible way to send data out |
| `enableWeakerNestedSandbox: true` | A weaker sandbox, for running inside Docker |
| `allowNestedUserNamespaces: true` | Linux: commands can create their own user namespaces; `denyWrite` and the always-protected names no longer hold against them |
| `network.httpProxyPort`, `socksProxyPort` | Network filtering moves to your proxy |
