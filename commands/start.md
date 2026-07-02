---
description: Start (or resume) an orchestrated senior-dev session for a task
argument-hint: '[task description]'
---

Invoke the `senior-dev:conductor` skill now and follow it exactly.

Task from the operator: $ARGUMENTS

If no task was given, ask the operator what the task is (one question), then
proceed through the conductor's Engage steps: resume if a session is active,
otherwise classify and `init`.
