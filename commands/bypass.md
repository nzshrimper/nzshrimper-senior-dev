---
description: Waive the next senior-dev gate action (one-shot, reason required, logged)
argument-hint: '<reason>'
allowed-tools: Bash(node:*)
---

The operator wants to bypass a senior-dev gate. Their reason: $ARGUMENTS

If the reason is empty, ask for one - a bypass without a reason is refused.

Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" bypass --reason "$ARGUMENTS"`

Confirm to the operator: the NEXT gated action (commit/merge/push/PR) will be
allowed through, the bypass is logged in session state, and it will appear in
the finish summary.
