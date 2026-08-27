# bluclawd

pi, plus a bluclawd extension layer. **Nothing on this branch modifies a file pi
owns.** `git diff upstream/main -- . ':(exclude)bluclawd'` is empty, and that is
the property the whole design exists to keep: merging upstream is a fast-forward,
not a conflict resolution.

Measured, not asserted — upstream moved mid-build and the merge into this branch
produced **0 conflicts**. The same upstream delta against the `bluclawd` fork
branch produces 23 conflicted files and 1,618 conflicted lines.

## How it works

Three mechanisms, all of them pi's own:

| Need | pi's mechanism |
|---|---|
| Product identity (name, `~/.bluclawd/agent`) | `piConfig` in this directory's `package.json`, reached via `PI_PACKAGE_DIR` |
| Compiled-in features | `main(argv, { extensionFactories })` — pi's documented embedder entry |
| What a feature does | `ExtensionAPI`: `registerCommand`, `registerTool`, `registerShortcut`, `appendEntry` + `registerEntryRenderer`, `ui.custom`, `setHeader`, `switchSession`, `resources_discover`, … |

`bin.mjs` is the entry point: it points `PI_PACKAGE_DIR` here so `piConfig` is
read from this package, translates the Claude Code `--output-format` alias, and
hands control to pi.

## What ships

```
bluclawd/
  package.json    piConfig — the whole rebrand
  bin.mjs         entry point + argv translation
  themes/         the bluclawd theme
  skills/         bundled skills (code-review, security-review, verify)
  daemon/         FleetView's session daemon
  ext/            the feature layer
    _shared/      settings readers/writers, process runner, job registry, doctor
```

18 extensions: `permissions`, `hooks`, `model-controls`, `statusline`, `memory`,
`checkpoints`, `subagents`, `web`, `mcp`, `sandbox`, `background-bash`,
`branding`, `diagnostics`, `diff`, `fleet`, `skills`, `help`, `commands`.

## Updating from pi

```bash
bluclawd/scripts/sync-pi.sh            # fetch, merge, verify
bluclawd/scripts/sync-pi.sh --check    # report what's incoming, merge nothing
```

The merge is the easy half — this branch owns no file pi owns, so a textual
conflict is structurally impossible and the script asserts that invariant before
touching anything.

The half that can actually break is invisible to git. The layer imports **36
symbols across 16 pi modules that pi does not export publicly** (config paths,
the `theme` object, `execCommand`, `openBrowser`, `BUILTIN_SLASH_COMMANDS`, the
keybindings table, …). An upstream rename there merges perfectly and fails
afterwards, so the script runs typecheck, lint and an extension-load probe after
the merge and refuses to call the sync good until they pass. Verified by
renaming a pi export on purpose: both the typecheck and the probe caught it.

Everything pi *does* export publicly comes through
`@earendil-works/pi-coding-agent` — 113 symbols — precisely so upstream is free
to rearrange its internals underneath.

## Running and checking it

```bash
./node_modules/.bin/tsx bluclawd/bin.mjs     # run it
npx tsgo -p bluclawd --noEmit                # typecheck the layer
npx biome check bluclawd                     # lint the layer
./node_modules/.bin/tsx bluclawd/scripts/probe-extensions.ts   # what each extension registers
```

The layer has **its own** tsconfig and biome config, and no place in pi's test
suite. pi's `tsconfig.json` and `biome.json` cover `packages/*` only, and adding
a path to either would edit a file pi owns. That is a real cost of the zero-edit
rule, not an oversight: bluclawd's gates must be run separately, and pi's own
gate may be red through no fault of this layer (a fresh upstream checkout has
~14 pre-existing tsgo errors from stale generated model catalogs).

`src`, `docs` and `examples` are symlinks back into `packages/coding-agent`.
`PI_PACKAGE_DIR` decides identity *and* bundled-asset lookup, so pi resolves
themes, docs and examples under this directory too; a published package copies
them in at build time instead. The symlinks are scaffolding for the in-repo
branch, not the shipping design.

## What this layer cannot do

Recorded so nobody re-litigates it. Each was found by running the thing, not by
reading the API:

- **Hidden command aliases are impossible.** `registerCommand` has no alias
  field, and pi's `input` event fires only after the interactive command chain.
  Commands here have their canonical name only, so the fork's `/bashes`,
  `/session`, `/cost`, `/hotkeys`, `/new`, `/quit`, `/settings`, `/name` aliases
  are gone. pi's own names are the ones that exist.
- **An extension cannot rebind a pi keybinding.** Permission-mode cycling is
  **Alt+M**, not Claude Code's Shift+Tab, which pi binds to
  `app.thinking.cycle`; pi refuses the registration and logs a conflict.
- **An extension cannot add a theme colour.** The `acceptEdits` badge uses
  `success` rather than the fork's `autoAccept` token.
- **An extension-contributed theme cannot be the startup theme.** pi resolves
  the configured theme before extensions contribute their paths, so it falls
  back to dark and prints "Theme not found" once; the branding extension
  re-applies it after discovery.
- **`newSession()` takes neither a directory nor a model**, so FleetView's "New
  session" panel says which part of the choice it could not honour.
- **`--input-format` and `--json-schema` cannot work from a wrapper** — they
  change how pi reads stdin and what it prints instead of running. They exit
  with an explanation rather than being accepted and ignored.

Deliberately not ported: **PDF input** (it would mean reimplementing four
provider wire formats behind `before_provider_request`, more fragile than either
keeping it in a fork or dropping it), **`/status`** (pi keeps its session summary
private behind `/session`; half of it under the same name is worse than none),
**`/usage`** (a provider-usage poller that only proves anything against live
credentials), and **the fork's footer additions** (`setFooter` replaces pi's
footer wholesale, so keeping git-change counts would mean re-owning the entire
footer forever).

Two files copy pi logic rather than calling it, because pi does not export it:
`ext/_shared/keybindings-config.ts` and `ext/diff/intra-line.ts`. Both say so,
and say what drifts if pi changes.
