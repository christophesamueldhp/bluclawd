# RPC subagents: acceptance audit (#312, spec #290)

This audits the final integrated revision against #290's 84 user stories and its accepted decisions. Every row cites a test that ran and passed on this revision, or names what is missing. Ticket counts are not evidence.

## Revision, host and platform

- **Revision**: `620da94` (branch `290-rpc-subagents`, #292–#311 merged), audited on branch `312-acceptance`. The only code change after it is one added test, `4745131`, for story 40.
- **Code review fixes**: the review of the integrated branch found six spec gaps and some standards issues, fixed on branch `290-review-fixes` from `5e443ae`. The rows below cite those fixes' tests, and [After the code review](#after-the-code-review) gives their check.
- **Host packages**: pi 1.5.2 for every `@earendil-works` package, with no nested copies: `pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`, `pi-codemode`, `pi-mcp`, `pi-schema` and `pi-telemetry`. `test/subagent-rpc-runs` asserts `piVersion: "1.5.2"` on the run's own model request.
- **Runtime**: Node 26.8.1, tmux 3.6b, Command Line Tools present.
- **Platform**: macOS 27.2 (26B123), arm64. This is the only platform run.
  - Linux and WSL are **unsupported for a run's shell**. Admission refuses a role naming `bash` there, and `general-purpose` gets no shell. That refusal is tested only by passing `"linux"` to the check on macOS. No Linux machine ran anything, so the RPC paths without a shell are **not verified** on Linux either; they did not pass there.
- **Provider**: the scripted faux provider (`test/fixtures/real-pi/faux.ts`). It reaches each run's pi through the `BLUCLAWD_RPC_PROVIDER_EXTENSIONS` stopgap (see R3). No real provider was called.

## How to read the tables

- **Status**:
  - **S**: satisfied. A test that passed on this revision states the clause in its name. Where the name did not state it, its body was read and asserts it. That was done for stories 8, 14, 20, 26, 28, 30–32, 35–40, 43–45, 49, 51, 53, 62, 63, 80 and 82.
  - **P**: partial. The limitation is stated.
  - **U**: unsatisfied.
- **Seam**:
  - **R**: real pi 1.5.2 over RPC with the faux model.
  - **OS**: the real macOS sandbox and processes.
  - **U**: a unit or focused test, or a fake host.
- **File names**: `test/` and `.test.ts` are left out. `rpc-x` stands for `subagent-rpc-x`. Test names are quoted from their start.

## Test runs on this revision

| run | command | result |
|---|---|---|
| targeted | `npx vitest run test/subagent-rpc- test/subagent-run- test/subagent-batch test/subagent-collaboration test/subagent-legacy test/subagent-sessions test/subagents-{admission,definitions,evaluation,generations,messages,models,panel,parent-scope,policy,remote,results,runs,sdk,stop,storage,task-source,tasks-done,tool,views,waiting,writer} test/daemon-run-queue test/daemon-collaborations test/session-usage test/permissions-deny test/sandbox-reaper test/registration test/transcript-own-tools` | 54 files, **445 passed, 0 failed, 0 skipped**; load 4–12 |
| evaluation | `npx vitest run test/subagents-delegation-eval.test.ts --silent=false` | 5/5 passed; table in `delegation-efficiency.md` |
| added test (`4745131`) | `scripts/stress-test.sh test/subagent-rpc-models.test.ts -t "queued run was admitted"` | **0/48 failed** (16 wide × 3 rounds, each 1 passed); load rose to 41 during it |
| full | `npm run check` (lint, knip dead code, typecheck, every test) | see [Final check](#final-check) |

No real-pi or OS test was skipped. Every `skipIf` guard was false here: tmux present, `contained` true, darwin.

## User stories

| # | story (short) | S | evidence (file › test) | seam | limitation |
|---|---|---|---|---|---|
| 1 | built on pi 1.5.2's native core | S | rpc-runs › "takes its task in a fresh session…" (asserts `piVersion 1.5.2`); every `rpc-*` file runs `pi --mode rpc` children | R | a real provider in a child is unverified (R2) |
| 2 | small work done directly | P | subagents-delegation-eval › "does trivial work directly…"; subagents-waiting › "keeps delegation selective…" ("Do small work yourself") | R/U | the model's choice is scripted; whether a real model holds back is unmeasured |
| 3 | one Run, clear interface | S | rpc-runs › "takes its task in a fresh session…" | R | |
| 4 | `tasks` in parallel | S | rpc-batches › "runs a foreground batch side by side…" | R | full-suite-only flake (F3) |
| 5 | `chain` order enforced | S | rpc-chains › "edits, reviews in a fresh context and repairs…" | R | |
| 6 | explicit `cwd` per Run/step | S | rpc-roles › "works in the directory it was given…"; rpc-worktrees › "edits a worktree…" (`cwd: "pkg"`); rpc-batches › "runs a foreground batch…"; subagents-admission › "refuses a chain step whose directory leads out of its chain's worktree through a link…" | R/U | a step's escape through a link is refused only at the unit seam |
| 7 | Admission errors before execution | S | rpc-batches › "refuses a contradictory, empty or invalid batch…"; rpc-chains › "refuses a contradictory, malformed or cross-repository chain…"; subagents-admission (28 cases) | R/U | |
| 8 | no fixed total quota | S | rpc-queue › "runs four children at once…" (9 runs launched in one turn, all complete) | R | |
| 9 | 4 active by default across parents | S | rpc-queue › "runs four children at once…"; daemon-run-queue › "grants as many runs as its capacity across orchestrators…" | R/U | |
| 10 | user configures limit; model cannot raise | P | daemon-run-queue › "bounds active runs by the user's own setting as it is at each claim, which no orchestrator gives"; › "is four unless the user's own settings give a positive whole number"; rpc-queue › "gives a freed slot…" (`maxActive: 2`) | R/U | the daemon reads the bound itself; no claim, tool or project setting sets it. The orchestrator's own `bash`, `write` and `edit` could still edit the user's `settings.json` (R10) |
| 11 | fair across parents | S | rpc-queue › "gives a freed slot to the orchestrator served least recently…"; daemon-run-queue › "serves the orchestrator served least recently first…" | R/U | |
| 12 | queued/stored use no slot or turn | S | rpc-queue › "runs four children at once, and holds the rest back with no process and no model call…"; rpc-stop › "cancels a queued run before it starts…" | R | |
| 13 | idle child exits after Report and drain | S | rpc-runs › "takes its task…" (host and pi dead); rpc-messages › "takes a message that races its settling…" | R | |
| 14 | fresh context, focused task | S | rpc-runs › "takes its task in a fresh session…" (conversation is the framed task only); rpc-runs › "starts a second run of the same role in a session of its own" | R | |
| 15 | Run identity controls Resume | S | rpc-resume › "is never started by a message, and a new run of the same role starts fresh" | R | |
| 16 | Resume keeps context | S | rpc-resume › "continues the run's saved session in a new pi…" | R | |
| 17 | independent review is a new Run | S | rpc-chains › "edits, reviews in a fresh context…"; rpc-chains › "hands the worktree to a fresh writer…without the worker's context" | R | |
| 18 | messages during execution | S | rpc-messages › "takes its orchestrator's message at its next safe point…"; › "wakes its orchestrator once for a blocker…" | R | |
| 19 | user inspects and instructs a child | S | rpc-messages › "shows its conversation from the panel and gives it the user's instruction…" | R | |
| 20 | direct instruction to the same session, parent told | S | rpc-messages › "shows its conversation…telling the orchestrator without waking it"; › "resumes a finished run with the user's instruction from /tasks…" | R | a user instruction leaves no `messages.jsonl` audit line (R14) |
| 21 | parents talk only after user links them | S | subagent-collaboration › "reaches no other parent until the user links named sessions…" | R | |
| 22 | in-group messages without per-message approval | S | subagent-collaboration › "takes a finding at a working parent's next safe point…" | R | |
| 23 | no discovery, broadcast, ack loops | S | subagent-collaboration › "reaches no other parent until…"; daemon-collaborations › "opens none when a named session is ambiguous or unknown…" | R/U | |
| 24 | origin and authority preserved | S | rpc-messages › "gains no capability from a peer's message that claims the user's authority"; subagent-collaboration › "starts nothing and grants nothing with a message that claims the user's authority…"; subagents-messages › "keeps a claim of user approval inside the content…" | R/U | the frame is the only guard: a real peer may act on a message with its own authority (R26) |
| 25 | explorer, reviewer, general-purpose bundled | S | subagents-definitions › "loads bundled general-purpose, explorer and reviewer roles…" | U | |
| 26 | explorer/reviewer: read + codemode, no shell or mutation | S | rpc-capabilities › "gives an explorer no write, shell, subagent or extension tool…"; rpc-roles › "gives a role only read tools and codemode…" | R | |
| 27 | tests need an execution role | S | rpc-roles › "gives a role only read tools…and refuses one it cannot isolate"; rpc-shell › "runs commands in its own worktree's sandbox…" | R/OS | macOS only (R1) |
| 28 | optional custom planner | S | rpc-roles › "takes its role from an inline…" (inline custom role); subagents-waiting › "keeps delegation selective…" ("No sequence of roles is required") | R/U | |
| 29 | inline > project > user > bundled | S | rpc-roles › "takes its role from an inline, the nearest project, a user or a bundled definition…" | R | load canary (F4) |
| 30 | project discovery bounded by root | S | rpc-roles › "…looking no higher than its repository"; subagents-definitions › "looks from the run's directory up to its root…" | R/U | |
| 31 | `agentScope` filters, never trusts | S | rpc-roles › "runs a project's roles only where the user already trusts that project…" (`agentScope: "project"`); subagents-definitions › "narrows the eligible sources by scope without trusting more" | R/U | |
| 32 | `confirmProjectAgents` cannot bypass trust | S | rpc-roles › "runs a project's roles only where the user already trusts…" (`confirmProjectAgents: false` refused) | R | |
| 33 | invalid/ambiguous role rejected, no fallback | S | rpc-roles › "refuses an invalid or ambiguous role without falling back…" | R | |
| 34 | admitted role frozen | S | rpc-roles › "keeps the role it was admitted with…"; rpc-resume › "holds to the role it was admitted with…"; rpc-queue › "starts a queued run as admitted…" (role file edited while queued) | R | |
| 35 | model and thinking per Run | S | rpc-models › "takes each of model and thinking from the call, else the role…" | R | |
| 36 | omitted: role default, then parent | S | rpc-models › same test (`parents`, `roles`, `mixed`) | R | |
| 37 | explicit `inherit` beats role default | S | rpc-models › same test (`inherited`, `half`) | R | |
| 38 | unsupported model, auth, thinking rejected | S | rpc-models › "refuses before any run starts a model it does not know or cannot authenticate, and a router…"; rpc-models › same first test (`refused`: no clamping); subagents-admission › "fails unknown models, missing auth, unsupported thinking and virtual routers…" | R/U | a key given only at runtime (`--api-key`) passes Admission and the run fails late; untested (R4) |
| 39 | child's actual config verified | S | rpc-models › "fails a run whose pi does not run the admitted model and thinking, before it is given its task" | R | faux providers only (R2, R3) |
| 40 | queued/resumed keep admitted pair | S | rpc-models › "keeps the model and thinking a queued run was admitted with when its orchestrator changes its own before the run's turn" (**added by #312**); rpc-models › "keeps the model and thinking it was admitted with when its orchestrator changes its own" (while working); rpc-queue › "starts a queued run as admitted…" (role file changed while queued); rpc-resume › "keeps its model and thinking unless the Resume changes them…" | R | |
| 41 | capabilities ⊆ parent ∩ role ∩ assignment ∩ workspace | S | rpc-capabilities › "holds a run to its orchestrator's deny rules and its own workspace's…"; rpc-queue › "…held to what its orchestrator denies by its turn"; rpc-resume › "…narrowed by its orchestrator's rules as they are now" | R | |
| 42 | codemode within capabilities | S | rpc-capabilities › "lets an explorer compose its reads through codemode…" | R | |
| 43 | codemode nested tools, discovery, helpers under policy | S | rpc-capabilities › "lets an explorer compose…without model helpers" (`models` undefined); › "gives an explorer no write…called directly, nested or found" (`searchTools`, `ALL_TOOLS`) | R | tool reloads during a run are not probed |
| 44 | shell, extensions, MCP cannot evade | S | rpc-capabilities › "gives an explorer no write, shell, subagent or extension tool…" (MCP, late MCP, extension tool, `defaultTools`); subagent-run-shell (19 OS tests); rpc-worktrees › "changes nothing outside its worktree, through links, its .git, codemode…" | R/OS | |
| 45 | no further subagents on any route | S | rpc-capabilities › same test (direct + nested `subagent`, no run started); subagent-run-shell › "reaches neither a daemon's nor tmux's socket, by path" | R/OS | |
| 46 | writers isolated in worktrees | S | rpc-worktrees › "edits a worktree of its own…"; › "works beside other writers…" | R | |
| 47 | readers share the workspace | S | rpc-worktrees › "refuses a writer it cannot isolate, while readers share a checkout…"; subagents-delegation-eval › "investigates read-only in the checkout, with no worktree…" | R | |
| 48 | stable snapshot for a reader | **U** | none | — | not built: a lone reader has no snapshot option. Only a reader step of a chain that edits works in a worktree (rpc-chains › "keeps the worktree a reading first step recorded…") (R7) |
| 49 | baseline incl. uncommitted, no commit | S | rpc-worktrees › "edits a worktree of its own, made from the checkout as it was at its Admission…" (staged ≠ unstaged, untracked copied, no commit or branch) | R | |
| 50 | later parent edits excluded | S | rpc-worktrees › "works beside other writers, each from the state its own Admission recorded, however long it waited" | R | |
| 51 | ignored files and secrets not copied | S | rpc-worktrees › "edits a worktree of its own…" (`.env` absent; `SECRET` never in requests); subagent-run-worktree › "is kept holding a file its baseline left out…" | R/U | |
| 52 | worker→reviewer→repair in one workspace | S | rpc-chains › "edits, reviews in a fresh context and repairs in the worker's own…" | R | |
| 53 | findings feed repair, not failure | S | rpc-chains › same test; subagents-delegation-eval › "runs worker, review and repair as one chain…" | R | |
| 54 | failed/cancelled/blocked halt the chain | S | rpc-chains › "halts at a failed step…"; › "cancels the working step…never starts the next"; › "halts at a step its Admission refuses…names it blocked" | R | |
| 55 | batch siblings continue after a failure | S | rpc-batches › "leaves a failed member's siblings working…" | R | |
| 56 | foreground by default | S | rpc-stop › "cancels a foreground run when its call is cancelled…"; rpc-batches › "runs a foreground batch side by side…"; rpc-chains › "edits, reviews…" | R | |
| 57 | explicit background | S | rpc-stop › "…leaves one launched in the background working"; rpc-batches › "stops a background batch whole…"; rpc-chains › "runs a background chain…" | R | |
| 58 | foreground batch stays parallel | S | rpc-batches › "runs a foreground batch side by side within the shared capacity…"; subagents-delegation-eval › "makes independent edits side by side…" | R | F3 |
| 59 | progress does not wake parent | S | rpc-messages › "wakes its orchestrator once for a blocker while it works, and for none of its progress"; subagents-delegation-eval › "wakes the orchestrator once for a background run's Report…" | R | |
| 60 | findings, blockers, approvals delivered during work | S | rpc-messages › same; rpc-approvals › "asks the user in its orchestrator, naming the run, action and target…"; rpc-recovery › "tells the reopened orchestrator once of a blocker its crashed instance held and never took" | R | |
| 61 | inspect and integrate within scope | S | rpc-integration › "applies only the run's changes onto the checkout as it is now…" | R | |
| 62 | serialized, preserves edits, validates combined | P | rpc-integration › "applies only the run's changes…keeps every edit made meanwhile, and runs the check given"; › "integrates two runs…reports a check the combined result fails…" | R | validation runs only when the orchestrator passes `check`, and only while its own `bash` is active (rpc-integration › "runs no check for an orchestrator that may not run bash itself…"). Without one, the result says nothing validated it |
| 63 | intent changes escalated; commits/pushes separate | S | rpc-integration › "applies nothing when a change conflicts…" (all or nothing; asserts the refusal says "ask them, and do not choose"). That case and › "applies only the run's changes…" assert the index, HEAD, branches, tags and stash unchanged | R | escalation is guidance to the orchestrator; the runtime refuses the conflict |
| 64 | Stop cancels descendants, keeps context and files | S | rpc-stop › "is cancelled only once nothing of it runs…"; rpc-shell › "is stopped only once every process its command started has ended…"; rpc-workspace-retention › "keeps a workspace holding changes after it completed, failed or was stopped" | R/OS | escape routes not probed (R1) |
| 65 | whole batch/chain cancel includes queued | S | rpc-batches › "cancels every member, working or queued…a queued one never starts"; rpc-chains › "runs a background chain…stops whole by its ID" | R | |
| 66 | cancelled needs explicit Resume | S | rpc-stop › "keeps a stopped run's session and Report, lets no late message, Report or reload restart it, and resumes it only when asked" | R | |
| 67 | approvals name Run, action, target; reuse | S | rpc-approvals › "asks the user in its orchestrator, naming the run, action and target…a yes holds for the same action…"; rpc-shell › "asks its orchestrator before a command reaches a host…" | R/OS | the only real trigger is a shell's network host (R13) |
| 68 | hard limits denied; no channel = blocked | S | rpc-approvals › "refuses a call beyond its deny rules without asking…"; › "is blocked, not allowed, once no orchestrator is there to ask the user" | R | no-UI (print mode) branch untested (R14) |
| 69 | concise Report with status, changes, checks, evidence | S | rpc-reports › "is bounded: the runtime's own account whole…"; › "lists the checks its transcript shows it ran…whatever its text claims" | R | |
| 70 | bounded aggregate; every status reachable | S | rpc-batches › "bounds the aggregate of a batch whose Reports exceed it…"; rpc-reports › "keeps every batch member's status reachable while it works…"; subagent-batch-aggregate (6) | R/U | |
| 71 | runtime outcome ≠ claim ≠ Integration | S | rpc-reports › "lists the checks its transcript shows it ran…"; rpc-integration › "integrates two runs…a check the combined result fails apart from their outcomes"; rpc-runs › "reports a pi that could not start as failed…no claim of its own" | R | |
| 72 | active child finishes after parent crash | S | rpc-recovery › "lets a working run finish after its orchestrator crashed…Report once" | R | |
| 73 | queued/later steps paused until revalidation | S | rpc-recovery › "pauses a queued batch member…"; › "refuses a queued member the reopened orchestrator may no longer start…"; › "pauses a chain's later steps…" | R | |
| 74 | stale generations/branches/scopes powerless | S | subagents-runs › "ignores an earlier generation's controller after a resume"; subagents-admission › "refuses to resume a run whose originating entry left the branch…", › "lets one of two instances…resume a run, never both"; rpc-resume › "starts one pi on its session when two Resumes come at once"; subagent-collaboration › "…refuses a message written under a scope the user since…" | R/U | stale scope and an off-branch origin are refused only at the unit seam |
| 75 | uncertain side effects surfaced, not replayed | S | rpc-recovery › "reports a run whose host died while its orchestrator was gone as uncertain, and never starts its work again" | R | |
| 76 | changed workspaces retained | S | rpc-workspace-retention › "keeps a workspace holding changes after it completed, failed or was stopped" | R | |
| 77 | unchanged cleaned only if recoverable | S | rpc-workspace-retention › "removes a workspace it left unchanged, and Resume makes it again exactly as admitted…"; subagent-run-worktree (6 cases) | R/U | |
| 78 | Resume fails clearly if unrecoverable | S | rpc-workspace-retention › "removes a workspace holding changes only at the user's request, after which Resume is refused…"; rpc-resume › "refuses when its workspace is gone…" | R | |
| 79 | read-only outside Git; writer refused | S | rpc-worktrees › "refuses a writer it cannot isolate, while readers share a checkout, in Git or not…" | R | |
| 80 | legacy transcripts kept; active legacy explicit | S | subagent-legacy-runs › "keeps an open one working until it is stopped, refuses to resume it…"; subagents-admission › "refuses to resume a run in tmux from before…"; subagents-tool › "leaves a run in tmux from before running when it is reopened outside tmux…" | R/U | legacy child-to-parent messaging is uncovered (R14) |
| 81 | runtime owns lifetime, no `subagent_close` | S | rpc-stop › "cancels a foreground run…" (tools lack `subagent_close`); subagents-waiting › "tells the model…" ("nothing to close"); rpc-runs › "takes its task…" (process exits) | R/U | |
| 82 | child usage once, apart from parent | S | rpc-reports › "counts its session once, apart from the orchestrator's own usage, however many generations and Reports"; session-usage › "counts every reply, compaction and helper call…" | R/U | retries are assumed counted, untested; an unreadable session file is silently left out (R14) |
| 83 | realistic comparison with stock pi | P | subagents-delegation-eval (5); `delegation-efficiency.md` refreshed on this revision | R | faux only: no live model ran (R2) |
| 84 | public-seam tests + real OS checks | S | the 16 `rpc-*` files (93 tests with those added); subagent-run-shell (19), subagents-writer-backend (5), subagents-writer-sandbox (2), sandbox-reaper (4) | R/OS | macOS only; Linux/WSL unsupported for shell, not run (R1) |

**Totals**: 79 S, 4 P (2, 10, 62, 83), 1 U (48).

## Accepted decisions

The Q1–Q23 decisions are not numbered individually anywhere in the repository, the notes or #290. This table maps the 23 bullets of ADR-0010's "Accepted behavior", in order, as D1–D23. D0 is that section's opening paragraph, the requirements stated before the interview. That correspondence is an assumption.

| D | decision | S | evidence | limitation |
|---|---|---|---|---|
| D0 | pi 1.5.2; single, `tasks`, `chain`, `cwd`; codemode yes; no further delegation; authority ⊆ orchestrator ∩ role ∩ assignment | S | stories 1, 3–6, 42, 45, 41 | |
| D1 | messages while working; process ends once reported and drained; session kept | S | stories 13, 16, 18 | |
| D2 | writers in worktrees; readers share; reviewer after writer; stable snapshot | P | stories 46, 47, 52 | no reader snapshot (story 48) |
| D3 | baseline at Admission, uncommitted included, no commit; ignored not copied | S | stories 49–51 | |
| D4 | 4 active across orchestrators, fair, no total quota, user-set, orchestrator cannot raise | P | stories 8–12 | story 10 |
| D5 | user-opened collaboration only | S | stories 21–24 | collaborations end on a daemon restart (R9); a peer acts with its own authority (R26) |
| D6 | Integration: serialized, preserves edits, combined validation, no commit | P | stories 61–63 | validation needs `check` (story 62) |
| D7 | worker/reviewer/repair share one worktree; halt on failure | S | stories 52–54 | |
| D8 | cancel foreground/batch/chain incl. queued; retain; background distinct; explicit Resume | S | stories 56, 57, 64–66 | |
| D9 | approvals with identity, reuse, hard ceilings, blocked without channel | S | stories 67, 68 | R13 |
| D10 | user inspects and instructs at a safe boundary; orchestrator told | S | stories 19, 20 | |
| D11 | three bundled roles; readers have no shell; tests need an execution role; planner optional | S | stories 25–28 | |
| D12 | fresh context; explicit Resume; review is a new run | S | stories 14–17 | |
| D13 | foreground default; background explicit; progress quiet; batch parallel | S | stories 56–59 | |
| D14 | crash: active finishes, queued waits, uncertain reported | S | stories 72–75 | R8 |
| D15 | legacy readable, not resumed, not silently ended | S | story 80 | |
| D16 | role resolution, root bound, trust, freeze | S | stories 29–34 | |
| D17 | model/thinking resolution, no substitution, frozen | S | stories 35–40 | R2, R4 |
| D18 | bounded Reports, statuses, disclosed truncation, no summarizer | S | stories 69–71 | |
| D19 | changed workspaces kept; unchanged cleaned when recoverable | S | stories 76, 77 | |
| D20 | read-only outside Git; writer refused | S | story 79 | |
| D21 | batch failure leaves siblings; whole-batch cancel | S | stories 55, 65 | |
| D22 | Resume needs exact workspace or refuses | S | stories 77, 78 | |
| D23 | Stop ≠ Resume ≠ cleanup; no `subagent_close` | S | stories 64, 76–78, 81 | |

## Ticket flows → observed runs

| #312 criterion: flow | file › test (all passed on this revision) |
|---|---|
| 2: single | rpc-runs › "takes its task in a fresh session…" |
| 2: batch | rpc-batches (7) |
| 2: chain | rpc-chains (8) |
| 2: Resume | rpc-resume (6) |
| 2: exact model/thinking | rpc-models (5, one added by #312) |
| 2: role/trust | rpc-roles (6) |
| 2: queue fairness | rpc-queue › "gives a freed slot to the orchestrator served least recently…" |
| 2: live/direct messages | rpc-messages (8) |
| 2: scoped parent collaboration | subagent-collaboration (3) |
| 3: OS capability | subagent-run-shell (19 OS); rpc-shell (6 R+OS); subagents-writer-sandbox (2) |
| 3: descendant Cancellation | subagent-run-shell › "ends a %s descendant with its command…" ×4 (attached, inherited-stdio, detached, double-fork); › "ends a process that forks anew…"; › "is ended from outside while a command still runs…"; subagents-writer-backend (5); rpc-shell › "ends what its command started when its host is killed…", › "…once its orchestrator crashed…" |
| 3: codemode/tool routes | rpc-capabilities (4); rpc-worktrees › "changes nothing outside its worktree, through links, its .git, codemode…" |
| 3: writer escapes | subagent-run-shell › "writes nothing outside its worktree…", › "changes no Git state…", › "cannot approve itself…", › "reaches neither a daemon's nor tmux's socket…"; rpc-shell › "takes turns between its commands and its file tools…" |
| 3: process lifetime | rpc-stop › "is cancelled only once nothing of it runs…"; rpc-shell › "runs commands in its own worktree's sandbox…nothing it started outlives a command" |
| 3: unsupported platform refuses | subagent-run-shell › "is refused off macOS, saying so"; subagents-definitions › "refuses a role that names bash, with the reason" (both pass `"linux"` on macOS; R1) |
| 4: Integration preserving user edits | rpc-integration (8) |
| 4: cleanup/exact-state Resume | rpc-workspace-retention › "removes a workspace it left unchanged, and Resume makes it again exactly as admitted…", › "removes a workspace holding changes only at the user's request…" |
| 4: parent/daemon recovery | rpc-recovery (11), incl. › "holds a working run's slot in the daemon started after its daemon ended…" |
| 4: legacy cutover | subagent-legacy-runs (2) |
| 4: approvals | rpc-approvals (4) |
| 4: bounded evidence retrieval | rpc-reports (4); rpc-batches › "bounds the aggregate…" |
| 4: Attribution | rpc-reports › "counts its session once…" |

## Final check

`npm run check` ran twice, separately from the targeted runs:

| step | on `620da94`, 13:00, load 5 → 20 | on `4745131` (+ the added test), 13:09, load 14 → 18 |
|---|---|---|
| lint (`biome check .`) | 389 files, no errors; 1 warning | same |
| dead code (`knip --production --include files`) | clean | clean |
| typecheck (both `tsc` passes) | clean | clean |
| tests (`vitest run`) | **179 files, 2491 passed, 0 failed, 0 skipped** | **179 files, 2492 passed, 0 failed, 0 skipped** |

- **The lint warning**: `noTemplateCurlyInString` in `test/skill-session.test.ts:45`. It is already on `main` and unrelated to #290.
- **Docs**: the docs-only commits after these runs change no code.
- **Flakes**: none of F1–F6 failed. No failure was re-run.
- **Leftovers**: no test daemon, run host, run pi or tmux server was left running. This was checked with `ps`, and with `lsof -d cwd` for processes in temp directories, since pi renames its process. The only bluclawd daemon left is the user's own, from `~/Projects/bluclawd`, started at boot.

## After the code review

The fixes on `290-review-fixes`, one commit each:

| finding | fix | test |
|---|---|---|
| the daemon spawned any argv, env and cwd a client sent, and ran a client-named helper | it starts its own `rpc-host.ts` in the run's directory. The host checks the spec there and starts its own pi; the daemon ends leftovers with its own helper (R27) | daemon-run-host-launch (2); daemon-run-queue › "starts no host whose directory, environment or run is not one a run's host has" |
| the last claim set the queue's capacity | the daemon reads `subagents.maxActive` itself (R10) | daemon-run-queue › "bounds active runs by the user's own setting…" |
| `subagent_integrate check` ran for an orchestrator without `bash` | refused unless its own `bash` is active | rpc-integration › "runs no check for an orchestrator that may not run bash itself…" |
| a chain step's `cwd` could leave the worktree through a link | resolved, and refused outside the worktree's real root | subagents-admission › "refuses a chain step whose directory leads out…" |
| the relay position was stored before relaying, so a crash lost a held message | at-least-once by message ID, taken once by the session and by a sibling's inbox | rpc-recovery › "tells the reopened orchestrator once of a blocker…"; subagent-run-mailbox › "takes a message relayed again, by its key, once…" |
| the collaboration test's "notes.md untouched" proved nothing after the scripted turn | that assertion dropped (R26) | subagent-collaboration |

The review's larger structural smells are left as they are: the size of `admission.ts`, the `(runDir, generation)` pair passed everywhere, and the `backend === "rpc"` switches.

Their check, on the review fixes (`5e443ae` plus the fix commits), at load 5 → 35:

| run | result |
|---|---|
| `npm run check` | lint: 393 files, no errors, the same 1 warning; knip clean; typecheck clean; **181 files, 2500 passed, 0 failed, 0 skipped** |
| earlier `npm run check` runs, same code | 1 and 3 failures, all known flakes: F1 (wakeups-signal, both of its daemon-down tests) and F3 (rpc-batches). wakeups-signal fails 3/16 at 8 wide on `5e443ae` too; F3 was 0/16 alone |
| `scripts/stress-test.sh test/daemon-run-host-launch.test.ts` | **0/48 failed** |
| `scripts/stress-test.sh test/subagent-rpc-recovery.test.ts -t "blocker its crashed instance"` | **0/48 failed** |
| `scripts/stress-test.sh test/subagent-rpc-integration.test.ts -t "may not run bash"` | **0/48 failed** |

No test daemon, host or pi was left running afterwards (`ps`).

## Residual limitations

Each ticket block of the implementation notes was checked item by item. An item closed by a later ticket, by its test or by its code, is left out. Examples: thinking verification (#294), Resume from `definition.json` (#296), the run-shell environment scrub and approval-dir protection (#302), daemon slots across a restart (#308), and the tool descriptions and transcript rendering (#311).

| R | limitation | source |
|---|---|---|
| R1 | **Platforms**: a run's shell is contained, and its processes confirmed ended, only on macOS. Linux and WSL are unsupported for shell: refused, not passed. Nothing ran on Linux. macOS containment relies on private SPI (`sandbox_check`, `proc_pidinfo` flavor 17) and a Command Line Tools helper. `launchctl submit`, `at` and `crontab` escapes are unprobed. No process outlives a command, so no dev server spans commands. | #302 |
| R2 | **No live real-provider check.** No paid call was made. A run's pi on the user's real provider is unverified (auth and `models.json` reach it through the agent dir and env, by code reading only). The user can run the command under [Commands for the user](#commands-for-the-user). | #311, #310 |
| R3 | **Provider-extensions stopgap**: a provider an extension registers is refused at Admission. `BLUCLAWD_RPC_PROVIDER_EXTENSIONS` loads extra `-e` extensions into each run, and 20 test files plus `test/helpers/fake-run-hosts.ts` depend on it for faux. It is not a supported configuration. | #292, ADR-0010 |
| R4 | A key given only at runtime (`--api-key`) passes Admission, but the run's pi lacks it and fails late. Untested. Virtual routers are refused; there is no per-message model check. | #294 |
| R5 | **ADR-0001 conflict: resolved by ADR-0011.** ADR-0001 now scopes the VM-only claim to arbitrary commands; run shells confirm termination by sandbox identity (ADR-0011), and the orchestrator shell keeps the best-effort reaper. | #302 |
| R6 | Known pre-existing flakes: F1–F6 below. | ledger |
| R7 | No stable snapshot for a lone reader (story 48). | #301 |
| R8 | **Recovery**: a kill between `claimRunGeneration` and the record write leaves a generation claimed forever, so the run cannot be resumed. A batch's aggregate and manifest are not rebuilt after takeover. A chain has no live manifest after takeover, and its handoff lacks an earlier step's workspace lines. A reload inside a step's Admission await could admit it twice. Two live pis on one session both deliver a Report. A run's message relayed again after a crash is taken once by the orchestrator and by a sibling's inbox, but a sibling resumed since gets it in its new generation, and the audit log (`messages.jsonl`) records each relay. A message still in the crashed orchestrator's memory when its run ended is not relayed again: only open runs are taken over. A parent that never returns leaves its record `running`, plus its worktree and `run-tmp`. A partly made worktree is not repaired. | #308 |
| R9 | **Memory only**: collaborations (gone on a daemon restart), remembered approval "yes" (lost on reload), and the queue's waiting runs. Open approvals after a reload are picked up only within the host's 5 s window, untested. A parent crash mid-claim holds a slot for up to 60 s. | #307, #300, #308 |
| R10 | The daemon reads `subagents.maxActive` from the user's own settings, in its agent dir, at each claim: no claim, tool or project setting sets it. The orchestrator's own `bash`, `write` and `edit` act with the user's authority over their files, though. The sandbox is off by default, and deny rules are all that hold them, so unless a rule covers it they could edit that `settings.json`, and the next claim reads the new bound. No guard is added: that authority is the user's to give. | audit, review |
| R11 | **Mailbox seal**: a killed poster whose pid is reused could make a seal wait as long as that process lives; no draft-age deadline. | mailbox fix |
| R12 | **Pre-existing permissions gap**: a rule starting with `*` (e.g. `Read(*.env)`) never matches folder-grep lines. | #295 |
| R13 | Approvals have one real trigger: a shell's network host. bluclawd permissions are deny-only. Another pi dialog replacing an open approval dialog never settles it. | #300 |
| R14 | **Untested branches**: termination unconfirmed → `failed` (#299, #303); approval with no UI (`pi -p` with a foreground RPC subagent exits mid-tool, pre-existing); hook's "not given this tool" and unreadable-policy branches; host wrong-session branch; preview Read-deny filter, Bash-denied check (an inactive `bash` is tested), lock-wait timeout and stale-lock takeover race in Integration; per-step model/thinking and the 32 KiB cap in chains; a background member refused at its turn; Resume of a shell run; a shell step in a chain; codemode-nested bash in a shell run; retries in usage; legacy child messaging, typed-in-run note and needs-input notice. Also: a user instruction leaves no `messages.jsonl` line; a child is not told when its sibling message is refused; an unreadable session file is left out of usage silently. | #295–#311 |
| R15 | **Disk and leftovers**: the baseline ref of an unchanged workspace is kept; `~/.pi/agent/bluclawd/reaper` is an empty directory left by a #302 probe. A resume that restores a worktree and then does not start leaves an unchanged worktree. | #304, #302 |
| R16 | **Evaluation**: faux only, 2 trials; the example arm, the budget stop and the live main loop are unexercised. It supports no cost or speed claim. Investigate grading does not catch a wrong extra name. The bundled role `.md` files were not tuned. | #310 |
| R17 | **Roles and trust**: a linked worktree is its own repository root, so a main checkout's trust does not reach a worktree outside it. A resumed writer runs `--no-approve` unless the user saved trust for its worktree path (untested). Workspace trust is not rechecked at slot grant. pi's `--append-system-prompt` suppresses a project's `.pi/APPEND_SYSTEM.md` in a run (`.pi/SYSTEM.md` still loads). | #293, #297, #301 |
| R18 | **Resume and queue**: `subagent_resume` is background only. The parent's 500 ms `ensureDaemon` probe may take a slow daemon for a dead one. Stale-scope and off-branch refusals of Resume and messages are tested only at the unit seam. The tool-narrowing hook branch at a slot grant is not exercised on real pi. | #296, #297, #298 |
| R19 | **Workspaces**: there is no path for copying extra local inputs (dependencies, ignored config) into a worktree. Capturing a baseline and listing changes hash the whole working tree, with no stat cache. `worktreeChanges` writes blobs for changed files when making a Report. Generations handed off on a reload are never auto-cleaned, and a crash between hand-off and the next instance can leak a never-started run's worktree. `run-tmp/<runId>` outlives a crash until termination is confirmed. | #301, #304, #308, #302 |
| R20 | **Integration**: it writes only the working tree, so new files stay untracked and deletions unstaged. Clean and smudge filters apply. Its lock lives in the user's Git dir. | #303 |
| R21 | **Batches and chains**: a batch partly admitted after its barrier (storage error, name race, late baseline failure) is untested. After a chain releases an unchanged worktree, resuming a non-owner step is refused with a misleading "removed outside bluclawd". `/clean-workspace` on step 0 between steps is allowed, and blocks the next step. A step's `cwd` is resolved against the parent checkout. A handoff comes only from the step just before. A read-only chain runs in the parent checkout. A chain with `resume` is refused in print and json modes. Cancelling a resume step is untested. | #305, #306 |
| R22 | **Recovery, continued**: recovery needs `rpc-spec.json` written in the same tick as the record, or the run falls back to interrupted. A chain whose first step is off-branch waits, untouched. | #308 |
| R23 | **Reports and usage**: runtime lines are bounded one by one, with no total cap. Aggregates are capped at 16 KiB. `details.truncated` reflects only pi's 50 KB cap. Re-delivery and recovery duplicates in usage are covered only by a unit test. | #309 |
| R24 | **Shell, continued**: an "allow" approval and the reuse of the orchestrator's `networkAsker` answers are unprobed. So are a long-lived setuid member, and a member that survives a sweep (→ `failed`). The daemon holds a slot while a member cannot be ended. A general-purpose or `bash` role costs about 1 s of Admission the first time per agent dir, for the helper compile and self-test. | #302 |
| R25 | **Legacy**: the warning when a session reopens outside tmux with a live legacy pane is tested only with a fake host (`subagents-tool`). | #311 |
| R26 | **Collaboration between parents**: the frame is the only guard. A message tells its recipient who sent it and that it carries no user authority, but a real peer may still act on it with its own tools and rules. The test shows only that nothing runs before the recipient's turn; its scripted model does nothing with the message after. | #307, review |
| R27 | **Daemon launch**: the daemon no longer runs a program or helper a client names, but its socket is not closed to code execution. It starts its own run host, with its own node, resolve hook and pi, in whatever absolute run directory a client names. The host checks only the shape of the spec it reads there, then starts its install's pi with the spec's arguments. So a client that can write a file and reach the socket still gets unsandboxed code run through pi: the spec chooses `-e` extensions (the provider stopgap's way in, R3), the `agentDir` whose `settings.json` lists extensions, and the `cwd` with `--approve`. Closing that needs admission on the daemon's side, out of the review's scope. The client's environment still reaches the run's pi, except `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES` and `LD_PRELOAD`, so a user's own `NODE_OPTIONS`, and the orchestrator's node flags, no longer reach a run. The daemon ends a run's leftover processes with the helper built in its own agent dir, and sizes the queue from that dir's settings: an orchestrator with another agent dir shares neither. If that dir has no built helper, a shell run's slot is held for good once its host is gone, since its processes cannot be confirmed ended. | review |

### Known flakes

| F | test | where it shows |
|---|---|---|
| F1 | wakeups-signal › "reopens the session of a pi a signal ended…", › "fires one that fell due while the daemon was down…" | main too (1/48); 3/16 at 8 wide on `5e443ae` |
| F2 | agent-view-panes › "ctrl+x stops a pane…" | under load |
| F3 | rpc-batches › "runs a foreground batch side by side…" | full suite only; 0/48 alone |
| F4 | rpc-roles › "takes its role from an inline…" | load above ~60 (readiness timeout) |
| F5 | rpc-queue › "runs four children at once…" (queued run ended early, extra parent request) | 1/48 once in #297; cause unconfirmed |
| F6 | teardown: `tmux kill-server` on a `bc-real-*` socket with no listener hung a pre-push run for 30 min | once, during #293 |

## Commands for the user

A live child on a real provider, the smallest spend, with a dedicated agent dir holding that provider's credentials:

```sh
node scripts/eval-delegation.ts --live --model <provider/id> --thinking <level> \
  --max-tokens 200000 --max-dollars 2 --trials 1 --arms stock,bluclawd --scenarios investigate \
  --agent-dir <dedicated agent dir> --out live-investigate.json
```

Its `bluclawd` arm delegates to `explorer` on pi's RPC, which shows the run's pi authenticating and answering on the real model. The full comparison is the same command without `--trials 1`, `--arms` and `--scenarios`, with a larger budget. Without `--live` the runner refuses and exits 2; that was checked on this revision.

## Verdict

The parent contracts are **met on macOS with the faux provider, with exceptions**:

- 79 of 84 stories are satisfied with passing evidence.
- Four are partial: 2, 10, 62 and 83.
- One is unsatisfied: 48, the reader snapshot.
- Of the decisions, D2, D4 and D6 are partial.

Release still depends on:

- a live real-provider run (R2);
- accepting the macOS-only shell (R1) and the provider-extensions stopgap (R3).

This gate does not close #290, push, or authorize deployment.
