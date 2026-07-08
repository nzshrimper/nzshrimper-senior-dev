---
description: Show and customise which skills fill each process phase · Foundry Studio
argument-hint: '[lane]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" skills-config resolve --lane $ARGUMENTS`

Present the resolved table above to the operator verbatim. Then offer the
per-phase picker from the `senior-dev:conductor` skill ("Skill source
resolution" section): for any phase they want to change, collect their pick
and record it with
`state-cli skills-config set-lane <lane> --steps 'phase=skill|fallback,...'`.
