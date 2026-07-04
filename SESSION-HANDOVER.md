# SESSION-HANDOVER — senior-dev plugin

**Updated:** 2026-07-04
**State:** v0.1.2 shipped skill-source selection + discovery: every run now
opens by asking own/superpowers(default)/combo/suggest, `find-skills` proposes
candidates for domain-skill gaps, and a curated chain-plugin source map gives
exact install commands (with assisted install and the restart caveat) for
missing chain skills. The choice is saved per-repo in `.senior-dev/skills.json`,
**private by default** (excluded via `.git/info/exclude`, same as the rest of
`.senior-dev/`), with a one-question `state-cli skills-config share` opt-in.
Full suite green (`node --test tests/*.test.mjs`). Builds on v0.1.0 (merged to
main `be03cf9`, tagged) and v0.1.1 (marketplace rename). **Live smoke PASSED
10/10 (2026-07-03)** on the v0.1.0/0.1.1 checklist — all original `tests/SMOKE.md`
items verified in a throwaway repo via nested `claude -p --resume` sessions,
including item 7's bypass `$ARGUMENTS` heredoc (reason recorded verbatim,
one-shot consumed, visible in status). The three new v0.1.2 SMOKE items
(skill-source fresh repo, share opt-in, chosen-but-missing chain plugin) are
written but not yet live-smoked — treat as open until run.

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

Nothing blocking for v0.1.0/0.1.1 (that live smoke is done, see State above).
Accepted Minor residuals from that work are listed in the final-review triage
(git history and the two review-fix commits document them); none block use.
The three new v0.1.2 SMOKE items are not yet live-smoked — next session should
run them before calling v0.1.2 fully verified.

## Update flow

Edit source → bump version in BOTH `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` → `claude plugin marketplace update
nzshrimper-senior-dev` → `claude plugin update senior-dev@nzshrimper-senior-dev` →
restart Claude Code.
