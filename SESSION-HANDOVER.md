# SESSION-HANDOVER — senior-dev plugin

**Updated:** 2026-07-03
**State:** v0.1.0 built, merged to main (`be03cf9`), tagged. 81/81 tests green
(`node --test tests/*.test.mjs`). Installed via local marketplace
`senior-dev-local` — hooks load after the next Claude Code restart.

## What this is

Session orchestrator plugin: conductor skill (task classification + mandatory
installed-skill chains), state CLI, three fail-open hooks (SessionStart
bootstrap, commit/integration gate, stop gate), four commands
(`/senior-dev:start|status|bypass|finish`), read-only Codex phase reviews
(3-cycle cap), docs gate, zero-leftovers hygiene sweep.

Spec: `docs/superpowers/specs/2026-07-03-senior-dev-orchestrator-design.md`
Plan: `docs/superpowers/plans/2026-07-03-senior-dev-orchestrator.md`

## How it was built

Subagent-driven: 11 tasks, fresh implementer + spec/quality reviewer per task,
fix waves re-reviewed until approved, final whole-branch review on the most
capable model. Notable hardening beyond the plan (all operator-visible in git
history): command-aware commit-gate classifier (2 rounds), realpath-safe main
guard, bypass reason via stdin heredoc, `finish --force-open` enforcement
close, worktree-aware repo-root resolution, unique archive filenames.

## Remaining

1. **Live smoke** — `tests/SMOKE.md`, 10 items, run in a throwaway repo after
   restart. Item 7 (bypass `$ARGUMENTS` substitution) is the one thing only a
   live installed session can verify.
2. Accepted Minor residuals are listed in the final-review triage (git history
   and the two review-fix commits document them); none block use.

## Update flow

Edit source → bump version in BOTH `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` → `claude plugin marketplace update
senior-dev-local` → `claude plugin update senior-dev@senior-dev-local` →
restart Claude Code.
