# Private Sandbox Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline in the existing feature checkout, task-by-task. Steps use checkbox syntax. The user already selected inline execution; do not ask for an execution method again. Do not execute this plan until its review is confirmed.

**Goal:** Produce a reproducible, reviewable private runtime candidate containing only the Mach-denial delta over the exact published0.0.81 baseline, without installing it into bluclawd.

**Architecture:** Acquire the approved exact source/archive into private storage, prove complete source-to-archive correspondence, and rebase the tested Mach change at source level. A fixed-purpose maintainer builder preserves the verified official payload/native assets and emits a hook-free private tarball plus provenance in private candidate storage. Actual artifact approval precedes every dependency installation and application manifest/lock change.

**Tech Stack:** Existing Node22.23.4, npm10.9.9, Bun1.4.2, locked upstream TypeScript/development dependencies, Git/tar and Node built-ins; Vitest for repository tests. No new dependency or toolchain install.

**Spec:** `docs/superpowers/specs/2026-10-26-private-sandbox-runtime-design.md` (approved design and exact source/archive intake; not an approved artifact).

## Global Constraints

- Preserve application `strict: false`, public Pi/SRT APIs, parent policy/lazy readers and `EXTENDED_SUBAGENTS_RELEASED = false`. No production orchestration, role activation or application dependency adoption in this plan.
- Official source: `https://github.com/anthropics/sandbox-runtime`, exact commit `c40cf14a65d025e3cd27f071f13a73c12b3b1f92`. No floating HEAD, guessed tag, automatic submodules/LFS/hooks/credential helper, or user Git configuration.
- Official archive: `https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.81.tgz`; integrity `sha512-bjHDu87gjIR7+Oxy9jPiK3v8CvSELCzfpXa3fjqfSKdvlZET2iF51xcXILWPayTpowB3xtZeQVf2JR916nVW/w==`.
- Intended private identity: `@anthropic-ai/sandbox-runtime@0.0.81-bluclawd.1`, `private: true`. This is NOT an Anthropic release. No registry publication, upstream contribution, commit, push or active Pi changes.
- Keep all old c66fb77 source, patches, private CI runtimes, red/green receipts and historical strict/stripped-cookie evidence. No installed `node_modules` patch, shared writable dependency/helper cache, postinstall patch or automatic deletion.
- Preserve original native payload bytes/modes. Do not distribute bluclawd's compiled inspector or build replacement Linux/Windows/Java helpers. No VM/Docker/sudo, bare Python, new interpreter or real Keychain item/search-list operation.
- No unreviewed dependency drift: only reuse independent copies of approved development dependencies if the aligned lock identity matches. Otherwise stop for separate approval.
- Package input/source/payload mismatch, unknown provenance, malformed paths, unavailable positive controls and failed reproducibility stop preparation. No success retries, skipped failures or relaxed original deadlines.

## Review Focus

1. **Same version, wrong source:** the known c66fb77 SOCKS/MITM change must not enter this artifact; require matching unpatched builds and allow only the Mach source delta (Tasks1–2).
2. **Corrupted/traversing archive or missing native asset:** verify SRI before extraction, reject unsafe entries, retain native bytes/executable modes and fail missing/changed assets (Tasks1/3).
3. **Install hook, identity or transitive drift:** private metadata must be unmistakable and hook-free while production dependency ranges/entry points/engine remain unchanged (Task3).
4. **Partial, mutable or non-reproducible candidate:** fail without overwriting prior output; two independent builds must yield the same bytes and external provenance must identify those bytes (Task3).
5. **Green source mistaken for installed acceptance:** distinguish real unpacked-artifact checks from installation/SDK acceptance; never edit parent dependencies or enable the feature while preparing a candidate (Tasks2–3 and the final approval gate).

## File Map and Execution State

- Create `scripts/build-private-sandbox-runtime.mjs`: maintainer-only builder/CLI, no network/install behavior.
- Create `test/private-sandbox-runtime.test.ts`: real filesystem/archive-integrity/delta/metadata tests using Node built-ins and the existing Vitest framework.
- Create private `W/artifact-probe.mjs` during verification: fixed public-API unpacked-artifact smoke/native probe, retained as evidence rather than a new runtime facility.
- Do not yet create the final application `vendor/sandbox-runtime/` payload, edit `package.json`/`package-lock.json`, or modify consumer code. Those are after actual artifact approval.
- Private state **W** is `<feature-checkout>/.superpowers/sdd/2026-10-24-configurable-subagents/private-runtime-preparation/`; choose it once, owner-only, and refuse existing unrelated state. Logs, detached source checkouts, baseline/candidate manifests, rebased patches, independent dependency copies and candidate builds live there, never in installed Pi directories.
- Retain the existing `progress.md` ledger. Private state/evidence is not a new project manifest. Record exact tool versions, input hashes and terminal exits per command.

## Task 1: Establish the Published Source/Archive Baseline

**Files:** Private `W/source/official/`, `W/downloads/`, `W/baseline-manifest.json`, input/integrity receipts. No repository product code.

**Produces:** `PublishedBaseline` record `{ sourceCommit, sourceTree, archiveUrl, archiveIntegrity, archiveSha256, packageMetadata, files: [{ path, sha256, mode }], distFiles: [{ path, sha256, mode }] }`; all paths inside manifests are package-relative, not personal paths. Expected sourceCommit is exactly the pin above. Record the verified tree after intake rather than inventing one.

- [x] **Step 1: Capture preservation inputs.** Verify original Mach6/draft11/harness7/parent14/historical3 hashes and empty indices. Record existing app/source HEADs; check the approved private runtime binary hashes. Expected: all existing receipts pass; app manifest/lock unchanged.
- [x] **Step 2: Acquire exact approved inputs.** Download only the fixed registry archive over HTTPS, no redirects/auth/user curl configuration, with finite transfer bounds. Intake only the exact official Git commit with scrubbed HOME/environment and `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_LFS_SKIP_SMUDGE=1`; disable hooks, credential helpers, fsmonitor, automatic maintenance/GC, redirects, non-HTTPS protocols, filters and submodule recursion. Use a new private Git directory/detached checkout; do not move retained source HEADs. Expected: fetch/rev-parse equals c40cf14…; `git fsck --strict --no-reflogs` succeeds. Inspect any AGENTS/contribution instructions before source work; run no package scripts on intake.
- [x] **Step 3: Verify before extraction.** Verify SHA-512 against the exact lock SRI, inspect package-member paths/types and reject absolute/parent traversal, links escaping the package, duplicates or unexpected special files. Extract only into a new private directory. Record complete inventory/modes and original metadata/native asset hashes. A one-byte-corrupted COPY must fail integrity and never reach extraction; preserve the valid input. Do not claim independently verified Sigstore signatures merely from decoded npm provenance.
- [x] **Step 4: Match the source lock and build.** Compare the aligned package/lock to retained approved development inputs. If lock identity differs, stop before any installer. Otherwise independently APFS-copy dependencies, use approved private Node22/Bun1.4 launchers, private HOME/short TMPDIR and the offline uv/CLT adapter. Invoke the existing locked TypeScript build explicitly, no prepare/prepublish hooks. Expected: baseline source/test typecheck and build pass.
- [x] **Step 5: Prove complete correspondence.** Compare source build `dist` file names/bytes with the verified archive; read-only reconnaissance suggests196 files, but actual archive inventory is the authority. Record build versus published modes separately: TypeScript/private umask and npm executable normalization are not source-code drift, and the final package must use original published modes. Require ZERO unexplained content/inventory differences, including the manager/SOCKS files previously mismatched at c66fb77. Verify upstream native assets/license/entry points come from the archive, not a JS-only rebuild. Write `W/baseline-manifest.json`; any mismatch blocks Task2/3 rather than authorizing generated-JS edits.

## Task 2: Rebase and Verify Only the Mach Delta

**Files:** Independent private `W/source/patched/`, rebased `W/mach-denial.patch`, `W/harness.patch`, `W/source-delta.json`, focused/broad/static receipts. No application production file.

**Consumes:** Task1 `PublishedBaseline`. **Produces:** `VerifiedSourceDelta` `{ sourceCommit, baselineTree, productionSourceFiles, sourceHashes, runtimeFileChanges: [{ path, beforeHash, afterHash, mode }], machPatchSha256, harnessPatchSha256, toolVersions, verification }`.

- [x] **Step 1: Prepare an independent source copy.** Copy the trusted private baseline checkout/Git metadata and dependency files independently, not shared/symlinked/hardlinked. Both private source HEADs remain c40cf14…. Check the frozen original patch before use. Apply/copy only its two tests and fixed C fixture first, preserving the original evidence. If patch context differs, port tests to the same public contract, not new implementation assumptions.
- [x] **Step 2: Observe real RED.** In the patched copy run `bun --no-env-file --no-install test test/sandbox/mach-lookup-config.test.ts test/sandbox/macos-mach-lookup-deny.test.ts` with the private CI toolchain. Expected: missing schema/propagation/native denial, while outside broker controls and compiler actually work. Missing prerequisites/startup errors are not a valid RED behavioral proof; stop or classify explicitly.
- [x] **Step 3: Port source-level behavior only.** Apply/rebase only `src/sandbox/{sandbox-config,sandbox-manager,macos-sandbox-utils}.ts`. Preserve all old exact-name validation, copied session/custom union, unsupported-backend/string/Windows-argv guards, no-sandbox-fast-path prevention and same-initial-profile precedence from the frozen patch. Add required prominent modification notices at source level so maps remain generated consistently. Do not add the c66fb77 getMitmSocketPath/SOCKS route or touch socks-proxy. Preserve original patch/source hashes; write the new portable rebased patch separately.
- [x] **Step 4: Verify GREEN and generated delta.** Repeat the same two suites; expected all30 defined cases pass with real native controls and no native skip (record actual counts if a justified rebase changes registration). Run aligned source/test typecheck, build, lint and formatting on touched files. Diff baseline/patched source and built output: runtime changes must be the three modules' JS/declarations/maps derived from the Mach delta/notices; unexpected code changes stop. Apply the separate harness patch for verification only; it must not alter packaged runtime behavior.
- [x] **Step 5: Run both audited broad comparisons serially.** Audit newly acquired tests before running them. Exclude `test/sandbox/macos-apple-events.test.ts` from the file inventory BEFORE discovery; keep Docker/Linux-privilege opt-ins inactive, Python via offline uv adapter, original deadlines. Run clean baseline then rebased candidate once each with the same Node22/Bun1.4 pair. Report every failure/error/skip and inventories; do not demand old c66fb77 totals or retry to obtain green. Only an explained passing applicable source gate permits artifact preparation. Produce `W/source-delta.json` and retain all red/green receipts.

## Task 3: Build and Verify a Reproducible Candidate (No Installation)

**Files:** Create the two repository files in File Map; create `W/artifact-probe.mjs`, `W/candidate-a/`, `W/candidate-b/`, package/provenance/diff/verification receipts. Candidate outputs remain private until artifact review.

**Interfaces:** Implement in `scripts/build-private-sandbox-runtime.mjs` (plain ESM, no new library dependency):

```ts
assertArchiveIntegrity(bytes: Uint8Array, expectedSRI: string): void;
assertArchiveMemberPaths(paths: readonly string[]): void;
privateRuntimeMetadata(basePackage: Record<string, unknown>): Record<string, unknown>;
inspectRuntimeDelta(baselineDir: string, patchedDir: string): Promise<readonly {
  path: string; beforeHash: string; afterHash: string; mode: number;
}[]>;
buildPrivateSandboxRuntime(options: {
  baseArchive: string; baselineDir: string; patchedDir: string;
  baselineManifest: string; sourceDelta: string;
  npmCli: string; outputDir: string;
}): Promise<{ tarball: string; provenance: string; sha256: string; integrity: string }>;
```

The CLI accepts only `--base-archive`, `--baseline`, `--patched`, `--baseline-manifest`, `--source-delta`, `--npm-cli`, `--output`. The two manifest paths consume Tasks1–2's records; validate their claims against fixed commit/SRI/source/output allowlists and actual file hashes, never treat metadata as authority to widen the permitted delta. `inspectRuntimeDelta` compares `dist/` and `vendor/` inventories/bytes/modes and rejects additions/deletions or changes outside the three Mach modules' JS/declarations/maps; use it both for source builds and official-versus-staged payloads. `privateRuntimeMetadata` performs the separately asserted manifest transformation. The CLI fixes the approved source commit/base SRI/private version internally, verifies actual inputs against Tasks1–2 (including clean baseline and source allowlist), and offers no flag to replace integrity/allowed behavior. Baseline and patched directories are trusted maintainer source checkouts, never worker authority. `npmCli` is the verified npm10.9.9 JS entry run by the exact Node22.23.4 process; wrong tools stop. Main-module guard prevents packing on import.

- [x] **Step 1: Write the failing focused tests.** Add named tests with these assertions: `rejects tampered base before writes` (integrity error/output absent); `rejects absolute,parent,duplicate and escaping member paths`; `rejects SOCKS/unlisted JS delta` (use real small directory fixtures); `rejects missing native asset or executable-mode drift`; `preserves production ranges, entry points, engine and authorship but removes hooks/devDependencies`; `rejects existing output without mutation`; `rejects CLI integrity override and import-time side effects`. Include literal expected paths/version/private flag; the metadata fixture contains the exact original four dependency ranges/main/types/bin/engine from the spec. Pin assertions such as:

```ts
expect(() => assertArchiveIntegrity(Buffer.from("tampered"), OFFICIAL_SRI)).toThrow(/integrity/i);
expect(() => assertArchiveMemberPaths(["package/../outside"])).toThrow(/unsafe/i);
expect(() => assertArchiveMemberPaths(["package/a", "package/a"])).toThrow(/duplicate|unsafe/i);
expect(privateRuntimeMetadata(basePackage)).toMatchObject({
  name: "@anthropic-ai/sandbox-runtime", version: "0.0.81-bluclawd.1", private: true,
});
expect(privateRuntimeMetadata(basePackage).scripts).toBeUndefined();
```

`OFFICIAL_SRI` is the literal base integrity in Global Constraints, not computed by the verifier under test. Fixture helper success is only component coverage, never official/native artifact proof.
- [x] **Step 2: Observe RED.** Run `npm test -- test/private-sandbox-runtime.test.ts`. Expected: missing builder/helper behavior, not missing Vitest/new dependency. Keep the existing application broker test red; do not alter it as part of packaging.
- [x] **Step 3: Implement the fixed builder.** Hash the base first; list/check paths before extracting with trusted system tar into a new private staging root; reject special/escaping entries and do not preserve unsafe set-id ownership. Compare baseline source/dist to approved manifest/archive; inspect only the three allowed Mach-source modules and their derived outputs. Stage the verified original package payload, overlay the reviewed generated delta while retaining each original published file mode (not the build workspace's umask-derived mode), and preserve all unchanged bytes/modes/native assets. Do not patch an installed package, source-map strings, generated profiles or unrelated manager code.
- [x] **Step 4: Produce explicit private metadata and pack.** Keep name/main/types/bin/engines and four production ranges unchanged; set version `0.0.81-bluclawd.1`, `private:true`, clearly label bluclawd modifications, preserve LICENSE/NOTICE, and remove `scripts`/`devDependencies`. Use an exact package file allowlist, adding `BLUCLAWD-NOTICE.txt`; exclude secrets, Git, node_modules, logs, temporary data and compiled probes/inspectors. Run the trusted npm CLI `pack --ignore-scripts --json` ONLY in staging. Output the named tarball and external `provenance.json`, rebased `mach-denial.patch`/`harness.patch`, full file/manifest/dependency/lifecycle diff and input/tool hashes. Never embed the archive's own final hash inside itself. Do not create application `vendor/` or modify a lockfile.
- [x] **Step 5: Verify component GREEN and real reproducibility.** Run the focused tests, `node --check scripts/build-private-sandbox-runtime.mjs`, application typecheck/lint/diff. Build from the REAL verified inputs into candidate-a then independently candidate-b using the exact same tools. Expected: byte-identical archives, matching SHA-256/SHA-512, identical relative payload inventories/native bytes/modes and hook-free metadata. Corrupt a COPY/drop an asset/change a mode/unlisted SOCKS JS/change an existing output and confirm the proper failure without replacing valid candidates. No test-only expected-integrity knob reaches CLI policy. Helpers may accept literal synthetic fixture hashes for unit coverage; the production CLI always supplies its fixed official SRI.
- [x] **Step 6: Create and execute the private unpacked-artifact probe without installing.** Implement `W/artifact-probe.mjs` and run `node --check` on it. Its fixed CLI accepts `--runtime-root <verified unpacked package>` and `--probe-source <verified rebased test/fixtures/mach-lookup.c>`. Use independent copies of already approved dependencies, not symlink/ancestor resolution or an installer; verify copied identities. Import only the package's public entry, check its private identity/public schema, and execute real wrapped fixed lookup/deallocation probes compiled locally with the existing trusted CLT/SDK. Require outside-before/after success, inside1100/1102 with meaningful positives, exact/wildcard precedence and observed successful child close; timeout/unavailable/startup error fails. No actual Keychain data, raw port values or inspector binary distribution. This is unpacked-artifact proof, NOT npm-install/complete-SDK/production support.
- [x] **Step 7: Run repository regressions and preserve limits.** Run focused builder/sandbox/subagent-reader suites, then full `npm test`, `npm run typecheck`, `npm run lint`, `node scripts/probe-extensions.ts`, `git diff --check`. Report actual counts and the retained broker failure on the unchanged installed runtime; it cannot be cleared by this plan. Validate all frozen source/draft/harness/application/historical hashes and empty indices. Record only author self-review if no independent reviewer is available. No staging/commit/cleanup.

## Final Handoff: Actual Artifact Approval, Not Adoption

- [x] Present candidate version/file/size, upstream commit/tree/URL/SRI, candidate SHA-256/SHA-512, complete payload/native preservation, manifest/dependency/lifecycle diff, baseline correspondence, source TDD/full results, two-build reproducibility, unpacked public/native probe and limitations. The user can inspect the exact archive, not a guessed future release.
- [x] STOP before dependency installation, copying the approved release payload into application `vendor/`, application manifest/lock changes, consumer integration or activation. Ask approval for the exact artifact and its bounded adoption scope. The earlier design/intake permission does not satisfy this gate.
- [ ] After that separate approval, continue the existing Mach supplement Tasks2–3 with the approved private identity: clean-copy installation first, locked portable Git/local package checks, then the existing application pin and fail-closed consumer/seven-tool/parent acceptance. Do not reimplement those tasks now, skip remaining original Task2b, or infer universal descendant drainage.

## Self-Review and Execution Handoff

Spec coverage: source/archive mismatch and native preservation belong to Task1; minimal source rebase/native and full verification to Task2; maintainer builder/metadata/no hooks/reproducibility/actual unpacked proof to Task3; exact artifact installation/adoption remains a separate gate. No undefined predecessor interface or new platform support is assumed.

Preserve the existing feature checkout and inline execution. This plan contains no authorized commit, submission or destructive operation. Request plan review, then execute task-by-task only after confirmation; stop at differing source lock requirements or any other explicit approval boundary.
