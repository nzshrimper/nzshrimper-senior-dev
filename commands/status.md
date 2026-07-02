---
description: Show the senior-dev session state - phases, gates, reviews, degradations, bypasses
disable-model-invocation: false
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" status`

Present the command output above to the operator verbatim in a code block.
If it shows open gate items, add one sentence on what the next action is.
Do not editorialize beyond that.
