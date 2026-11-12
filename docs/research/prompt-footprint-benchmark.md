# Prompt footprint benchmark (#341)

The live check of #340's trimming of the orchestrator's Prompt footprint, run by hand on 2026-11-12 with `scripts/eval-delegation.ts` (spec #337).

**What it shows, and what it does not.** One pass/fail trial a cell, on four small fixtures, catches gross breakage only. Every cell passed in both arms but one, `watch` on gpt-6-luna, which failed in both. So this record shows that no tool group broke a scenario outright. It says nothing about whether the models work as well as before on real tasks. The trimming rules and the coverage rule are the main guard; this benchmark was the last check.

## Setup

- **Arms:** "before" is `2a8e0c4`, the trimming branch's merge-base with `origin/main`, in a worktree of its own. "after" is the trimming branch (`prompt-footprint`). Both load background-bash, subagents, web and memory from their own checkout, with no sandbox or permissions, and run the same pi and the same prompts.
- **Scenarios:** `parallel`, `review`, `watch`, `slow` (described in `docs/research/delegation-efficiency.md`).
- **Thinking:** `low`, one trial a cell.
- **Models:** `openai-codex/gpt-6.1-sol` first, then `openai-codex/gpt-6.1-terra`, `openai-codex/gpt-6-luna` and `opencode-go/claude-haiku-5-5`. `anthropic/claude-sonnet-5-5` and `anthropic/claude-opus-5-5` did not run: the credentials check got `401 invalid x-api-key` before any trial, and the user chose to leave both out.
- **Budget:** the user raised the spec's 4 million tokens to 8 million during the run; dollars stayed at $15. Spent: **42 trials, 3,380,219 tokens, $1.29** (openai-codex is billed by subscription, so its dollar figures are notional).
- **Credentials:** a fresh agent dir per trial with `auth.json` linked to the user's. One call per provider before any trial; the link was still the link after every trial.

## Footprint

Orchestrator, `node scripts/prompt-footprint.ts` (darwin, TUI, empty Memory index, the bundled roles), in characters:

| State | Footprint | vs `origin/main` |
|---|---:|---:|
| `origin/main` (before arm) | 23,957 | — |
| #340 trimmed | 19,574 | −18.3% |
| After the subagent group's revert (what merges) | 22,738 | −5.1% |

The 1,219 characters that stay cut: dead parameters and exact duplicates (397), `monitor` with background `bash` and `task_stop` (748), and the `bash` timeout (74).

## Results

The first five `review` rows of gpt-6.1-sol ran against the trimmed subagent text; every row from "subagent reverted" on ran against the reverted one, which is what merges. "Failed calls" counts the parent's error tool results of any kind; "bash timeouts" counts the parent's `bash` calls that ended at their timeout.

| Run | Model | Scenario | Arm | Outcome | Failed calls | bash timeouts | Tools called | Tokens | Cost $ |
|---|---|---|---|---|---:|---:|---|---:|---:|
| round 1 | gpt-6.1-sol | parallel | before | pass | 0 | 0 | bash, subagent, subagent_integrate ×2 | 90,125 | 0.092 |
| round 1 | gpt-6.1-sol | parallel | after | pass | 0 | 0 | bash, subagent, subagent_integrate ×2 | 92,879 | 0.099 |
| round 1 | gpt-6.1-sol | review | before | pass | 0 | 0 | subagent, subagent_integrate | 95,855 | 0.105 |
| round 1 | gpt-6.1-sol | review | after | pass | 1 | 0 | subagent, subagent_resume, subagent_integrate ×3 | 124,796 | 0.076 |
| round 1 | gpt-6.1-sol | watch | before | pass | 0 | 0 | monitor, write, task_stop | 38,195 | 0.035 |
| round 1 | gpt-6.1-sol | watch | after | pass | 0 | 0 | monitor, write, task_stop | 33,675 | 0.031 |
| round 1 | gpt-6.1-sol | slow | before | pass | 0 | 0 | bash | 14,768 | 0.016 |
| round 1 | gpt-6.1-sol | slow | after | pass | 0 | 0 | bash | 12,986 | 0.015 |
| rerun | gpt-6.1-sol | review | before | pass | 0 | 0 | subagent, subagent_integrate | 88,447 | 0.090 |
| rerun | gpt-6.1-sol | review | after | pass | 1 | 0 | subagent, subagent_resume, subagent_integrate ×3 | 119,089 | 0.087 |
| rerun | gpt-6.1-sol | review | before | pass | 0 | 0 | subagent, subagent_integrate | 79,338 | 0.097 |
| rerun | gpt-6.1-sol | review | after | pass | 0 | 0 | subagent, subagent_integrate | 79,168 | 0.076 |
| subagent reverted | gpt-6.1-sol | review | before | pass | 0 | 0 | subagent, subagent_integrate | 99,219 | 0.107 |
| subagent reverted | gpt-6.1-sol | review | after | pass | 0 | 0 | subagent, subagent_integrate | 86,716 | 0.096 |
| round 2 | gpt-6.1-terra | parallel | before | pass | 0 | 0 | subagent, subagent_integrate ×2 | 75,500 | 0.039 |
| round 2 | gpt-6.1-terra | parallel | after | pass | 0 | 0 | subagent, subagent_integrate ×2 | 86,078 | 0.045 |
| round 2 | gpt-6.1-terra | review | before | pass | 0 | 0 | subagent, subagent_integrate | 70,792 | 0.028 |
| round 2 | gpt-6.1-terra | review | after | pass | 0 | 0 | subagent, subagent_integrate | 73,357 | 0.033 |
| round 2 | gpt-6.1-terra | watch | before | pass | 0 | 0 | bash ×2, monitor, write, task_stop | 55,079 | 0.013 |
| round 2 | gpt-6.1-terra | watch | after | pass | 0 | 0 | monitor, write, task_stop | 37,146 | 0.010 |
| round 2 | gpt-6.1-terra | slow | before | pass | 0 | 0 | bash | 14,771 | 0.008 |
| round 2 | gpt-6.1-terra | slow | after | pass | 0 | 0 | bash | 14,263 | 0.008 |
| round 2 | gpt-6-luna | parallel | before | pass | 0 | 0 | subagent, subagent_integrate ×2 | 91,553 | 0.005 |
| round 2 | gpt-6-luna | parallel | after | pass | 0 | 0 | subagent, subagent_integrate ×2 | 85,596 | 0.004 |
| round 2 | gpt-6-luna | review | before | pass | 1 | 0 | subagent ×2, subagent_integrate | 66,341 | 0.003 |
| round 2 | gpt-6-luna | review | after | pass | 0 | 0 | subagent, subagent_integrate | 57,769 | 0.004 |
| round 2 | gpt-6-luna | watch | before | fail | 0 | 0 | bash, read, write | 38,951 | 0.001 |
| round 2 | gpt-6-luna | watch | after | fail | 0 | 0 | bash, read, write | 37,691 | 0.001 |
| round 2 | gpt-6-luna | slow | before | pass | 0 | 0 | bash | 14,770 | 0.001 |
| round 2 | gpt-6-luna | slow | after | pass | 0 | 0 | bash | 14,257 | 0.001 |
| round 2 | claude-haiku-5-5 | parallel | before | pass | 0 | 0 | bash ×3, subagent | 102,941 | 0.006 |
| round 2 | claude-haiku-5-5 | parallel | after | pass | 0 | 0 | bash ×2, subagent | 99,106 | 0.005 |
| round 2 | claude-haiku-5-5 | review | before | pass | 1 | 0 | bash ×4, subagent ×2, subagent_integrate | 172,580 | 0.007 |
| round 2 | claude-haiku-5-5 | review | after | pass | 3 | 0 | bash ×4, subagent ×2, subagent_integrate ×2 | 199,807 | 0.007 |
| round 2 | claude-haiku-5-5 | watch | before | pass | 0 | 0 | bash ×4 | 59,199 | 0.002 |
| round 2 | claude-haiku-5-5 | watch | after | pass | 0 | 0 | bash ×2, monitor ×2 | 99,422 | 0.002 |
| round 2 | claude-haiku-5-5 | slow | before | pass | 0 | 0 | bash | 26,456 | 0.001 |
| round 2 | claude-haiku-5-5 | slow | after | pass | 0 | 0 | bash | 25,660 | 0.001 |
| rerun | claude-haiku-5-5 | review | before | pass | 2 | 0 | bash ×3, subagent ×2, subagent_integrate | 164,559 | 0.006 |
| rerun | claude-haiku-5-5 | review | after | pass | 1 | 0 | bash ×3, subagent ×2, subagent_integrate | 173,836 | 0.007 |
| rerun | claude-haiku-5-5 | review | before | pass | 1 | 0 | bash ×3, subagent ×2, subagent_integrate | 166,078 | 0.007 |
| rerun | claude-haiku-5-5 | review | after | pass | 3 | 0 | bash ×4, subagent ×3, subagent_integrate | 201,405 | 0.008 |

## Regressions

**gpt-6.1-sol, `review`: a regression by the spec's rule, reverted.** The trimmed arm had more failed calls than before in 2 of 3 trials, and before had none. In those two trials the model ran the chain (implement, then review), then a separate `subagent_resume` and three `subagent_integrate` calls: seven requests and about 30% more tokens. Every before trial ran implement → review → resume as one `subagent` call, with a `resume` step in `chain[]`, and integrated once. With the trimmed text the model saw less often that a chain step can resume an earlier one. The subagent tool group (`subagent` and the six `subagent_*` tools) is reverted, keeping only the dead `confirmProjectAgents` out of the schema. Rerun on sol afterwards, `review` matched before: pass, no failed call, three requests, in both arms.

**claude-haiku-5-5, `review`: more failed calls after in 2 of 3 trials (3, 1, 3 against 1, 2, 1), with nothing left to revert.** By then the subagent tools' text was the same in both arms, and the failures were of the same two kinds in both:

- `subagent: chain[2]: a step that resumes an earlier one goes on with its role, name and cwd: leave out name.`
- JavaScript typed into `bash`.

The rule's revert unit for `review` is the subagent group, which was already reverted, so the record states the result and changes nothing more. The first error is a usability problem of the subagent tool's own text, present on `origin/main`, and beyond this spec's scope.

**gpt-6-luna, `watch`: failed in both arms**, the same way: the model started the server with `bash`, did not use `monitor`, and left the server running. Not a regression.

## Coverage

A trimmed tool counts as covered only if it was called in both arms of some trial.

| Tool | Trimmed by | Called in both arms | Kept |
|---|---|---|---|
| `subagent`, `subagent_integrate` | subagent group | yes (all four models) | Reverted for the `review` regression |
| `subagent_resume`, `_message`, `_stop`, `_status`, `_models` | subagent group | no (`subagent_resume` in the trimmed after arm only) | Reverted with the group |
| `monitor` | monitor/background group | yes (sol, terra) | Trimmed |
| `bash` (background guideline, timeout) | monitor/background group, bash timeout | yes (every model) | Trimmed |
| `task_stop` | dead `shell_id` only | yes (sol, terra) | Trimmed |
| `memory`, `webfetch` | exact duplicates only | no | Kept: duplicate cuts stay whether covered or not |
| `schedule_wakeup`, `websearch` | nothing | no | — |

## Leftovers

After each run, no process the trials started was still running, and the before worktree was removed at the end.
