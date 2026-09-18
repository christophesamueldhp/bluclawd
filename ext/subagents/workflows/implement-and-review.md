---
name: implement-and-review
description: "Implement a change, then have it reviewed with fresh eyes. Input: the change to make, as specific as possible."
chain:
  - agent: general-purpose
    task: "Implement: {input}\n\nWhen done, list every file you changed and how you verified it."
  - agent: code-reviewer
    task: "Review the change just made (use git diff) against its goal: {input}\n\nThe implementer's report:\n\n{previous}"
---
