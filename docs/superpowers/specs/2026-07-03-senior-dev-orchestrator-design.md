# senior-dev — Session Orchestrator Plugin — Design Spec

**Date:** 2026-07-03
**Status:** Approved design, pre-implementation
**Owner:** Chris Bennett
**Repo:** `~/code/senior-dev` (install via local marketplace `senior-dev-local`)

## 1. Purpose

Every coding session should behave like a disciplined senior developer with a
second reviewer looking over its shoulder. The plugin orchestrates a full
session — classify the task, insist on the right installed skills in the right
order, review and debug with Claude's own tooling, verify each phase's diff
with a read-only Codex pass, and refuse to close until the repo is clean and
the documentation is complete.

The plugin **orchestrates skills that already exist** (superpowers, the codex
plugin, built-in `/code-review`, `/verify`, `/simplify`, project/domain
skills). It duplicates none of them. Its job is routing and enforcement.

## 2. Why build it (research summary)

A July 2026 ecosystem survey (superpowers, openai/codex-plugin-cc, rhuss
cc-spex, modu-ai/moai-adk, automazeio/ccpm, barkain
workflow-orchestration, shinpr workflows, gotalab/cc-sdd, Anthropic official
plugins) found no project that combines:

1. **Cross-provider verification as a named phase gate** — the codex plugin's
   stop gate exists but is standalone and loop-prone; nobody fires Codex per
   workflow phase.
2. **Routing across the user's whole installed skill inventory** — superpowers
   routes only its own skills; barkain only its own agents.
3. **Documentation completeness as a hard gate** — MOAI's Sync phase is the
   nearest miss; nothing blocks completion on docs currency.
4. **End-of-session repo-hygiene verification** — worktree *creation* is
   common; a "zero leftovers" close-out check is not.

Patterns adopted from that survey: SessionStart bootstrap injection
(superpowers), logged bypass command + escalating soft enforcement (barkain),
JSON verdict contract with bounded review loop (okhlopkov dual-review),
resumable pipeline state file (cc-spex), two-stage review — spec compliance
then quality (superpowers).

## 3. Operator decisions (locked)

| Decision | Choice |
|---|---|
| Trigger | Both: SessionStart hook arms in git repos; `/senior-dev:start` engages explicitly |
| Enforcement | Hybrid: mandatory-language insistence + two hard gates (commit gate, stop gate), all fail-open |
| Codex pass | After each phase's diff; read-only lanes only (`/codex:review` / adversarial); never `codex-rescue`; 3-cycle cap then escalate to operator |
| Docs gate | Full set: spec committed, plan committed, session handover updated, affected README/docs updated |

## 4. Architecture

```
senior-dev/
├── .claude-plugin/plugin.json         # manifest
├── .claude-plugin/marketplace.json    # local marketplace entry
├── skills/
│   └── conductor/SKILL.md             # the brain: classify → route → insist → record
├── commands/
│   ├── start.md                       # /senior-dev:start [task]
│   ├── status.md                      # /senior-dev:status
│   ├── bypass.md                      # /senior-dev:bypass <reason>
│   └── finish.md                      # /senior-dev:finish
├── hooks/
│   └── hooks.json                     # SessionStart, PreToolUse(Bash), Stop
├── scripts/
│   ├── session-start.mjs              # bootstrap injection
│   ├── commit-gate.mjs                # PreToolUse gate on git commit/merge/push
│   ├── stop-gate.mjs                  # open-checklist gate at stop time
│   └── lib/state.mjs                  # shared state-file read/write + validation
├── docs/superpowers/specs/            # this spec
├── docs/superpowers/plans/            # implementation plan
└── tests/                             # hook script tests + smoke checklist
```

Runtime: Node (plain `.mjs`, no dependencies) — same as the codex plugin's
hooks. macOS/zsh assumed; no Homebrew-PATH reliance (hooks call `node` via
`/usr/bin/env`).

## 5. Component: SessionStart bootstrap

- Matcher: `startup|clear|compact` (same as superpowers).
- Script checks `git rev-parse --is-inside-work-tree`. **Not a repo → exits
  silently, zero output.**
- In a repo, injects a short bootstrap context block:
  - "Coding tasks in this session route through the `senior-dev:conductor`
    skill. Invoke it before starting any coding task."
  - If `.senior-dev/state.json` exists with an open session: a resume notice
    with task, phase, and open gates.
- The bootstrap **never arms the hard gates by itself.** Gates arm only when a
  state file with an active session exists (i.e., the conductor was actually
  engaged). Browsing, Q&A, and non-code work are never blocked.

## 6. Component: conductor skill (`senior-dev:conductor`)

The single skill the bootstrap and `/senior-dev:start` both invoke.

### 6.1 Classify

One of: `feature` · `bug-fix` · `refactor` · `quick-fix` · `docs-only` ·
`investigation`. If ambiguous, ask the operator (one question, multiple
choice). Escalation rule: a `quick-fix` that grows past 3 files or ~30
minutes is upgraded to its true type — the conductor re-plans rather than
stretching the light lane.

### 6.2 Route — mandatory skill chains

Chains reference skills by canonical name. At session start the conductor
verifies each is installed; a missing skill is reported with an install
suggestion, and the chain falls back to the nearest built-in equivalent
(recorded in state as a degradation, surfaced in `/senior-dev:status`).

**feature** (full lane):
1. `superpowers:brainstorming` → design spec committed
2. `superpowers:using-git-worktrees` → isolated worktree
3. `superpowers:writing-plans` → implementation plan committed
4. Implement: `superpowers:subagent-driven-development` (or
   `superpowers:executing-plans`) with `superpowers:test-driven-development`
5. Phase review (per milestone): `superpowers:requesting-code-review` +
   built-in `/code-review`, then **Codex gate** (§8)
6. On any failure: `superpowers:systematic-debugging` before any fix
7. `verify` (built-in) + `superpowers:verification-before-completion`
8. Docs gate (§9)
9. `superpowers:finishing-a-development-branch` + hygiene sweep (§10)

**bug-fix**: `systematic-debugging` first → failing test (TDD) → fix →
step 5 review chain → verify → docs gate (handover + affected docs; spec/plan
waived unless the fix grows) → finish.

**refactor**: worktree → light plan → green baseline recorded → implement →
review chain → verify → docs gate → finish.

**quick-fix** (light lane): direct edit permitted → `/code-review` (low
effort) + Codex review of the diff → `verify` → handover note → commit. No
spec/plan. Still cannot skip review, verification, or the hygiene close.

**docs-only**: edit → `elements-of-style:writing-clearly-and-concisely` (and
`humanizer` where apt) → operator review → commit. Codex pass skipped (low
value on prose). Stop gate still checks handover currency.

**investigation**: read-only, no gates, no state mutations beyond a findings
note. Ends by reporting findings and offering to open a lane.

**Domain overlays**: orthogonal to the process chain, the conductor loads
domain skills the task touches (frontend → `impeccable`/design skills;
project-specific skills; Foundry work → its named brand/web skills per
standing instructions). Project `CLAUDE.md` and operator instructions always
outrank the conductor's defaults.

### 6.3 Insist

Superpowers-grade mandatory language: if a chain step applies, it MUST be
invoked before proceeding; the conductor re-reads state before every phase
transition and refuses to mark a phase done without its artefact/verdict
recorded. Deviations require `/senior-dev:bypass <reason>` (logged).

### 6.4 Record

Every classification, phase transition, review verdict, degradation, and
bypass is written to the state file at the moment it happens — never
retrospectively from memory.

## 7. Component: state file

`.senior-dev/state.json` at the repo root. Excluded from the project's git
via `.git/info/exclude` (the conductor adds the line; the project's
`.gitignore` is never touched).

```json
{
  "version": 1,
  "task": "add poster fallback to SwipeCard",
  "type": "feature",
  "startedAt": "2026-07-03T09:00:00+12:00",
  "worktree": "/path/or/null",
  "chain": ["brainstorm", "worktree", "plan", "implement", "review", "verify", "docs", "finish"],
  "phases": {
    "brainstorm": { "status": "done", "artefact": "docs/superpowers/specs/..." },
    "implement":  { "status": "in_progress", "testsGreenAt": null }
  },
  "reviews": [
    { "phase": "implement", "reviewer": "codex", "cycle": 1,
      "verdict": "NEEDS_REVISION", "at": "..." }
  ],
  "docsGate": { "spec": true, "plan": true, "handover": false, "affectedDocs": false },
  "degradations": [ { "wanted": "superpowers:writing-plans", "used": "inline plan", "reason": "not installed" } ],
  "bypasses": [ { "at": "...", "reason": "operator: hotfix, gates waived" } ],
  "stopGate": { "lastSnapshotHash": null }
}
```

Corrupt or unparsable state → hooks fail open and the conductor offers to
re-initialise. Sessions are resumable across restarts (SessionStart resume
notice, §5).

## 8. Component: Codex phase gate

At each phase milestone (end of implement; after each debug fix batch; final
diff at finish) the conductor runs the codex plugin's **read-only** review
lane over that phase's diff, requesting the JSON verdict contract:

```json
{ "verdict": "APPROVED | NEEDS_REVISION",
  "concerns": [], "missedCases": [], "suggestions": [] }
```

- `NEEDS_REVISION` → back through `systematic-debugging`/TDD, then re-review.
- **Cycle cap: 3** per phase. Cap hit → stop iterating, present both
  positions to the operator (mirrors the standing "3 failed smokes = stop"
  rule).
- **Never** `codex-rescue` or any write-capable lane.
- After every Codex invocation the conductor runs `git status --porcelain`
  and `git log -1` and compares against pre-invocation state; any unexpected
  write/commit is surfaced immediately (standing incident guard).
- Codex unavailable (not installed / not authed) → recorded as a degradation;
  Claude-only review proceeds; `/senior-dev:status` and the finish summary
  show the missing second opinion. It does not block — but it is never
  silent.

## 9. Component: docs gate

Checked by the conductor, enforced by the stop gate. All four before close:

1. **Spec** committed (`docs/superpowers/specs/…`) — full lanes only.
2. **Plan** committed (`docs/superpowers/plans/…`) — full lanes only.
3. **Handover** — the repo's session-handover doc (`SESSION-HANDOVER.md` or
   the project's existing convention, autodetected; conductor asks once if
   none exists) updated to describe end state truthfully.
4. **Affected docs** — README/docs pages whose content the change invalidates
   are updated in the same branch. The conductor derives the checklist from
   the diff (e.g. changed CLI flags → README usage section) and records it in
   state; items are ticked as they're done.

Light lanes (quick-fix, bug-fix) waive items 1–2 by default; 3–4 always
apply.

## 10. Component: hard gates

Both gates: **fail open** on any script error, missing node, or unreadable
state; **inert** unless an active session exists in state.

### 10.1 Commit gate — PreToolUse on Bash

Matches `git commit`, `git merge`, `git push`, `gh pr create` (simple
pattern on the command string). Policy (refined from the one-line design wording — see §13):

- **Inside the feature worktree/branch:** incremental commits allowed once
  the current phase records green tests (`testsGreenAt` set). This keeps the
  superpowers commit-per-task flow working.
- **Integration actions** (merge to main, push, PR creation): blocked until
  the phase reviews are `APPROVED`, verification is recorded, and the docs
  gate is fully ticked.
- Block = exit 2 with a one-line stderr message naming the exact missing
  gate and the command to see detail (`/senior-dev:status`).
- `/senior-dev:bypass <reason>` lifts gates for the named action; the bypass
  is written to state and echoed in the finish summary.

### 10.2 Stop gate — Stop hook

If an active session has open gate items and the transcript's last assistant
message claims completion, the hook blocks once and returns the open
checklist. **Loop protection:** the hook hashes the open-items snapshot into
state; if the next stop attempt presents an identical snapshot, it allows the
stop with a warning line instead of blocking again. One block per distinct
state — never a ping-pong.

## 11. Commands

| Command | Does |
|---|---|
| `/senior-dev:start [task]` | Engage conductor: classify, build chain, init state |
| `/senior-dev:status` | Human-readable phase/gate/degradation/bypass report from state |
| `/senior-dev:bypass <reason>` | Logged gate waiver (reason required) |
| `/senior-dev:finish` | Run docs gate + Codex final pass + hygiene sweep + close session, emit summary |

## 12. Hygiene sweep (inside finish)

After `finishing-a-development-branch`'s merge/PR/discard menu:

- `git worktree list` → no stray worktrees
- `git branch --list` → no orphan feature branches (post-merge)
- `git status --porcelain` → empty
- scratch/temp files created during the session (tracked in state) → gone
- verification runs against the **pushed/remote** end of the chain where one
  exists, not just local state (standing rule: check the deployed end)
- state file archived to `.senior-dev/history/<date>-<slug>.json`, active
  state cleared

The finish summary reports each check with its actual command output — 
evidence, not assertion.

## 13. Deviations from the approved design wording

One refinement, flagged for operator sign-off at spec review: the approved
one-liner said "git commit is blocked until the phase's review + verification
are recorded." Applied literally this breaks the superpowers
commit-after-each-task flow inside a worktree. §10.1 therefore gates
**integration** (merge/push/PR) on full review+verify+docs, while worktree
commits need only green tests. Same protection where it matters, no fighting
the TDD loop.

## 14. Failure modes

| Failure | Behaviour |
|---|---|
| Hook script crashes / node missing | Fail open, log to stderr, never block |
| State file corrupt | Fail open; conductor offers re-init |
| Codex plugin absent/unauthed | Degradation recorded; Claude-only review; visible in status + finish |
| A chain skill missing | Degradation + nearest built-in fallback + install suggestion |
| Stop-gate loop risk | Snapshot-hash loop protection (§10.2) |
| Quick-fix scope creep | Escalation rule upgrades the lane (§6.1) |
| Operator needs out | `/senior-dev:bypass <reason>`, always available, always logged |

## 15. Testing

- **Unit**: state.mjs (read/write/validate/corrupt input), commit-gate
  decision table, stop-gate snapshot hashing. Plain node test runner, no deps.
- **Static**: `plugin-dev:plugin-validator` on the plugin;
  `plugin-dev:skill-reviewer` on the conductor skill; skill description
  ≤1024 chars (standing marketplace-validation constraint).
- **Smoke** (scripted, throwaway repo in scratchpad): full feature lane
  end-to-end; quick-fix lane; gate block + bypass; stop-gate loop protection;
  Codex-absent degradation; non-repo silence.

## 16. Out of scope (v1)

- Auto-selecting *domain* skills beyond the overlay nudge (operator/project
  instructions rule).
- Multi-repo sessions, CI watching, PR auto-creation.
- Any write-capable Codex lane. Ever.
- Windows support.

## 17. Success criteria

1. In a git repo, a new session announces the conductor; outside one, silence.
2. A feature task cannot reach merge/push with an unreviewed diff, failed
   verification, or unticked docs gate — except via a logged bypass.
3. Codex reviews every phase diff read-only; 3-cycle cap holds; a Codex write
   would be caught and surfaced.
4. A finished session leaves zero leftovers, an accurate handover, and an
   evidence-backed finish summary.
5. A quick fix stays quick: classify → edit → review → verify → close in
   minutes, no spec/plan demanded.
