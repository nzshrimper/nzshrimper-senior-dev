# senior-dev v0.1.2 — Skill-Source Selection + Discovery — Design Spec

**Date:** 2026-07-04
**Status:** Approved design, pre-implementation
**Owner:** Chris Bennett
**Repo:** `~/code/nzshrimper-senior-dev` (marketplace `nzshrimper-senior-dev`)

## 1. Purpose

Today the conductor hard-names superpowers for every process phase and only
reacts when a named skill turns out missing (the degrade path). This adds a
first-class **skill-source choice** at the top of every run and wires the
installed `find-skills` skill in as a proposal engine, so the operator picks
who drives the chain — the project's own skills, superpowers, a combination,
or a discovered set — before work starts. Discovery proposes; the operator
decides; state records.

The process **spine never changes**: the phase sequence per lane
(brainstorm → plan → TDD → review → verify → docs → finish, etc.) is fixed.
Only *which skill fills each phase* is now selectable.

## 2. Operator decisions (locked)

| Decision | Choice |
|---|---|
| Discovery trigger | The run's FIRST Engage step asks the skill-source question (before classification), plus the existing reactive degrade fallback mid-run |
| The four sources | 1 own skills · 2 superpowers (default) · 3 combo · 4 suggest (find-skills) |
| Gap handling | Split: curated pointer for chain-plugin gaps, `find-skills` for domain gaps — mixed per the project's own skills taking precedence |
| Project preference | `.senior-dev/skills.json` maps steps→skills and records the source; when present the conductor presents it as the project default and asks the operator to **confirm** (one beat), not silently proceed and not fully re-ask |
| Preference sharing | The file is committable or git-ignorable at the project's discretion (committing it is how a team shares "use our skills") |
| Nothing auto-installs | Every install needs an explicit operator yes; the chain is never silently rewired |
| Out of scope (v1.2) | No deterministic session-start script that mechanically lists installed skills — prose resolution + the override file cover the need |

## 3. The four sources

The conductor resolves each fixed phase to a concrete skill according to the
chosen source:

1. **Own skills.** Each phase resolves to a project-provided skill, taken from
   `.senior-dev/skills.json` step→skill mappings first, then from project
   skills the conductor can see (project `CLAUDE.md` / installed project
   skills). A phase with no project skill and no mapping is a gap → §6.
2. **Superpowers (default).** Today's behaviour: each phase resolves to its
   canonical `superpowers:*` / built-in skill. This is the zero-config default
   for a repo with no `.senior-dev/skills.json`.
3. **Combo.** Superpowers is the base; project skills override per-phase where
   they exist (a project `plan` skill replaces `superpowers:writing-plans`;
   phases the project doesn't cover stay on superpowers). This is the "adds the
   custom skills" case.
4. **Suggest.** The conductor invokes `find-skills`, which searches skills.sh
   (`npx skills find`), and presents ranked candidates for the operator to
   choose from — to fill specific gaps or assemble a fuller custom set. Chosen
   skills are installed only on an explicit yes, then folded into the chain.

## 4. The opening step (conductor Engage)

New Engage sub-step, running BEFORE task classification:

1. **Read `.senior-dev/skills.json` if it exists.** If it declares a `source`
   (and optional per-step mappings), the conductor states it —
   "Project default: **combo** (superpowers + this repo's `plan`/`review`
   skills). Use it, or choose another?" — and waits for a one-beat confirm or
   a switch. A bare confirm ("yes"/"use it") proceeds; naming another source
   switches.
2. **No file → ask the four-way question** (own / superpowers / combo /
   suggest), superpowers marked as the default. The operator's answer is
   recorded to `.senior-dev/skills.json` so the next run in this repo confirms
   rather than re-asks.
3. **Then classify** the task and build the chain, resolving each phase against
   the chosen source (§3). Missing resolutions route to §6.

The choice, the resolved phase→skill map, and any find-skills suggestions are
written to session state at this point (§7).

## 5. `.senior-dev/skills.json`

Lives beside the state file at the repo root. Committable or git-ignorable at
the project's discretion — the conductor never adds it to `.git/info/exclude`
(unlike `state.json`, which it does exclude), so committing is the default and
sharing is opt-out.

```json
{
  "version": 1,
  "source": "combo",
  "steps": {
    "plan": "my-org:planner",
    "review": "my-org:reviewer"
  }
}
```

- `source`: one of `own` | `superpowers` | `combo` | `suggest`. Presented as
  the project default to confirm.
- `steps`: optional per-phase overrides (phase name → skill id). Used by `own`
  and `combo`. Absent phases fall back per the source's rule.
- Corrupt/unparsable file → conductor ignores it, falls to the four-way
  question, and offers to rewrite it from the operator's answer.

## 6. Gap handling (reactive, unchanged spine + curated pointer)

A phase that resolves to no available skill — under any source, whether caught
at Engage-time resolution or mid-run — is a gap, handled by the split:

- **Chain-plugin gap** (a named `superpowers:*` / `codex:*` skill is not
  installed): the conductor reads a new curated reference,
  `skills/conductor/references/skill-sources.md`, mapping each canonical chain
  skill to its exact install command (e.g.
  `claude plugin marketplace add obra/superpowers`) and the built-ins that need
  nothing. It gives the operator the exact command — `find-skills`/`npx skills`
  cannot reliably locate plugin-based skills, so a curated pointer is correct
  here.
- **Domain/capability gap** (the task needs a capability no installed skill
  covers): the conductor invokes `find-skills` and presents ranked candidates.

Either way the gap is recorded (`state-cli degrade …`, as today), the nearest
built-in equivalent carries the phase if the operator declines to install, and
the step is never silently skipped.

## 7. State recording

The skill-source decision extends session state (via a `state-cli` addition,
exact subcommand shape settled in the plan):

- `source` chosen for the run,
- the resolved phase→skill map,
- `suggestions`: find-skills candidates surfaced and which the operator took,
- gaps (existing `degradations`) unchanged.

All surface in `/senior-dev:status` and the finish summary, consistent with how
bypass / degrade / waiting already report.

## 8. Components touched

| Component | Change |
|---|---|
| `skills/conductor/SKILL.md` | New "Skill source" opening sub-step in §1 Engage; the four sources; the confirm-the-default behaviour; §6 gap split; wire `find-skills` by name; update the "Missing skills" paragraph to point at `references/skill-sources.md` |
| `skills/conductor/references/skill-sources.md` | New — curated map: canonical chain skill → install command / built-in note |
| `scripts/state-cli.mjs` | New subcommand(s) to read/write `.senior-dev/skills.json`, record the source + resolved map + suggestions; status/finish surfacing |
| `scripts/lib/state.mjs` | Skill-source read/validate helpers; `.senior-dev/skills.json` path + parse (corrupt→null, like state.json) |
| `commands/start.md` | Mention the opening skill-source choice |
| `tests/*` | CLI read/write of skills.json (valid/corrupt/absent), source resolution, status surfacing |
| `README.md` / `CHANGELOG.md` / `SESSION-HANDOVER.md` | Document the feature; bump to 0.1.2 |
| `tests/SMOKE.md` | Add a skill-source-selection smoke item |

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| `.senior-dev/skills.json` corrupt | Ignored; four-way question; offer to rewrite |
| Chosen source's skill missing | §6 gap split; degrade recorded; built-in fallback; never silent |
| `find-skills` not installed | Report it, fall to the curated pointer + built-in; recorded as a degradation (discovery itself degrades loudly) |
| Operator declines every install | Chain runs on built-in fallbacks; gaps visible in status/finish |
| Repeat run, file present | Confirm-the-default one-beat; no full re-ask |

## 10. Success criteria

1. A fresh repo's first senior-dev run opens by asking the four-way
   skill-source question; superpowers is the marked default.
2. A repo with `.senior-dev/skills.json` presents the declared source as the
   project default to confirm in one beat, and honours per-step overrides.
3. Choosing "suggest" runs find-skills and returns candidates; nothing installs
   without an explicit yes.
4. A missing chain-plugin skill yields the exact install command from the
   curated map; a missing domain skill yields find-skills candidates.
5. The chosen source, resolved map, and suggestions appear in
   `/senior-dev:status` and the finish summary.
6. The process spine (phase sequence and all hard gates) is unchanged; only
   phase→skill resolution is now selectable.
7. All existing tests stay green; new tests cover skills.json read/write and
   source resolution.
