---
description: Install, check, or remove the universal enforcement git hooks · Foundry Studio
argument-hint: '[install|status|uninstall]'
allowed-tools: Bash(node:*)
---

The operator's argument: $ARGUMENTS

If no argument was given, run `state-cli guard status` (the default). Otherwise
run `state-cli guard $ARGUMENTS` (must be `install`, `status`, or `uninstall`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" guard <install|status|uninstall>
```

Present the output to the operator. If the operator asked to install or
uninstall and the output shows it happened, confirm what changed (hooks
written or removed, prior hooks preserved/restored). The guard makes the
senior-dev gates hold outside Claude Code too — Cowork, Codex, and plain
terminals. `gh pr create` has no git hook and stays Claude-Code-only; say so
if asked.
