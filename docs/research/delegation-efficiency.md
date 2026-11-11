# Delegation efficiency against stock pi

This compares bluclawd's delegation with stock pi 1.5.2 on the same tasks, model and thinking level. Correctness comes first, then cost and overhead. The runner is `scripts/eval-delegation.ts`. Its deterministic suite is `test/subagents-delegation-eval.test.ts`, which runs on the scripted faux model.

**Live evidence has not been collected.** No paid model call was made for this record. Everything below comes from the scripted faux model, which measures what the machinery costs and keeps. It does not measure whether a real model delegates well.

## Arms

Every arm runs the parent as `pi --mode rpc -ne`, with the same `--model` and `--thinking`. Only the extensions differ.

- **stock**: no extensions (`-ne` also turns off pi's built-in `mcp`, `codemode` and `tool-search`).
- **bluclawd**: only bluclawd's `subagents` extension. Runs go through pi's RPC, the default since #311, under its delegation guidance. The rest of the package (permissions, sandbox, agent view and the others) is not loaded. Those extensions add their own tools and prompt text, so whole-package figures would be higher than these.
- **example** (live only): pi's example extension `examples/extensions/subagent`. pi ships it as an example; it is not built-in behavior. Its sample roles are installed with their pinned `model:` lines removed, so its children run on the model under evaluation. Its children are unnamed and share one faux script, so it cannot run on the scripted model.

On the faux model, each arm also loads the faux provider extension (`test/fixtures/real-pi/faux.ts`). It only registers the model.

## Scenarios

The same prompt is used for every arm. A fixture is a committed Git repository. Grading is done on the final tree with `gradeFixture` (`scripts/eval-subagents.ts`): the fixture's `node --test test/` must pass, and each named function must be defined exactly once.

| scenario | task | correct when |
|---|---|---|
| trivial | make `parseDuration` read minutes | the tests pass |
| investigate | name the functions in `src/` that call `clamp`, changing nothing | the answer names `percent`, `progressBar`, `percent.js` and `bar.js`, and the tree is unchanged. A wrong extra name is not caught. |
| parallel | add `percent` and `progressBar` in two new files, both reusing `clamp` | the tests pass, and `clamp`, `percent` and `progressBar` are each defined once |
| review | implement `parseDuration` for s/m/h, have it reviewed independently, fix the findings | the tests pass, including the throw on an unknown unit |

## Measures

These are per trial, and each is summarized as a median or maximum over the trials.

- **pass@1 and pass^k**: `passPowerK` over the trials of one scenario and arm. A trial that timed out or hit its budget is incorrect.
- **tokens and cost**: the assistant usage recorded in every session file of the trial: the parent's, every Run's, and the example's children's (taken from its tool results). On faux, tokens are faux's own estimate (about 4 characters per token, tool definitions included) at zero cost.
- **wall ms**: from starting pi until the parent settled for good.
- **run startup ms**: for each fresh bluclawd Run, from its Admission until its pi's session began. This includes the queue wait and, for the first Run, the daemon's start.
- **parent requests and wakeups**: the parent's model requests, and how often it started working again without a prompt.
- **overlap**: files the parent read or edited that a child also read or edited. This is an upper bound on duplicated work.
- **conflicts**: paths an Integration refused. It is n/a for the arms that integrate nothing.
- **peak procs**: the trial's processes, sampled about every 100 ms. These are the parent, the daemon, and every descendant, such as Run hosts, Run pis and shell commands. A process that lives less than a sampling interval can be missed, such as a parent's quick `node --test`. That is why rows with the same script can differ by a few.
- **leftover**: processes other than the parent and the daemon still running once the parent settled for good.

## Running it live

The live run spends real model calls. The budget is a control for this experiment, not a limit on production Runs:

```sh
node scripts/eval-delegation.ts --live --model <provider/id> --thinking <level> --max-tokens <n> --max-dollars <n> \
  [--trials 3] [--arms stock,bluclawd,example] [--scenarios trivial,investigate,parallel,review] \
  [--agent-dir <dir>] [--out results.json]
```

- **Credentials**: come from the environment (the provider's API key variable), or from `--agent-dir`, which is used as it is. Use a dedicated agent dir: every trial's sessions, Run records and worktrees are left in it.
- **Without `--agent-dir`**: each trial gets a fresh temporary agent dir and its own daemon directory. Both are removed afterwards, and so is every process of the trial.
- **Budget**:
  - Before it starts, each trial reserves a quarter of the token and dollar budget in `EvaluationBudget`.
  - While it runs, it is stopped once its session files show more than that. The example's children keep no session file, so their spend is counted only after the trial.
  - Whatever a trial leaves unspent goes back to the budget.
  - When the budget cannot cover another trial, the run stops and reports what it has.
- **Dialogs**: nobody answers them, so each one is cancelled, as with no user present. A Run's approval request therefore ends blocked.
- **Failed launches**: if pi exits before it settles, as with an unknown model or a missing key, the trial records its stderr and the run stops.
- **Not yet exercised**: none of the live path has run. That covers the `main` loop, the budget stop, the example arm end to end, and whether a provider key in the environment reaches the Runs' pis. Only the example extension's loading was checked, on faux: it registers its `subagent` tool under `-ne`.

## Observed deterministic results

Recorded on 2026-11-11 with `npx vitest run test/subagents-delegation-eval.test.ts --silent=false`:

- **Revision**: `620da94`, after #311 made RPC runs the default and rewrote the tool descriptions. It replaces the first record, taken on `d6e8cee` behind `BLUCLAWD_RPC_RUNS=1`, where only the token columns moved by more than noise: about 150 more estimated tokens per bluclawd trial.
- **Versions**: pi 1.5.2 (all host packages), Node 26.8.1, macOS 27.2 on arm64.
- **Machine**: shared, with a 1-minute load average between 4 and 10 during the run.
- **Trials**: 2 per scenario and arm.

The model's choices are scripted:

- stock pi does every task itself.
- bluclawd follows the guidance:
  - it does the trivial edit itself;
  - it delegates the question to `explorer`, in the foreground, and once more in the background (the "investigate, background" row);
  - it gives the two edits as `tasks` and integrates both, with the check on the second;
  - it runs worker, `reviewer`, then a Resume of the worker as one `chain`, and integrates the chain.

| scenario | arm | pass@1 | pass^k | wall ms | tokens | parent requests | wakeups | run startup ms | overlap | conflicts | peak procs | leftover |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| trivial | stock | 1.00 | 1.00 | 278 | 4390 | 3 | 0 | n/a | 0 | n/a | 3 | 0 |
| trivial | bluclawd | 1.00 | 1.00 | 280 | 15172 | 3 | 0 | n/a | 0 | 0 | 3 | 0 |
| investigate | stock | 1.00 | 1.00 | 160 | 2954 | 2 | 0 | n/a | 0 | n/a | 1 | 0 |
| investigate | bluclawd | 1.00 | 1.00 | 936 | 13329 | 2 | 0 | 434 | 0 | 0 | 4 | 0 |
| investigate, background | stock | 1.00 | 1.00 | 162 | 2954 | 2 | 0 | n/a | 0 | n/a | 1 | 0 |
| investigate, background | bluclawd | 1.00 | 1.00 | 3495 | 20484 | 3 | 1 | 439 | 0 | 0 | 4 | 0 |
| parallel | stock | 1.00 | 1.00 | 279 | 4747 | 3 | 0 | n/a | 0 | n/a | 5 | 0 |
| parallel | bluclawd | 1.00 | 1.00 | 1475 | 34165 | 4 | 0 | 504 | 0 | 0 | 7 | 0 |
| review | stock | 1.00 | 1.00 | 326 | 8480 | 5 | 0 | n/a | 0 | n/a | 2 | 0 |
| review | bluclawd | 1.00 | 1.00 | 2446 | 28793 | 3 | 0 | 443 | 0 | 0 | 4 | 0 |

The review scenario's bluclawd wall time includes the test's own wait while it names the chain for the next step.

### What these show, and what they do not

- **Same results**: every trial of both arms was correct. Both arms left the same final tree.
- **Isolation**: the read-only Run worked in the checkout, with no worktree. The writers each worked in a worktree of their own.
- **No waste**: the parent never touched a file a Run had worked on, and no process was left running.
- **Wakeups**: a background Run sent three progress messages. The parent woke once, for its Report, and never for its progress. The background row's wall time includes the Run's scripted 2.5 s answer.
- **Cost of the tools, even unused**: the `subagents` extension's tools add about 3,600 estimated tokens to every parent request, through their definitions and this guidance. That is the trivial row's difference, where nothing was delegated.
- **Cost of each Run**: each Run then has a context of its own, and on this machine about 0.4 to 0.5 s of startup.
- **On a scripted model, delegating cost more and took longer**: in every scenario here it used more tokens and more time than doing the work directly. The scripts give the children no less to do than the parent, so the context a Run keeps out of the parent never pays off here.
- **Fewer parent requests**: in the review scenario the parent made 3 requests instead of 5, because the chain did the work.
- **What only live runs can show**: these figures support no claim of a cost or speed improvement, and no threshold was set. Whether context isolation, parallel work and independent review pay for their overhead with a real model depends on the model and the task. Only the live comparison above can show that.
