# Changelog

## 0.2.0 — 2026-07-08

- Universal guard: git-hook enforcement (`pre-commit`, `pre-push`,
  `pre-merge-commit`) from a self-contained bundle — the gates now hold in
  Cowork, Codex, and plain terminals. Consent asked once per repo; existing
  hooks chained; uninstall restores them; fails open with warnings.
- Pass-token handshake so the Claude Code gate and the git hook never
  double-block or double-spend a bypass.
- skills.json schema v2: per-lane skill maps and ordered fallback lists
  (v1 files keep working). Interactive per-phase picker; new
  `/senior-dev:skills` and `/senior-dev:guard` commands;
  `skills-config set-lane` and `resolve` CLI subcommands.

## 0.1.2 — 2026-07-04

- Skill-source selection: every run opens with a four-way choice (own /
  superpowers / combo / suggest), saved per-repo in `.senior-dev/skills.json`
  (private by default, one-question share opt-in).
- `find-skills` wired in as a proposal engine for domain-skill gaps; a curated
  `skill-sources.md` gives exact install commands for missing chain plugins,
  with assisted install and the restart caveat stated.
- New `state-cli` subcommands: `skills-config` (show/set/share/unshare) and
  `skill-source`; status and finish now surface the chosen source.
- The process spine and all hard gates are unchanged.
