---
name: conductor
description: Use at the start of ANY coding task in a git repo - implement, add, build, fix, debug, or refactor a feature, bug fix, refactor, quick fix, docs change, or investigation - and when resuming a senior-dev session. Classifies the task, routes it through the mandatory installed-skill chain (superpowers brainstorming/worktrees/plans/TDD/systematic-debugging, built-in code-review and verify, read-only Codex phase reviews), records every phase in .senior-dev/state.json via the state CLI, and drives the docs gate and zero-leftovers hygiene sweep. Also use when the user runs /senior-dev:start, asks what phase the session is in, or asks to finish/close the session.
---

# senior-dev conductor

You are running a senior-dev session. You do not write code casually: every
task goes through classification, the mandatory skill chain, recorded phases,
review gates, and a clean close. The state CLI is the only way you record
progress — never hand-edit `.senior-dev/state.json`, never claim a phase is
done without recording it at that moment.

State CLI (all commands run from inside the target repo):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" <subcommand> [flags]
```

## 1. Engage

1. Run `node <plugin>/scripts/state-cli.mjs status` (the session bootstrap
   gives the exact path). If it reports an active session, resume at the
   reported phase; do not restart completed phases.
2. Otherwise classify the task as exactly one of the types below. If
   genuinely ambiguous, ask the operator ONE multiple-choice question.
3. Initialise: `state-cli init --task "<one-line task>" --type <type>`

| Type | When |
|---|---|
| `feature` | New behaviour or capability |
| `bug-fix` | Existing behaviour is wrong |
| `refactor` | Behaviour preserved, structure improved |
| `quick-fix` | ≤3 files, ≤~30 min, obvious change |
| `docs-only` | Prose/docs only, no code |
| `investigation` | Read-only question answering |

**Escalation rule:** a `quick-fix` that grows past 3 files or ~30 minutes is
no longer a quick fix. Tell the operator you are escalating, then close the
mini-session with `state-cli finish --force-open "escalating quick-fix to
<type>"` and immediately re-init at the stricter lane in the same turn (its
gates are still open mid-escalation - that's expected; the logged bypass
entry is the audit trail).

## Gates and bypass

- **Commit gate**: blocks `git commit` during `implement`/`debug` until
  `state-cli tests-green` is recorded for that phase; blocks
  `push`/`merge`/`gh pr create` until reviews are APPROVED, `verify` is
  done, and the docs gate is clear.
- **Stop gate**: challenges any claim that the session is done (or that
  you've reached the `finish` phase) while gate items are still open.
- The ONLY waiver is `/senior-dev:bypass <reason>` - operator-initiated
  only; you never arm it yourself. `finish --force-open` likewise requires
  operator sign-off - with ONE exception: the §1 escalation path, where you
  announce the escalation and immediately re-init at the stricter lane in
  the same turn (the logged bypass entry is the audit trail).

## 2. The chains

Phases are recorded with `state-cli phase <name> --status in_progress|done
[--artefact <path>]` — `in_progress` when you start, `done` with the artefact
path the moment the phase's deliverable exists.

**feature** — `brainstorm → worktree → plan → implement → review → verify → docs → finish`
1. `brainstorm`: invoke `superpowers:brainstorming`. Artefact: committed spec.
2. `worktree`: invoke `superpowers:using-git-worktrees`.
3. `plan`: invoke `superpowers:writing-plans`. Artefact: committed plan.
4. `implement`: invoke `superpowers:subagent-driven-development` (or
   `superpowers:executing-plans` inline) with
   `superpowers:test-driven-development`. After each green test run:
   `state-cli tests-green` (the commit gate requires it).
5. `review`: see §3.
6. `verify`: run the built-in `verify` skill (if it isn't installed, record
   a degrade and rely on the next step alone), then
   `superpowers:verification-before-completion`. Record:
   `state-cli phase verify --status done`.
7. `docs`: see §4.
8. `finish`: see §5.

**bug-fix** — `debug → implement → review → verify → docs → finish`
`debug` MUST be `superpowers:systematic-debugging` — no fixes before a root
cause. `implement` starts with a failing test reproducing the bug (TDD).

**refactor** — `worktree → plan → implement → review → verify → docs → finish`
Record a green baseline (`state-cli tests-green`) BEFORE changing anything,
then record it again on `implement` after each subsequent green run - the
baseline stamp does not carry forward as proof of a later green state.

**quick-fix** — `implement → review → verify → docs → finish`
No spec/plan. Review is `/code-review` as a single focused pass; no
subagent fan-out - plus ONE Codex pass.

**docs-only** — `implement → review → docs → finish`
Use `elements-of-style:writing-clearly-and-concisely` (and `humanizer` where
apt). Review = operator read-through. No Codex pass (low value on prose).

**investigation** — `investigate → finish`
Read-only. Report findings; offer to open a real lane. No gates beyond an
honest close.

**Domain overlays:** load the domain skills the task touches (frontend →
`impeccable`/design skills; project-specific skills per that repo's
CLAUDE.md). Project CLAUDE.md and operator instructions ALWAYS outrank these
defaults.

**Missing skills:** if a chain skill is not installed, record it —
`state-cli degrade --wanted <skill> --used <fallback> --reason "not installed"`
— tell the operator what to install, and use the nearest built-in equivalent.
Never silently skip the step.

## 3. Review phase (every lane except docs-only/investigation)

1. Claude pass: `superpowers:requesting-code-review` + built-in `/code-review`
   (or `/review` on older versions) on the phase diff. Fix findings via
   `superpowers:systematic-debugging` + TDD, never by patching blind.
   - Record: `state-cli review --phase <phase> --reviewer claude --verdict <V> --cycle <n>`
2. Codex pass (READ-ONLY — `/codex:review` or `/codex:adversarial-review`;
   NEVER any write-capable lane):
   - Capture `git status --porcelain` and `git log -1 --format=%H` BEFORE.
   - Ask Codex to review the phase diff and reply with ONLY:
     `{"verdict":"APPROVED"|"NEEDS_REVISION","concerns":[],"missedCases":[],"suggestions":[]}`
   - Reply isn't that exact JSON contract? Re-ask ONCE for JSON-only. Still
     not JSON → record `NEEDS_REVISION` and tell the operator.
   - Re-run the two git commands AFTER. Any difference = Codex wrote to the
     repo: stop everything and tell the operator immediately.
   - Record: `state-cli review --phase <phase> --reviewer codex --verdict <V> --cycle <n>`
3. `NEEDS_REVISION` → address concerns → re-review at cycle n+1. Cycle
   counters restart at 1 for each new `--phase` value - they don't carry
   over from a prior phase's reviews. **Cycle cap is 3** (the CLI enforces
   it). At the cap: stop iterating, present both positions to the operator,
   let them decide.

The §5 final pass over the whole branch diff uses this same contract and
records both reviewer passes as `--phase finish`.

## 4. Docs gate

Tick items only when true, the moment they become true:
`state-cli docs --spec true` / `--plan true` / `--handover true` / `--affectedDocs true`

- `spec`/`plan`: committed spec + plan (full lanes only; the CLI omits them
  from light lanes).
- `handover`: the repo's handover doc (SESSION-HANDOVER.md or the project's
  convention; ask once if none exists) describes the TRUE end state.
- `affectedDocs`: walk the final diff; any README/docs page the change
  invalidates is updated in the same branch. List what you checked.

## 5. Finish

Steps 1-2 apply only to lanes with a diff to integrate. `docs-only` skips
step 1 (no Codex pass on prose). `investigation` skips both 1 and 2 (no
branch exists) and goes straight to the sweep.

1. Final review passes - Claude `/code-review` + read-only Codex - over the
   complete branch diff, same procedure and recording as §3, recorded as
   `--phase finish`.
2. `superpowers:finishing-a-development-branch` (merge/PR/discard menu).
3. Hygiene sweep: `state-cli sweep` — then FIX anything it shows: stray
   worktrees, leftover branches, dirty status, surviving scratch files
   (track them during the session with `state-cli scratch --add <path>`).
   Where a remote exists, verify the pushed end, not just local state.
4. `state-cli finish` — archives state to `.senior-dev/history/` (refuses
   if gate items are still open; see "Gates and bypass").
5. Report to the operator with the sweep evidence pasted verbatim — actual
   command output, never assertions.

## Red flags — you are rationalizing if you think:

| Thought | Reality |
|---|---|
| "This change is too small for the flow" | That's what quick-fix lane is FOR. Classify it. |
| "I'll record the phases at the end" | Record at the moment of transition, or the gates lie. |
| "Codex will just agree" | Then the pass is cheap. Run it. |
| "I can skip the sweep, the repo looks clean" | Looks ≠ evidence. Run `state-cli sweep`. |
| "The docs are probably fine" | Walk the diff. Tick items only when verified. |
| "I'll bypass just this once, quietly" | Only the operator can bypass, and it is logged. Ask; don't arm it yourself. |
