# srt is a reproducible private build carried in the repository

bluclawd needs an srt change that upstream has not released: the network ask callback gets the requesting command's id (#26). Rather than wait for upstream or patch `node_modules` at install time, the repository carries `vendor/sandbox-runtime/anthropic-ai-sandbox-runtime-0.0.81-bluclawd.3.tgz`, built from the official `0.0.81` archive and source commit `c40cf14` by `scripts/build-private-sandbox-runtime.ts`, whose hash `provenance.json` records as `builderSha256`.

Builds up to `0.0.81-bluclawd.2` also carried Mach-lookup denial. Its only consumer was the historical isolated-execution policy, removed in #47, so `0.0.81-bluclawd.3` drops it (#67) and leaves `sandbox-config` and `macos-sandbox-utils` as upstream ships them.

The builder accepts only a pinned toolchain: Node 22.23.4 and npm 10.9.9 by hash, plus bun 1.4.2. It verifies:
- the official archive's integrity;
- that the unpatched source build matches the published `dist` byte for byte;
- that the only runtime change is in the approved modules;
- that official and patched broad test runs were recorded.

Its output and evidence are recorded in `provenance.json`, `command-id-ask.patch` and `harness.patch`.

## Considered Options

- **A private registry**: adds credentials and infrastructure for a single consumer.
- **A local source link or postinstall patch**: not portable, and it edits installed modules.

## Consequences

- Every new patch repeats the whole pipeline. The steps are recorded on #26, and the full original plan is in git history at `bd01d4b:docs/superpowers/plans/2026-10-26-private-sandbox-runtime.md`. The broad test runs need `rg` and a working `python3` on the scrubbed `PATH`, and a TMPDIR short enough for macOS's 104-byte Unix socket paths.
- The build is bluclawd-specific, not an Anthropic release. `BLUCLAWD-NOTICE.txt` in the package says so.
