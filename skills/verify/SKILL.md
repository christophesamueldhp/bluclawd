---
name: verify
description: Verify that a change actually works by exercising it end-to-end — run the affected flow, not just the type checker. Use before claiming work is done, committing, or opening a PR.
---

# Verify

Prove the change works by observing real behavior. Type checks and green unit tests are necessary but not sufficient — drive the affected code path itself.

## 1. Identify what changed

```bash
git status --short && git diff --stat
```

List the behaviors the diff is supposed to change or add. Each one needs direct evidence.

## 2. Run the narrowest real check first

- Library/module change → run its test file, then add a focused test if none covers the new behavior.
- CLI change → invoke the actual command with representative arguments and inspect stdout/stderr/exit code.
- Server/endpooint change → start it and hit the endpoint (curl or test client) with a realistic payload.
- UI/TUI change → launch the app and walk the affected interaction; capture the output or a snapshot.

Use temp dirs/fixtures so verification is repeatable and leaves no residue.

## 3. Exercise failure paths

Trigger at least one error path the change claims to handle (bad input, missing file, denied permission). Confirm the failure mode is the intended one, not a crash.

## 4. Full gate

Run the project's standard checks (test suite, typecheck, lint) exactly as CI/pre-commit would. Report the real output — never claim success without having seen it.

## 5. Report

State: what was exercised, the observed evidence (commands + key output lines), and anything NOT verified with the reason. If any check failed, lead with that.
