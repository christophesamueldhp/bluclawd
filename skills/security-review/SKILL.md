---
name: security-review
description: Security-review the pending changes on the current branch for injection, secrets, authz, SSRF, path traversal, and unsafe deserialization risks. Use when asked for a security review or audit of changes.
---

# Security Review

Review the pending change set (working tree + branch commits) strictly for security impact. This is not a general code review — only report security-relevant findings.

## 1. Scope the diff

```bash
git status --short
git diff <default-branch>...HEAD   # or the uncommitted diff if no branch commits
```

Read every changed hunk. For each, ask: does this handle untrusted input, secrets, auth, files, processes, or network?

## 2. Threat checklist

Check each changed area against:

- **Injection**: shell commands built from variables (quoting, `eval`), SQL string concatenation, HTML/JS interpolation without escaping (XSS), format strings.
- **Secrets**: credentials/tokens/keys committed, logged, echoed into errors, or sent to third-party services; secrets read from env and forwarded anywhere new.
- **AuthN/AuthZ**: endpoints or commands missing permission checks, trust decisions made from client-controlled data, privilege boundaries crossed (e.g. project-controlled config reaching a privileged path).
- **SSRF & network**: URLs fetched from untrusted input without scheme/host validation, redirects that can reach internal addresses, DNS rebinding.
- **Filesystem**: path traversal (`..`, absolute paths, symlinks) from untrusted input, world-writable files, temp-file races, writes outside the intended root.
- **Deserialization & parsing**: `eval`/`Function`, YAML/pickle-style loaders on untrusted data, prototype pollution via object merge, zip-slip in archive extraction.
- **Supply chain**: new dependencies (why needed, typosquatting, install scripts), lockfile changes that don't match the stated intent.
- **Denial of service**: unbounded reads/loops/recursion on untrusted input, missing size caps or timeouts.

## 3. Verify before reporting

For each candidate finding, trace the data flow from an attacker-controllable source to the sink in the actual code. Report only findings with a plausible attack path; state attacker capability required, impact, and the exact `file:line`.

## 4. Report

Order by severity (critical → low). For each: title, `file:line`, attack scenario, impact, and a concrete remediation. Close with a one-paragraph verdict: is the change safe to merge as-is?
