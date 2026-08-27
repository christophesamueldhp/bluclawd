# bluclawd

pi, plus a bluclawd extension layer. **Nothing in this branch modifies a file pi
owns** — `git diff upstream/main -- packages/ scripts/ *.json *.md` is empty, and
that is the property the whole design exists to keep. Merging upstream is a
fast-forward, not a conflict resolution.

## How it works

Three mechanisms, all of them pi's own:

| Need | pi's mechanism |
|---|---|
| Product identity (name, config dir, `~/.bluclawd/agent`) | `piConfig` in this directory's `package.json`, reached via the `PI_PACKAGE_DIR` env var |
| Compiled-in features | `main(argv, { extensionFactories })` — pi's documented embedder entry point |
| Everything a feature does | the `ExtensionAPI`: `registerCommand`, `registerTool`, `registerShortcut`, `appendEntry` + `registerEntryRenderer`, `setFooter`, `setWidget`, `switchSession`, … |

`bin.mjs` is the entry point. It points `PI_PACKAGE_DIR` at this directory so
`piConfig` is read from here, then hands control to pi.

## Why the symlinks

`PI_PACKAGE_DIR` decides two things at once in pi: where `piConfig` is read
from, *and* where bundled assets (themes, docs, examples) are looked up. Pointing
it here means pi looks for `./src/modes/interactive/theme/*.json` here too, so
`src`, `docs` and `examples` are symlinks back into `packages/coding-agent`.
A published bluclawd package would copy those in at build time instead.

## Running it

```bash
node --import tsx bluclawd/bin.mjs        # or: npx tsx bluclawd/bin.mjs
```

## What lives here

```
bluclawd/
  package.json     piConfig — the whole rebrand
  bin.mjs          entry point
  ext/
    index.ts       the extension list handed to main()
    commands/      slash commands
```

## What this layer deliberately cannot do

Recorded so nobody re-litigates it: pi's `registerCommand` has no alias field and
its `input` event fires only after the interactive command chain has run, so a
*hidden* command alias cannot be expressed at all. Commands here are their
canonical name only.
