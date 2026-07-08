# senior-dev v0.2 — Universal Guard + Skill Picker — Design Spec

**Date:** 2026-07-08
**Status:** Approved design, pre-implementation
**Owner:** Chris Bennett
**Repo:** `~/code/nzshrimper-senior-dev` (marketplace `nzshrimper-senior-dev`)

## 1. Purpose

Two features, one release:

1. **Universal guard.** The hard gates currently live in Claude Code plugin
   hooks, which verifiably do not fire in Cowork or OpenAI Codex (live-tested
   2026-07-07: the same staged `git push` that Claude Code blocks ran to git's
   own output on both hosts). v0.2 adds a **git-hook enforcement layer** —
   `pre-push`, `pre-commit`, `pre-merge-commit` — installed into the repo with
   the operator's once-per-repo consent, so the gates hold wherever git runs:
   Cowork, Codex, plain terminals.
2. **Skill picker + richer mapping.** `own`/`combo` sources currently rely on
   detection plus a flat `steps` map. v0.2 adds an **interactive per-phase
   picker** that writes a **v2 schema**: per-lane overrides and ordered
   fallback lists, with the v1 flat map still honoured.

## 2. Operator decisions (locked)

| Decision | Choice |
|---|---|
| Approach | A — self-contained guard bundle in `.senior-dev/guard/`, thin chained shims in `.git/hooks/` (no dependency on the plugin's install path, which changes every version) |
| Skill control | Both: interactive per-phase picker AND the richer schema underneath (picker writes it; hand-editing stays possible) |
| Hook install consent | Ask once per repo at Engage; answer remembered in `skills.json` (`guard: installed\|declined`); re-offer only if hooks go missing |
| Fail mode | Guard fails **open** with a loud warning when it cannot evaluate (node missing, state unreadable) — consistent with the plugin's fail-open doctrine |
| Coexistence | Existing hooks preserved and chained (`<name>.pre-senior-dev`), never clobbered; `core.hooksPath` (husky etc.) respected — install there or give exact manual instructions |
| Double-gating | Pass-token handshake: the Claude Code PreToolUse gate stays primary and issues a short-lived single-use token on allow; the git hook honours a fresh token instead of re-evaluating (bypass consumed exactly once) |

## 3. Component: guard bundle (`.senior-dev/guard/`)

Installed/refreshed by `state-cli guard install`:

- `guard.mjs` — standalone gate evaluator. At install time the CLI copies the
  current `lib/state.mjs` logic in (single self-contained file or
  `guard.mjs` + a copied `state-lib.mjs` beside it — plan decides the exact
  packaging), so the bundle:
  - reads `.senior-dev/state.json` via the same worktree-aware root resolution,
  - computes the **same** policies as `commit-gate.mjs` today:
    commit policy (tests-green during implement/debug) for `pre-commit`,
    integration policy (`integrationBlockers`) for `pre-push` and
    `pre-merge-commit`,
  - honours `bypassArmed` with the same consume-only-on-would-block semantics,
  - honours the pass token (§5),
  - exits 1 with the same block-message format the gates use today
    (`senior-dev gate: integration blocked (N items): …`), exits 0 otherwise,
  - **fails open** (exit 0 + warning to stderr) on any internal error.
- `version` — plugin version stamp. The conductor refreshes a stale bundle at
  session start (silent copy; no consent needed once guard is installed).

`state-cli guard status` → `installed | stale | absent | declined` (+ which
hooks are wired). `state-cli guard uninstall` → removes shims, restores any
preserved prior hooks, deletes the bundle, sets `guard: "declined"`.

Inert without a session: like every gate, the guard exits 0 immediately when
no active session exists in state.

## 4. Component: git hook shims

Thin POSIX-sh files written to the repo's **active** hooks directory
(`git config core.hooksPath` if set, else `.git/hooks/`): `pre-push`,
`pre-commit`, `pre-merge-commit`. Each shim:

1. Chains any preserved prior hook first (`<name>.pre-senior-dev`); if it
   exits non-zero, the shim stops there (prior hook's verdict stands).
2. Locates `node` (`command -v node`); absent → loud stderr warning, exit 0
   (fail open).
3. Execs `node .senior-dev/guard/guard.mjs <hook-name> "$@"` from the repo
   root; passes the guard's exit code through.

Worktree note: git runs linked-worktree hooks from the main checkout's hooks
directory, and the guard's root resolution is already worktree-aware — so one
install covers the repo's worktrees.

Honest coverage statement (goes in README too): git hooks cover **commit,
merge, and push**. `gh pr create` has **no client-side git hook** — PR
creation remains enforceable only under Claude Code's PreToolUse gate.

## 5. Component: pass token (no double-gating)

File: `.senior-dev/guard/pass.json` — `{ "commandHash": "<sha256 of the
allowed command string>", "expiresAt": "<ISO, now+60s>" }`.

- Written by `commit-gate.mjs` (Claude Code PreToolUse) **only when it allows
  an integration action during an active session with the guard installed**.
- The guard, before evaluating: if a token exists, is unexpired, and (for
  pre-push) matches an integration allowance, it **consumes** the token
  (deletes the file) and exits 0.
- Off Claude Code no token is ever written, so the guard always evaluates.
- Expired/stale tokens are deleted on sight. Token logic never throws (fail
  open into normal evaluation).

This keeps PreToolUse primary in Claude Code (unbypassable, pre-git), makes
the one-shot bypass consumable exactly once, and prevents block-after-allow.

## 6. Component: consent flow (conductor Engage)

New Engage sub-step after the skill-source step, fresh runs only:

- `skills.json.guard` absent → ask once: "Install the universal enforcement
  hooks? They make the gates hold in Cowork, Codex, and plain terminals too —
  written to this repo's git hooks, existing hooks preserved."
  - Yes → `state-cli guard install`; record `guard: "installed"`.
  - No → record `guard: "declined"`; never re-ask.
- `guard: "installed"` but hooks/bundle missing (checked via `guard status`)
  → mention it once and re-offer.
- `guard: "declined"` → silent. `/senior-dev:guard` command (or
  `state-cli guard install`) remains available to opt in later.

## 7. skills.json schema v2

```json
{
  "version": 2,
  "source": "combo",
  "shared": false,
  "guard": "installed",
  "steps": { "plan": "my-org:planner" },
  "lanes": {
    "feature": { "implement": ["my-org:builder", "superpowers:subagent-driven-development"] },
    "bug-fix": { "debug": "my-org:debugger" }
  }
}
```

- `steps` (v1, kept): flat phase→skill, applies to all lanes.
- `lanes` (new): per-lane phase overrides. Values: string or **ordered
  fallback array** — first *installed* skill wins; any skipped entry is
  recorded via the existing `degrade` path.
- Resolution precedence: `lanes[lane][phase]` → `steps[phase]` → the source's
  default for that phase.
- `guard`: `"installed" | "declined"` (absent = not yet asked).
- **Compatibility:** `readSkillsConfig` accepts version 1 and 2; v1 files work
  unchanged; the first write through the new CLI upgrades in place. Corrupt →
  null → re-ask (unchanged).

## 8. Component: picker + skills command

- **Picker** (conductor prose): offered when the operator chooses `own` or
  `combo`, or asks to customise. Walks the current lane's phases; per phase
  shows current mapping, detected project skills, installed candidates;
  operator picks per phase or accepts all defaults in one answer. Writes via
  the CLI (never hand-edits JSON):
  `state-cli skills-config set-lane <lane> --steps 'implement=my-org:builder|superpowers:subagent-driven-development,debug=my-org:debugger'`
  (`|` = ordered fallback within a phase; `,` separates phases; parse splits
  phase=… on the FIRST `=`).
- **`/senior-dev:skills` command**: prints the resolved phase→skill table for
  the active/likely lane (via a new `state-cli skills-config resolve
  [--lane <lane>] [--type <type>]` that applies the precedence rules and
  marks which entries are fallbacks or missing), then offers the picker.

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Guard can't read/parse state | Fail open + stderr warning |
| node absent at hook time | Fail open + stderr warning (rare: node ran at install) |
| Guard bundle deleted, hooks present | Shim finds no guard → fail open + warning; conductor re-offers at next session |
| Hooks deleted, `guard: installed` | `guard status` = absent → conductor mentions once, re-offers |
| Existing hook manager (husky/core.hooksPath) | Install into active hooks path; chain preserved hooks; if impossible, print exact manual lines — never silent |
| Corrupt v2 skills.json | Treated as absent; conductor re-asks (as today) |
| Token file corrupt/stale | Deleted; guard evaluates normally |
| Uninstall | Shims removed, preserved prior hooks restored, bundle deleted, `guard: declined` |

## 10. Testing

- **Unit:** guard evaluation parity with `integrationBlockers` + commit policy
  (same fixtures as commit-gate tests); token TTL/single-use/hash-match; shim
  chaining (prior hook allow/block paths); v1+v2 schema reads; precedence
  (lane → steps → default); fallback-array resolution + degrade recording;
  set-lane parsing (`|`, `,`, first-`=`).
- **Integration (the true test of "universal"):** a real git repo, **no agent
  involved** — staged open-gate state, plain-terminal `git push` blocked by
  the hook; commit blocked during implement without tests-green; allowed after
  gates clear; pass-token flow simulated as PreToolUse-then-push; husky-style
  `core.hooksPath` repo.
- **Live acceptance:** re-run the `~/sd-demo` fixture test in **Codex and
  Cowork** — the previously-naughty `git push origin main` must now be blocked
  by the guard hook. (This is the release's acceptance criterion.)
- Existing 105 tests stay green.

## 11. Out of scope (v0.2)

- `gh pr create` enforcement outside Claude Code (no git hook exists — README
  states it plainly).
- Auto-installing guard hooks without consent.
- Multi-repo guard sharing; changes to the fixed phase spine; any server/CI
  enforcement (a future idea, not this release).

## 12. Versioning and docs

- v0.2.0 in both manifests.
- README: new "Universal enforcement" section (what the guard is, the consent
  ask, honest `gh pr create` carve-out); the "Requires Claude Code" section is
  rewritten — Cowork/Codex move from "advisory only" to "enforced once the
  guard hooks are installed; the conductor offers them on first run", with
  Claude Code still noted as the richest host (PreToolUse + stop gate +
  bootstrap).
- CHANGELOG 0.2.0; SMOKE items: guard consent ask, plain-terminal block,
  token flow, uninstall/restore, Codex re-test, Cowork re-test.
- Update flow unchanged (bump both manifests → marketplace update → plugin
  update → restart).

## 13. Success criteria

1. With guard installed, the staged open-gate `git push` is blocked in a
   plain terminal, in Codex, and in Cowork — same message format as the
   Claude Code gate.
2. In Claude Code, no double-gating and no double-consumed bypass: PreToolUse
   allows → push proceeds (token honoured); PreToolUse blocks → git never
   runs.
3. Consent asked exactly once per repo; declined is remembered and silent;
   uninstall restores prior hooks.
4. A repo with husky/core.hooksPath keeps its existing hooks working, chained.
5. v1 skills.json files keep working; the picker writes v2 with per-lane and
   fallback mappings; `/senior-dev:skills` shows the resolved table.
6. All failure modes fail open with visible warnings; the guard never blocks
   when no session is active.
7. Full suite green (existing 105 + new guard/picker tests).
