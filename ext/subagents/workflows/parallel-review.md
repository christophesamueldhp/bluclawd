---
name: parallel-review
description: "Three independent code reviews in parallel — correctness and security, tests, needless complexity — merged into one prioritized list. Input: what to review (a diff, files, or a change description)."
chain:
  - parallel:
      - agent: code-reviewer
        task: "Review for correctness and security only. Target: {input}"
      - agent: code-reviewer
        task: "Review the tests only: missing cases, weak assertions, untested paths. Target: {input}"
      - agent: code-reviewer
        task: "Review for needless complexity only: what could be simpler or removed. Target: {input}"
  - agent: general-purpose
    task: "Merge these independent reviews into one list, most severe first. Drop duplicates and anything not backed by a concrete scenario.\n\n{previous}"
---
