# Session switching and active-session deletion

Intent: switching away and back must not abort ongoing work; Agent View must allow deleting the current session. Deletion semantics should match the existing Agent View behavior (remove the row, preserve saved conversation) unless the user requests otherwise.

- [x] Explore existing switching, hand-off, deletion, Pi lifecycle, and recent changes.
- [x] Identify cause: Pi runtime replacement aborts the foreground; Agent View stops the background writer on open and adds a continuation prompt; self deletion is explicitly blocked.
- [x] Assess visual companion: not needed for this lifecycle decision.
- [x] Clarify acceptable switching semantics and present architecture alternatives (user selected approach 1: execution persists; only the view switches).
- [x] Obtain approval of the high-level approach and detailed architecture/compatibility limits (user: “gas”).
- [x] Write the design specification at `docs/superpowers/specs/2026-10-05-persistent-session-views-design.md`.
- [x] Review specification for completeness and consistency (initial snapshot, memory bounds, and custom-TUI compatibility made explicit).
- [x] Commit the design specification (`9fbec80`).
- [x] Obtain user review of the written specification.
- [x] Write and self-review `docs/superpowers/plans/2026-10-05-persistent-session-views.md` (11 sequential tasks; interfaces, regression cases, and verification commands).
- [x] Establish existing baseline: 38 test files / 397 tests pass; `npm run typecheck` exits 0. No product code changed.
- [x] Obtain user review of the implementation plan and execution-method selection (native recommended; no subagent tool available).
- [x] Implement regression tests and fixes.
- [x] Verify switching, cancellation, single-writer safety, active-session deletion, and existing tests.
