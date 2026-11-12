# Delegation efficiency against stock pi

This compares bluclawd's delegation with stock pi 1.5.2 on the same tasks, model and thinking level. Correctness comes first, then cost and overhead. It also compares two bluclawd checkouts, to see whether a change to the text of bluclawd's tools changes what a model does (#337). The runner is `scripts/eval-delegation.ts`. Its deterministic suites run on the scripted faux model: `test/subagents-delegation-eval.test.ts` for delegation, and `test/eval-delegation-shells.test.ts` for the background-shell scenarios, the new measures and the credentials check.

**Live evidence has not been collected.** No paid model call was made for this record. Everything below comes from the scripted faux model, which measures what the machinery costs and keeps. It does not measure whether a real model delegates well.

## Arms

Every arm runs the parent as `pi --mode rpc -ne`, with the same `--model` and `--thinking`. Only the extensions differ.

- **stock**: no extensions (`-ne` also turns off pi's built-in `mcp`, `codemode` and `tool-search`).
- **bluclawd**: only bluclawd's `subagents` extension. Runs go through pi's RPC, the default since #311, under its delegation guidance. The rest of the package (permissions, sandbox, agent view and the others) is not loaded. Those extensions add their own tools and prompt text, so whole-package figures would be higher than these.
- **example** (live only): pi's example extension `examples/extensions/subagent`. pi ships it as an example; it is not built-in behavior. Its sample roles are installed with their pinned `model:` lines removed, so its children run on the model under evaluation. Its children are unnamed and share one faux script, so it cannot run on the scripted model.
- **before** and **after**: two bluclawd checkouts, each given on the command line (`--before <dir>`, `--after <dir>`). Each arm loads the four extensions that register tools from its own checkout: `background-bash`, `subagents`, `web` and `memory`, the list `scripts/prompt-footprint.ts` measures. Sandbox and permissions are not loaded, so a failure measured comes from the tools' text, not from policy. Both arms run the same pi and the same prompts, so they differ only by the checkouts. A checkout must have its dependencies installed: one without the four extensions or `node_modules` is refused before any model call.

On the faux model, each arm also loads the faux provider extension (`test/fixtures/real-pi/faux.ts`). It only registers the model.

## Scenarios

The same prompt is used for every arm. A fixture is a committed Git repository. Grading is done on the final tree with `gradeFixture` (`scripts/eval-subagents.ts`): the fixture's `node --test test/` must pass, and each named function must be defined exactly once. A scenario with a check of its own (`watch`) is graded by that check instead of tests. The model never sees the check.

| scenario | task | correct when |
|---|---|---|
| trivial | make `parseDuration` read minutes | the tests pass |
| investigate | name the functions in `src/` that call `clamp`, changing nothing | the answer names `percent`, `progressBar`, `percent.js` and `bar.js`, and the tree is unchanged. A wrong extra name is not caught. |
| parallel | have two subagents side by side each add one file, `percent` and `progressBar`, both reusing `clamp`, and bring both changes in | the tests pass, and `clamp`, `percent` and `progressBar` are each defined once |
| review | implement `parseDuration` for s/m/h as a chain of subagents (one implements, a reviewer checks), then have the implementer fix the findings in its own session, and bring the result in | the tests pass, including the throw on an unknown unit |
| watch | start `node server.js` in the background, be told when it prints `READY port=<port>` (about 2 s in), write the port to `port.txt`, stop the server | `port.txt` holds the port the server listened on, and the server was stopped |
| slow | run `node build.js`, which takes about 2 s, limited to 10 s | the tests pass: the build wrote `dist/app.txt` |

- **`parallel` and `review`** ask for subagents in so many words, so a model that follows them calls `subagent` with `tasks[]`, then `subagent_integrate` (`parallel`), or with `chain[]`, then `subagent_resume` (`review`). Their earlier prompts left delegating to the model, and in the first live record below it delegated nothing in `parallel`. That record used the earlier prompts. The `stock` arm has no subagents, so it can only do this work itself.
- **`watch`**: the prompt states the need ("tell me when that line appears: do not poll for it") and names no tool. The server listens on a port the system picks and records it beside the fixture, outside the repository, where the check reads it.
  - **Left running**: a server nobody stops keeps the trial from settling. After 120 s it gives up, records that, and exits, so the trial ends incorrect rather than running to its time limit.
- **`slow`**: the `bash` override takes `timeout` in milliseconds, with a 2-minute default. A model that sends `10` for "10 seconds" gets a 10 ms timeout. The command is still running then, so it moves to the background rather than being killed, and the result is not an error. The build may still finish and the trial pass, so this scenario's signal is the count of `bash` calls ended at their timeout, not its outcome. A scenario that relied on the default being too short would take minutes per trial.

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

The next three are about the parent's tool calls only: the text that #337 trims first is the orchestrator's. Each is summed over the trials of a row.

- **failed calls**: the parent's tool calls whose result was an error, of any kind. A `bash` command that exits non-zero, such as a test run that fails before a fix, counts too.
- **bash timeouts**: the parent's `bash` calls that ended at their timeout. This is read from the result's shape, not its wording, which the two arms may word differently. A foreground call whose result names a background task is counted, since nobody presses Ctrl+B or sends a message during a trial. A call killed at its timeout (pi's `Command timed out after` error) is counted as well. A command that starts with `sleep` is killed rather than moved.
- **tools**: the tools the parent called, by name. Per trial, the result also keeps how many times each was called. #337's coverage rule needs a tool to be called in both arms before its text counts as covered.

Every row is for one model, scenario and arm.

## Running it live

The live run spends real model calls. The budget is a control for this experiment, not a limit on production Runs:

```sh
node scripts/eval-delegation.ts --live --models <provider/id>[,<provider/id>...] --thinking <level> \
  --max-tokens <n> --max-dollars <n> [--trials 3] [--before <checkout> --after <checkout>] \
  [--arms stock,bluclawd,example] [--scenarios trivial,investigate,parallel,review,watch,slow] \
  [--auth <auth.json> | --agent-dir <dir>] [--out results.json]
```

- **Comparing two checkouts**: `--before` and `--after` make the arms `before,after` unless `--arms` says otherwise. For #337, `before` is a worktree of the work branch's merge-base with `origin/main`, with its dependencies installed, and `after` is the work branch:

  ```sh
  git worktree add ../bluclawd-before "$(git merge-base origin/main <work branch>)" && (cd ../bluclawd-before && npm ci)
  node scripts/eval-delegation.ts --live --before ../bluclawd-before --after . \
    --models openai-codex/gpt-6.1-sol,openai-codex/gpt-6.1-terra,openai-codex/gpt-6-luna,opencode-go/claude-haiku-5-5,anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5 \
    --thinking low --trials 1 --scenarios parallel,review,watch,slow \
    --max-tokens 4000000 --max-dollars 15 --auth ~/.pi/agent/auth.json --out results.json
  ```

  The models run in the order given. Rerunning one cell means narrowing `--models` and `--scenarios`.
- **Credentials**:
  - **From the environment**: the provider's API key variable.
  - **`--auth <auth.json>`**: each trial's fresh agent dir gets an `auth.json` that is a symlink to the one given, the user's. An OAuth refresh is then saved to that one file, not to a copy that the next trial would not see.
    - **Checked first**: before any trial, one small call is made per provider, through a fresh agent dir with the same link, using the first model listed for that provider. pi writes `auth.json` with `writeFileSync`, which follows a symlink, but this is checked rather than assumed. After each call the link must still be a symlink to the same file. Whether pi saved through it shows in the file's modification time only, and the run says so. The check never reads the file.
    - **If the link was replaced**: when a call or a trial leaves `auth.json` as anything but that link, the run stops and keeps that agent dir, since what pi saved there may be the only copy of a refreshed token. Ask the user before going on. Do not fall back to their own agent dir.
  - **`--agent-dir <dir>`**: the dir is used as it is. Use a dedicated agent dir: every trial's sessions, Run records and worktrees are left in it. With the memory extension loaded, Memories saved in one trial would also reach the next trial's prompt.
- **Without `--agent-dir`**: each trial gets a fresh temporary agent dir and its own daemon directory. Both are removed afterwards, and so is every process of the trial.
- **Environment**: `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` are removed along with every `BLUCLAWD_` variable, so the tools' text and `slow`'s default are the shipped ones.
- **Budget**: it covers every model, scenario, arm and trial of the run.
  - Before it starts, each trial reserves a quarter of the token and dollar budget in `EvaluationBudget`.
  - While it runs, it is stopped once its session files show more than that. The example's children keep no session file, so their spend is counted only after the trial.
  - Whatever a trial leaves unspent goes back to the budget.
  - When the budget cannot cover another trial, the run stops and reports what it has. Since a trial reserves a quarter, the run stops once less than a quarter of the budget is left, without ever passing it.
- **Dialogs**: nobody answers them, so each one is cancelled, as with no user present. A Run's approval request therefore ends blocked.
- **Failed launches**: if pi exits before it settles, as with an unknown model or a missing key, the trial records its stderr and the run stops.
- **Not yet exercised**: none of the live path has run. That covers the `main` loop, the budget stop, the example arm end to end, and whether a provider key in the environment reaches the Runs' pis. Only the example extension's loading was checked, on faux: it registers its `subagent` tool under `-ne`. For `before` and `after`, three things were checked on faux and nothing else. Each arm sends its own checkout's tool text: a marker put into one checkout's `monitor` description reached that arm's requests only. The scripted `parallel` and `review` trials pass in the `after` arm too, with all four extensions loaded; this was a one-off run, not a committed test. And the credentials check makes its call through a linked stand-in `auth.json`.

## Observed deterministic results

Recorded on 2026-11-11 with `npx vitest run test/subagents-delegation-eval.test.ts --silent=false`:

- **Revision**: `620da94`, after #311 made RPC runs the default and rewrote the tool descriptions. It replaces the first record, taken on `d6e8cee` behind `BLUCLAWD_RPC_RUNS=1`. Since then each bluclawd trial takes about 100 to 200 more estimated tokens, from #311's tool descriptions. Wall times moved within noise. Peak process counts moved by a few, which sampling explains (see **peak procs**).
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

### Background shells, scripted

`test/eval-delegation-shells.test.ts` runs `watch` and `slow` in the `after` arm, loading this checkout, with the parent's tool calls scripted. It shows that the grading and the counts work. It says nothing about how a real model does.

| script | outcome | failed calls | bash timeouts | wakeups |
|---|---|---|---|---|
| `watch`: `monitor` on the server, port written once the line arrived, `task_stop` | correct | 0 | 0 | 1 |
| `watch`: the same without `task_stop` | incorrect: cut short with the server running | – | – | – |
| `watch`: port written before the line arrived | incorrect: `port.txt` empty | – | – | – |
| `slow`: `timeout: 10000` | correct | 0 | 0 | 0 |
| `slow`: `timeout: 10`, then waiting for the build | correct | 0 | 1 | 1 |
| `slow`: `timeout: 10`, then `task_stop` of the build | incorrect | 0 | 1 | – |
| `slow`: `sleep 1; node build.js` with `timeout: 10`, killed | incorrect | 1 | 1 | – |

## First live run (2026-11-11)

One trial each of `investigate` and `parallel` (stock vs bluclawd) and of `review` (bluclawd only), on `openai-codex/gpt-6.1-sol` with thinking `low`, revision 75b0136, pi 1.5.2. The command was the one above with `--trials 1 --arms stock,bluclawd --max-dollars 2`, with `--scenarios investigate --max-tokens 200000`, `--scenarios parallel --max-tokens 400000`, or `--arms bluclawd --scenarios review --max-tokens 600000`.

| arm | correct | wall ms | tokens | cost $ | parent requests | Runs started |
|---|---|---|---|---|---|---|
| investigate: stock | yes | 10997 | 10740 | 0.0081 | 4 | — |
| investigate: bluclawd | yes | 10797 | 21517 | 0.0143 | 4 | 0 |
| parallel: stock | yes | 29384 | 24392 | 0.0195 | 8 | — |
| parallel: bluclawd | yes | 24266 | 44528 | 0.0310 | 8 | 0 |
| review: bluclawd | yes | 49534 | 52477 | 0.0476 | 7 | 1 (reviewer, 657 ms startup) |

- **In `investigate` and `parallel` the model delegated nothing**: its guidance tells it to do small work itself, and the fixture tasks are small. **In `review`, which asks for an independent review, it started one reviewer Run** (`duration-review`, backend `rpc`). That Run's pi ran on the real provider and its Report's outcome was `completed`; the final tree passed. A stock arm was not run for `review`, since stock pi has no independent reviewer. The bluclawd orchestrator worked on the real provider; the extra tokens are the tools' cost even when unused (see above).
- **One trial per scenario** shows no delegation quality and supports no cost or speed claim.
