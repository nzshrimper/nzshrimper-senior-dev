# senior-dev

Claude Code plugin that orchestrates a disciplined senior-dev coding session:
classify the task, enforce the right installed-skill chain (superpowers,
codex, built-in reviews), gate commits/integration/stop on review +
verification + documentation, and close with a zero-leftovers hygiene sweep.

Design spec: `docs/superpowers/specs/2026-07-03-senior-dev-orchestrator-design.md`.

## What it adds

- **Conductor skill** (`senior-dev:conductor`) - classifies every coding task
  (feature / bug-fix / refactor / quick-fix / docs-only / investigation) and
  routes it through a mandatory chain of installed skills.
- **SessionStart bootstrap** - in any git repo, announces the conductor and
  resumes in-flight sessions. Silent outside git repos.
- **Commit/integration gate** (PreToolUse) - worktree commits need recorded
  green tests during implement/debug; merge/push/PR needs approved reviews,
  verification, and a complete docs gate. Classification is command-aware
  (heredoc/quote stripping, env-prefix and global-flag handling), so quoted
  prose mentioning git is not false-blocked and flag-inserted forms are still
  caught.
- **Stop gate** - a session claiming "done" with open gate items gets the
  checklist back, once per distinct state (never loops).
- **Codex phase reviews** - read-only `/codex:review` verdicts per phase,
  JSON contract, 3-cycle cap, post-review write-detection guard.
- **Docs gate** - spec, plan, handover, affected docs.
- **Hygiene sweep** - evidence-based zero-leftovers close.

All hooks fail open: a broken hook never blocks normal work. Gates arm only
while a session is active. `/senior-dev:bypass <reason>` is the logged escape
hatch.

## Choosing a skill source

Every run opens by asking which skills fill the process phases:

- **own** — your project's own skills
- **superpowers** (default) — the canonical chain
- **combo** — superpowers plus your project's skills where they exist
- **suggest** — search skills.sh via `find-skills` and pick

Your choice is saved per-repo in `.senior-dev/skills.json` (private by default;
run `state-cli skills-config share` to commit it for your team). A missing
process skill is never a dead end: the conductor gives you the exact install
command (and offers to run it) for a chain plugin, or `find-skills` candidates
for a domain skill — nothing installs without your yes.

## Install

```bash
claude plugin marketplace add ~/code/nzshrimper-senior-dev
claude plugin install senior-dev@nzshrimper-senior-dev
# restart Claude Code to load hooks
```

Update flow: edit source, bump both versions in `.claude-plugin/`, then
`claude plugin marketplace update nzshrimper-senior-dev` and
`claude plugin update senior-dev@nzshrimper-senior-dev`, restart.

## Commands

| Command | Does |
|---|---|
| `/senior-dev:start [task]` | Start or resume an orchestrated session |
| `/senior-dev:status` | Phase/gate/review/bypass report |
| `/senior-dev:bypass <reason>` | One-shot logged gate waiver |
| `/senior-dev:finish` | Final Codex pass, sweep, archive, evidence summary |

## State

`.senior-dev/state.json` in the target repo (auto-excluded via
`.git/info/exclude`; never touches your `.gitignore`). Closed sessions are
archived to `.senior-dev/history/`.

## Companion plugins

Designed to drive: [superpowers](https://github.com/obra/superpowers)
(process skills), the OpenAI codex plugin (read-only review lanes), and the
built-in `/code-review` + `verify` skills. Missing companions degrade
gracefully and are reported, never silently skipped.

## Tests

```bash
node --test tests/*.test.mjs
```
