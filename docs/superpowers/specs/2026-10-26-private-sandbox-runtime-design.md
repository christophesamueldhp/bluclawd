# Private Sandbox Runtime for bluclawd

> **Historical scope (2026-10-27):** The user selected shared-workspace subagents with inherited parent authority, orchestrator-selected roles/models/thinking, no child-specific quotas, and two-way messaging. See the [replacement design](2026-10-27-shared-workspace-subagents-design.md), pending written-design approval and implementation. Earlier status/approval statements below describe that historical work, not current runtime requirements. All source/proof work is committed and consolidated into local `main`; failures remain failures. Do not resume this plan's superseded isolation gates.

**Status:** The user explicitly approved feature-checkout adoption of candidate SHA256 `ddf8a36fbe486a3e0465764c56d644740fb69c8ab2da464a93c669d70c2f3229` and the planned Mach consumer. The repository-carried runtime and lazy fail-closed/fixed isolated policy are implemented and verified. No commit, publication, active Pi change or feature activation is approved.

## Intent and Scope

Ship the already tested Mach-lookup denial capability as an identifiable, reproducible bluclawd dependency, without waiting for an upstream release or modifying installed `node_modules`. This is a dependency-distribution prerequisite for configurable subagents, not a new sandbox implementation.

Retain the existing `@anthropic-ai/sandbox-runtime` import, its public API and default parent behavior. Only isolated execution will request the fixed broker denials through the separately approved consumer work. Keep `EXTENDED_SUBAGENTS_RELEASED = false`; original Task 2b and Tasks 3–6 remain mandatory.

This approved design narrowly amends Gate B in `../plans/2026-10-24-subagent-mach-denial.md`: an explicitly reviewed private artifact may replace the normal-release-only route. Actual artifact approval remains separate from source/design approval.

## Approaches and Ownership of Decisions

1. **Repository-carried npm tarball — recommended implementation.** Fits current Git/local Pi installation, needs no registry account and carries an immutable artifact into fresh clones. It adds a small binary artifact and ongoing fork maintenance to this repository. It is a bluclawd-specific build, not confidential from people who obtain the repository.
2. **Private registry.** Better for confidential distribution or many consuming applications, but adds credentials, registry infrastructure and publication outside the requested scope. Not selected.
3. **Local source link or install-time patch.** Rejected: an ignored development directory is not portable; editing installed modules/postinstall patching violates the existing constraints.

The user selected the private direction and approved this repository-tarball design. The layout/version below identify the intended design, not an approved, already-produced artifact. No upstream submission or external publication is included.

## Inputs and Provenance

- Base artifact: the exact official `@anthropic-ai/sandbox-runtime@0.0.81` tarball already identified by the application lockfile:
  `https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.81.tgz`.
- Required base integrity:
  `sha512-bjHDu87gjIR7+Oxy9jPiK3v8CvSELCzfpXa3fjqfSKdvlZET2iF51xcXILWPayTpowB3xtZeQVf2JR916nVW/w==`.
- Tested source reference: official commit `c66fb77b28fdbea8b9788aca72377238ae67ca20`, tree `105cdb6a28ba5087c5a7a5bc900062b102512aad`. This is NOT the source identity claimed by the published archive's provenance.
- Aligned official source: `c40cf14a65d025e3cd27f071f13a73c12b3b1f92`, tree `8b0c1f68ab58235d56bdac8db5d70ad7db6fef6d`, now acquired with fsck clean. Its unpatched build matches all196 official archived dist files, with zero missing/extra/content differences. The npm SLSA metadata for tag `v0.0.81` names this commit and its subject SHA-512 matches the lock. The Sigstore signature/chain has NOT been independently verified.
- Functional delta: only the frozen Mach patch's behavior, with its three production source files, two tests and fixed lookup-only C fixture. Rebase that delta at source level onto the proven published baseline if necessary; retain the original frozen patch/evidence unchanged. The separate frozen harness patch is verification input, not additional runtime functionality.
- Build tools: the verified private Node `22.23.4`, bundled npm `10.9.9`, Bun `1.4.2` for tests, and the aligned source's locked TypeScript/development dependencies. Reuse previously approved development dependencies only if their lock identity matches; differing requirements stop for separate dependency approval. No toolchain or dependency auto-install.

A source manifest saying `0.0.81` does not prove equivalence to the published artifact. Read-only reconnaissance confirms the inventories have the same 196 built files, but only 189 are byte-identical between clean c66fb77 output and the installed normal package. Seven files differ: manager JS/source/declaration maps and SOCKS proxy JS/declarations/maps. The real JS difference adds SOCKS-to-MITM routing and a corresponding manager option, unrelated to Mach denial. This is NOT a formatting-only difference, and the installed tree is not a substitute for a verified archive.

Before creating the private payload, verify the official archive and resolve its exact source provenance. The proposed source-intake permission is limited to the exact `c40cf14a65d025e3cd27f071f13a73c12b3b1f92` official revision and the integrity-pinned `0.0.81` archive above; this intake was approved with the design and will run only after implementation-plan review. Use the prior hardened HTTPS/no-hooks/no-credentials/no-submodules intake procedure, verify the revision/tree, and never fetch floating HEAD or guess a tag. A provenance metadata claim is not independently verified signing evidence or sufficient code correspondence by itself. Establish a clean build matching the complete published built inventory, then port ONLY the Mach source delta without that unrelated SOCKS change. Re-run schema/native cases and the audited non-GUI baseline/candidate comparison on the aligned source. Preserve native assets byte-for-byte from the verified archive. If source alignment cannot be established, stop for a decision; do not rewrite generated JS, silently add the unrelated change, or substitute a whole source build.

## Package and Repository Shape

Prepared candidate internal version: **`0.0.81-bluclawd.1`**, explicitly not an Anthropic release. Preserve the package name for existing imports; set `private: true` to prevent accidental npm publication and prominently identify the modified build and changed files.

Proposed files:

- `vendor/sandbox-runtime/anthropic-ai-sandbox-runtime-0.0.81-bluclawd.1.tgz`: the immutable dependency artifact.
- `vendor/sandbox-runtime/provenance.json`: upstream URL/integrity/revision, patch/source hashes, tool versions, payload inventory, allowed differences and final artifact SHA-256/SHA-512. The final artifact hash belongs outside the archive, avoiding a self-referential hash.
- `vendor/sandbox-runtime/mach-denial.patch` and `harness.patch`: portable maintenance/verification inputs, with no private workspace paths or raw logs.
- `scripts/build-private-sandbox-runtime.mjs`: one fixed-purpose, maintainer-only builder using trusted local inputs and Node built-ins, not an install hook or general package framework. It verifies inputs before writing to a new private staging directory. It must not fetch/install tools, publish, modify the application lockfile or overwrite an existing differently hashed artifact.

After actual artifact approval, the existing dependency becomes:

```json
"@anthropic-ai/sandbox-runtime": "file:vendor/sandbox-runtime/anthropic-ai-sandbox-runtime-0.0.81-bluclawd.1.tgz"
```

Commit no package automatically. The tarball must be present in the Git/local distribution; no ignored scratch paths, absolute paths, source-directory symlinks or registry authentication may be required. This design targets the existing Git/local installation workflow, not an untested npm-publication workflow for bluclawd itself. Other transitive dependencies still resolve normally from the application lockfile; this is not a fully offline installation promise.

## Payload Rules

Start from a verified official archive in a new staging directory, never from the application's installed package. Replace only the compiled Mach-change modules and their derived public declarations/source maps, with a reviewed file-level diff. Any unrelated JavaScript behavior change blocks adoption. Required modification notices must be explicit and source maps consistent with their generated files.

Preserve unchanged upstream payload bytes and executable modes, including Linux seccomp helpers, Windows executables and the Java agent JAR. The source checkout contains their build scripts but not all published binaries: a JS-only pack would silently remove existing capabilities. Do not rebuild/download substitute native helpers or bundle bluclawd's locally compiled inspector. Preserving native payload does not establish new platform acceptance.

Preserve upstream authorship, LICENSE and any NOTICE requirements. Retain the existing four production dependency ranges, package entry points, CLI mapping and Node engine requirement. Remove packaged lifecycle/build scripts and development dependencies; enumerate these manifest changes explicitly in the artifact review. The Pi installer currently invokes production dependency installation without universally supplying `--ignore-scripts`, so the runtime package itself must not require an install hook. No `preinstall`, `install`, `postinstall` or `prepare` hook is allowed in the private artifact.

Use an explicit pack allowlist. Exclude `node_modules`, Git metadata, environment/config secrets, transcripts, raw test logs, private paths, temporary files and compiled test/inspector binaries. Never run `npm pack` at the bluclawd root, which also contains private development evidence. `npm pack --ignore-scripts` in the dedicated staging directory creates a local archive only; it does not authorize publication.

The same reviewed inputs/tool versions must reproduce the same archive bytes. Verify this using two independent staging builds. Every subsequent payload change requires a new private version and artifact review; do not replace different bytes behind an approved filename.

## Approval and Verification Stages

1. **Design/plan approval:** resolve the known source/archive correspondence prerequisite, preserving any separate source-intake approval. Only after alignment and source-level rebase verification, prepare the maintainer builder and a candidate archive in isolated storage. Review integrity, member paths/modes, exact baseline/native payload preservation, production dependency graph, hooks, provenance/license and reproducibility. No application manifest/lock edit or package installation is implied by this stage.
2. **Actual artifact approval:** present the concrete archive identity, size, hashes, full payload/manifest/dependency/lifecycle diff and verification evidence. Stop before any dependency installation or application pin until the user approves that exact artifact.
3. **Isolated installation and adoption:** first install the approved artifact in a separate clean verification copy with `--ignore-scripts`, keeping all unrelated dependency resolutions fixed. Demonstrate portable Git/local package resolution and no hooks/toolchain downloads; do not touch the active Pi installation or user settings. Refuse unreviewed transitive drift or missing native assets. Only then update the existing application dependency/lock to that approved identity under the granted adoption scope.
4. **Consumer and native acceptance:** execute the existing Mach supplement Tasks 2–3: fail-closed public-schema preflight, fixed isolated policy, actual seven-tool execution, meaningful broker controls, exact/wildcard precedence and simultaneous parent work. A version/hash or retained schema alone is not behavioral proof. Retain the existing broker regression until real installed behavior makes it pass.

Regression checks include source/test typecheck, artifact public JS/types, parent sandbox/configuration tests, legacy readers without compiler/native support, fresh-install/lock-integrity cases, missing/tampered artifact failures, and the full bluclawd/static/wiring suite. Check legacy parent behavior because both the parent extension and isolated host import this dependency; do not silently narrow its replacement to only a test host.

Existing evidence supports macOS arm64 non-GUI source verification: baseline/harness 3,404 passed and combined 3,434 passed, each 1,178 skipped/zero failed under the CI runtime pair. Historical evidence alone does not certify the newly aligned/rebased source or prepared artifact; their receipts are separate. GUI behavior, Linux/Windows/Intel, exact Node22.12.0, universal descendant cleanup and production readiness remain uncertified.

## Non-goals and Stop Conditions

No upstream contribution, registry publication, new sandbox engine, private consumer API, generated-profile rewriting, second-profile workaround, real Keychain item/search-list operation, new native inspector distribution, new role/environment bypass, weakening of filesystem/network rules, automatic apply/rollback, commit/push, global upgrade, release activation or old-evidence/workspace deletion.

Keep trust/permission checks, lazy legacy readers, session/generation/branch ownership, accounting, tracked-drain requirements, best-effort descendant disclosures, task/remote controls and checkpoints unchanged. Never infer completed Task 2b from packaging or credential acceptance alone.

Stop for unexpected source/artifact mismatch, dependency drift, incomplete payload, failed native positive controls, tampering, non-reproducible archives or unavailable prerequisites. Retain failures and workspaces; do not manufacture green through retries, skips, relaxed deadlines or replacing the artifact under test.

**Approved scope:** this design, exact official archive/source intake, candidate preparation, isolated installation, and the user's subsequent explicit dependency-adoption/consumer request. Feature-checkout vendor/dependency changes use only this approved artifact; active Pi/settings changes, commit, submission and activation remain unauthorized.

**Adoption/consumer verification:** Normal offline npm11/private Node22 installation changed exactly one package;173 other installed slots and all unrelated lock metadata stay identical. Public-schema preflight rejects stripped/rejected/changed/malformed arrays before workspace filesystem work, after policy branding, and runs lazily without process work. Only isolated configs request the fixed two brokers. A sparse-array bypass found during author review was reproduced RED and fixed with dense required-tuple iteration. Final focused81/81; full1310/1310 across110 files on BOTH host Node26 and private Node22; types,230-file lint, fixture syntax and12-extension/10-command wiring pass. The original broker oracle/fixtures were not changed. A single Biome scanner force-ignore for already Git-ignored .superpowers avoids nested verification-copy config discovery; product includes/rules stay unchanged and a product-path negative still fails lint. Supplement Task3 strict SDK/concurrent-parent coverage and remaining original Task2b lifecycle/targeting gates still remain; not production activation. See private mach-consumer-adoption/evidence.json.

**Isolated installation:** Node22.23.4 with already-installed npm11.19.0, private configs/caches and `--ignore-scripts`;174 packages,231 lock slots, zero unrelated lock-entry drift. npm10 output was rejected because it removed six libc selectors. Two independent clean installations preserve all208 payload hashes/native modes; npm's single declared CLI-bin0644→0755 adjustment matches the official installed baseline. Relocation succeeds offline without cached artifact content; missing/corrupt local artifacts fail ENOENT/EINTEGRITY. Installed public types and six native cases on each install pass. Focused113/113, typecheck/lint/wiring pass; full1293pass/1fail remains at the unchanged consumer broker assertion because it does not request denyMachLookup. No complete SDK/lifecycle/production acceptance claimed. See private `install-verification/evidence.json`; raw initial long-TMP/Git-environment failures are retained separately.

**Prepared artifact:** `anthropic-ai-sandbox-runtime-0.0.81-bluclawd.1.tgz`, 4,837,642 bytes, SHA256 `ddf8a36fbe486a3e0465764c56d644740fb69c8ab2da464a93c669d70c2f3229`. Final private candidate-c/d archives AND external provenance are byte-identical.208 payload files retain official native bytes/modes/license;11 generated Mach-only changes, explicit private metadata, no scripts/devDependencies. Source/native tests30/30; aligned non-GUI baseline3395 and candidate3425 passed,1178 existing skips each. Unpacked public types/native controls pass; no npm installation/complete SDK acceptance claimed. Pre-adoption UTF-8 app regression1293 passed/1 retained broker failure on unchanged installed0.0.81; forced C also exposes two unchanged tmux timestamp failures (paired UTF-8 control passes).

**Review limitation:** no independent reviewer/subagent tool is available. The author performs the builder-question pass and discloses it as self-review only. Preparation used author self-review, including a RED/GREEN correction to external source/builder provenance. This is not independent review or approval of the actual tarball or a commit.
