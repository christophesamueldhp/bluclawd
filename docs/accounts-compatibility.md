# Accounts compatibility and verification

Issue [#203](https://github.com/christophesamueldhp/bluclawd/issues/203) integrates
the chooser delivered by #197–#199. The bluclawd routes are `/accounts`,
`/accounts provider-id`, `/accounts --models`, and `/accounts --scoped`.
They share Accounts/Models navigation, provider/account labels, search and filters.
Login opens that provider's Models without selecting a model. Esc keeps a successful login.

Pi's `/login`, `/model`, `/scoped-models`, Ctrl+L model selector, and Ctrl+P model
cycling remain native. Bluclawd does not register those names or intercept those shortcuts
to delegate them. The chooser's Ctrl+P provider filter applies only inside its own dialog.

## Contracts and boundary

The chooser uses stock extension APIs:

| Operation | Contract |
| --- | --- |
| Entry and UI | `ExtensionAPI.registerCommand("accounts", …)`, `ctx.ui.custom`, `select`, `input`, `confirm`, `notify` |
| Provider discovery and authentication | `modelRegistry.getRegisteredProviderIds()`, `getProvider()`, provider-owned `auth.oauth` / `auth.apiKey` login methods |
| Model catalog and availability | `modelRegistry.getAll()`, `getAvailable()`, `refresh()` |
| Read-only scope and current selection | The current command's `ctx.scopedModels` and `ctx.model` |
| Explicit Active model selection | `ExtensionAPI.setModel()` |
| Mutation guards | `ctx.isIdle()` plus bluclawd's running background subagents, rechecked before mutation |

An empty effective scope means unrestricted available models on the checked host.
A nonempty scope retains unavailable members exposed in the public snapshot; missing
references cannot be reconstructed. Active model, Scoped membership, and Unavailable
are separate indicators. Show all changes only the view. No scope editing, default
model saving, competing scope store, or durable session/fork scope guarantee is added.
Every opening reads a fresh command context, including after native changes, `/reload`,
and session replacement. Credential refresh never silently substitutes a model.

The existing account vault shares pi's active `auth.json`, not per-session credentials.
The store obtains `FileAuthStorageBackend.withLockAsync()` from the host's shipped
`dist/core/auth-storage.js`, resolved with public `getPackageDir()`. That backend is a
version-sensitive packaged module, **not a root-exported extension API**. No host file
or runtime method is patched; compatibility of this existing locking dependency must
also be checked when maintaining bluclawd against a new pi release. Login uses public
provider authentication callbacks and pi settings for the device identity. Keys/codes
are masked, errors sanitized, and stored credentials remain owner-readable plaintext.

## Checked package set

Checked on 2026-11-11 (#291), macOS, Node 26.8.1:

- Stock published `@earendil-works/pi-coding-agent` **1.5.2** and every `@earendil-works/*` package
  it resolves, directly or through another: `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`,
  `pi-schema`, `pi-telemetry` and `pi-tui`, all **1.5.2**. pi 1.5.2 pins these exactly, so a plain
  `npm install` of it yields this set. `test/helpers/pi-host.ts` refuses a tree that resolves
  any other version, in the tests and in the package probe.
- A separate temporary npm installation, using published packages without source edits,
  a custom host build, private monkey-patches, or bluclawd development dependencies.
- A normal `pi install git:https://fixture.invalid/bluclawd/package` against a temporary
  Git snapshot of this checkout. A process-local Git URL rewrite supplies the local
  repository; pi itself performs the clone and production dependency installation.
  This verifies the installed layout and loader, not GitHub authentication or transport.
- All 18 manifest extensions load through the stock bundled CLI and SDK resource loader.
  The interactive Accounts smoke uses pi's supported package extension filter to select
  Accounts after loading the full manifest; agent view normally hands a real terminal
  to tmux and cannot own the injected terminal. No host or extension implementation is patched.

**Observed upstream installation limit (1.0.4 check, 2026-11-05):** a fresh `npm install
@earendil-works/pi-coding-agent@1.0.4` on the check date resolved its caret-ranged
sibling dependencies to **1.5.0**. Importing that mixed SDK failed before bluclawd
loaded: `pi-codemode/declarations` did not export `MCP_TYPESCRIPT_PREAMBLE`.
The bundled `pi --version` still returned 1.0.4. The consistent published 1.0.4
set was checked separately; this report does not certify the mixed set or pi 1.5.0.
Installing a consistent release set in a temporary test prefix does not change a user's host.

Future compatibility follows supported APIs and normal bluclawd maintenance. It is not
a promise against upstream breaking changes. No pi upgrade or upstream publication is
part of this change.

## Reproduce

Install the exact checked host into a disposable prefix (outside bluclawd):

```bash
npm install --ignore-scripts --prefix /tmp/bluclawd-stock-pi \
  @earendil-works/pi-coding-agent@1.5.2
node scripts/verify-accounts-package.ts \
  /tmp/bluclawd-stock-pi/node_modules/@earendil-works/pi-coding-agent
```

The probe snapshots tracked and nonignored new files, installs into temporary agent
storage, checks the absence of local pi/TypeScript, loads every manifest extension,
and drives real typed commands and keyboard input on `InteractiveMode` with a fake
provider and an injected terminal. It checks all four entry routes, explicit model
selection, native command/shortcut coexistence, scope membership/thinking values,
and unchanged settings bytes. Temporary package/auth/session/settings files are removed
afterwards. npm needs registry access for production dependencies; no real login is used.

Run the offline Accounts regressions and typecheck from the development checkout:

```bash
npx vitest run test/accounts-interactive.test.ts test/accounts-loading.test.ts \
  test/accounts.test.ts test/accounts-store.test.ts test/accounts-login.test.ts
npm run typecheck
npm test
```

The interactive suite uses temporary on-disk auth, session, global settings, and project
settings. It covers native scope changes/reload/session replacement, unavailable and
outside-scope models, login-to-Models, cancellation, provider isolation, and background
idleness guards. Store/login/non-TUI regressions retain OAuth refresh preservation,
atomic switching, inactive removal confirmation, masking, safe errors, and RPC switching.
This is fake-provider terminal evidence; live OAuth browser flows and real provider
network availability are not exercised.

## Results for #203

The isolated #203 checkout (starting at `e6f0c8c`, excluding concurrent remote/skills work)
passed 71 focused Accounts tests, typechecking, and all **2,117 tests in 142 files**
with no skips. The initial restricted full-suite run encountered failures and was
interrupted; rerunning with OS process/socket access completed successfully.
Standards and specification reviews found no actionable issues.

Revalidated for delivery on current-main base `624a48c`: lint, dead-code checking,
typechecking, all 71 focused Accounts tests, and **2,051 tests in 138 files** passed
with no skipped tests. The normal Git-package/terminal probe also passed again.
The different full-suite count reflects the intervening merged subagent changes.

The package probe passed on the consistent published 1.0.4 set checked on 2026-11-05.
A separate real-PTY stock bundled-CLI smoke, loading only the Accounts extension with
`-e` and temporary agent storage, opened `/accounts --models`, switched to Scoped with
Ctrl+S, navigated to Accounts with Tab, closed with Esc, and exited with native `/quit`.
It used no credentials and displayed the expected empty Models view. The mixed-version
SDK failure remains an installation limitation, not a passing compatibility result.

## Results for #291 (pi 1.5.2)

Checked 2026-11-11 on macOS, Node 26.8.1, tmux 3.6b, with the development dependencies at
pi-coding-agent, pi-ai and pi-tui **1.5.2** (one copy of every `@earendil-works/*` package, all 1.5.2):

- The package probe above passed against a fresh stock 1.5.2 prefix (7 `@earendil-works`
  packages, all 1.5.2): Git-package install, all 18 extensions loaded with no errors, four
  Accounts routes, explicit model selection, native commands and Ctrl+L, unchanged scope and
  settings. It refused a copy of that prefix with one package relabelled 1.5.0.
- `npm ci` from the lockfile installs one copy of each package, all 1.5.2.
- `npm run check` passed: lint (one pre-existing warning), dead code, typecheck, and
  **2,358 tests in 157 files**, none skipped. The real-pi panes record the version of the
  pi that asked the faux model; `test/pi-host.test.ts` asserts it is 1.5.2.
- Changes the bump needed: TypeBox's `Type`/`Static` now come from `typebox` (published
  pi-ai 1.5.2 no longer re-exports them); agent view's dimmed composer strips pi-tui 1.5.2's
  fake-cursor markers, which would otherwise draw a second cursor while renaming; test
  doubles gained `Terminal.setProgramStatus` and `ExecResult.truncated`; the vendored
  built-in command descriptions and the settings-key check follow 1.5.2.

Earlier passes on 1.0.4 are not evidence for 1.5.2. Not covered: Linux, live OAuth and real
provider networks.
