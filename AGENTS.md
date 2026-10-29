## Agent skills

### Issue tracker

Issues, and the spec for any design settled in conversation, are tracked in GitHub Issues on christophesamueldhp/bluclawd via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### Remote web app

To check a change to `daemon/remote/web/` in a browser, run `node scripts/remote-web-dev.ts`: the app against fake panes, with its URL and pairing code printed.
