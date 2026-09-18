Run a review/fix loop over the current work, with you as the loop's controller and final decision-maker.

Target, implementation request, round cap or review focus: $ARGUMENTS

1. If the request above asks for something to be built, first delegate it with the `task` tool to one `worker` (it starts from this conversation). If the current diff is already the target, start with review.
2. Each review round: call `task` with `tasks[]` — three `code-reviewer` children in parallel, each on one angle chosen from the change (usually correctness and security, tests, needless complexity; add performance, docs or user flow when the change calls for it). Tell them to inspect the repository and the current diff themselves (`git diff`), report only concrete issues the diff causes or makes reachable — each with source proof, a failing scenario or a contradicted contract — label them P0 (blocks merge), P1 (fix before release) or P2 (note only), and end with a merge verdict: BLOCK, OK, or OK with notes.
3. Merge their findings yourself: P0 blockers, and any product, scope or architecture decision that needs the user; P1 fixes worth doing now; P2 notes; feedback you are setting aside, with the reason. Do not apply suggestions blindly. If a finding needs a decision the user has not made, stop and ask before fixing.
4. If there are fixes worth doing now, delegate exactly those to one `worker`: keep the agreed scope, run focused checks, report changed files and the commands run with their results. Only one writer on the working tree at a time.
5. Run another round only when the fix changed something material. A follow-up round asks just three things: is each named finding resolved, did the fix introduce a new concrete defect nearby, do earlier P1/P2 notes still stand.

Stop when reviewers find no P0 and no P1 worth doing now, when what remains is optional or deferred, when a decision needs the user, or after 3 review rounds unless the request above sets another cap.

Finish by reading the final diff yourself, running or confirming the focused checks, and summarising: rounds run, fixes applied, checks and their results, what was deferred, and why the loop stopped.
