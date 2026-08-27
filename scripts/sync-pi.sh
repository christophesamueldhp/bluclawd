#!/usr/bin/env bash
#
# Pull the latest pi and prove the bluclawd layer still stands on it.
#
# The merge itself is the easy half: this branch modifies no file pi owns, so a
# textual conflict is structurally impossible and `git merge` should always be a
# fast-forward or a trivial merge. The half that can actually break is invisible
# to git — the layer imports 16 pi modules that pi does not export publicly, so
# an upstream rename or signature change merges perfectly and then fails at
# typecheck or at runtime. That is what the checks after the merge are for.
#
# Usage:  bluclawd/scripts/sync-pi.sh [--check]
#           --check   report what is incoming and verify the invariant; merge nothing
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
fail() { printf "\033[31m✘ %s\033[0m\n" "$1" >&2; exit 1; }
ok()   { printf "\033[32m✔\033[0m %s\n" "$1"; }

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "pi-bluclawd" ]] || fail "run this on pi-bluclawd, not $branch"
[[ -z "$(git status --porcelain)" ]] || fail "working tree is dirty — commit or stash first"

bold "1. Fetching upstream"
git fetch upstream --quiet
incoming="$(git rev-list --count HEAD..upstream/main)"
if [[ "$incoming" == "0" ]]; then
	ok "already up to date with upstream/main"
else
	echo "  $incoming new commit(s):"
	git log --oneline --no-decorate HEAD..upstream/main | head -20 | sed 's/^/    /'
	[[ "$incoming" -gt 20 ]] && echo "    … and $((incoming - 20)) more"
fi

bold "2. The invariant: this branch owns no file pi owns"
# Compare against the merge base, not upstream/main — after upstream moves ahead,
# every file upstream changed would otherwise look like "ours".
base="$(git merge-base HEAD upstream/main)"
intruders="$(git diff --name-only "$base" HEAD -- . ':(exclude)bluclawd')"
if [[ -n "$intruders" ]]; then
	echo "$intruders" | sed 's/^/    /'
	fail "the layer has modified $(echo "$intruders" | wc -l | tr -d ' ') file(s) outside bluclawd/ — the whole design rests on this being empty"
fi
ok "no pi file modified"

if [[ "$CHECK_ONLY" == "1" ]]; then
	bold "3. --check: stopping before the merge"
	exit 0
fi

if [[ "$incoming" != "0" ]]; then
	bold "3. Merging"
	if ! git merge --no-edit upstream/main; then
		git merge --abort 2>/dev/null || true
		fail "merge conflicted — that should be impossible here; inspect before retrying"
	fi
	ok "merged with no conflicts"
else
	bold "3. Nothing to merge"
fi

bold "4. Does the layer still compile against the new pi?"
# The real test. An upstream rename merges cleanly and lands here.
if ! npx tsgo -p bluclawd --noEmit 2>&1 | grep -E "^bluclawd/" ; then
	ok "typecheck clean"
else
	fail "the layer no longer typechecks against pi — see the errors above"
fi

bold "5. Lint"
npx biome check bluclawd >/dev/null 2>&1 && ok "biome clean" || fail "biome findings in the layer"

bold "6. Do the extensions still load?"
# Catches a rename that typechecks but throws at registration time.
probe="$(./node_modules/.bin/tsx bluclawd/scripts/probe-extensions.ts 2>&1)"
echo "$probe" | grep -q "FACTORY THREW" && { echo "$probe" | grep "FACTORY THREW" | sed 's/^/    /'; fail "an extension factory threw"; }
ok "$(echo "$probe" | tail -1)"

bold "Done"
cat <<'NOTE'
  Static checks pass. They do NOT cover behaviour that only appears at runtime —
  start it once before trusting the sync:

    ./node_modules/.bin/tsx bluclawd/bin.mjs

  Look for: no "[Extension issues]" box at startup, the bluclawd banner and
  theme, and the permission mode badge in the footer.
NOTE
