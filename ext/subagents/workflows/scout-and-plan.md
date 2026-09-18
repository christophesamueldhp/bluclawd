---
name: scout-and-plan
description: "Explore the relevant code, then turn what was found into an implementation plan. Input: the feature or change to plan."
chain:
  - agent: explore
    task: "Find the files, entry points, data flow and existing patterns relevant to: {input}. Report paths with line numbers."
  - agent: planner
    task: "Plan this change: {input}\n\nWhat exploration found:\n\n{previous}"
---
