# senior-dev v0.1.2 — Skill-Source Selection + Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the conductor a first-class skill-source choice (own / superpowers / combo / suggest) at the top of every run, wire the installed `find-skills` skill in as a proposal engine, persist a per-project `.senior-dev/skills.json` (private by default, one-question share opt-in), assist install of a chosen-but-missing chain plugin, and add Foundry Studio branding to the high-reach surfaces.

**Architecture:** Deterministic parts live in `scripts/lib/state.mjs` (skills.json read/write/validate + skills.json-aware git exclusion) and `scripts/state-cli.mjs` (new `skills-config` and `skill-source` subcommands + status/finish surfacing). The judgement parts — asking the four-way question, resolving each phase to a skill, invoking find-skills, offering assisted installs — live as prose in `skills/conductor/SKILL.md` plus a curated `references/skill-sources.md`. The fixed phase spine and all hard gates are untouched.

**Tech Stack:** Node ≥ 18 stdlib only (no npm deps), `node --test` runner. Spec: `docs/superpowers/specs/2026-07-04-skill-source-discovery-design.md`.

## Global Constraints

- **No npm dependencies.** `node:` stdlib only. Full suite runs via `node --test tests/*.test.mjs` (bare `tests/` fails on this machine's Node — always use the glob).
- **Fail open, always.** Any hook/script error → exit 0 (hooks) or a clean `fail()` exit 1 (CLI bad usage); never crash. Corrupt `.senior-dev/skills.json` → treated as absent (`null`), never thrown.
- **Timestamps** via `new Date().toISOString()`.
- **`.senior-dev/skills.json` is private by default.** The default git exclusion hides it; sharing is an explicit opt-in that flips a `shared` flag and narrows the exclusion. Never silently expose it.
- **Nothing installs without an explicit operator yes.** Assisted install is offered, never automatic. The chain is never silently rewired.
- **Fixed spine.** Phase sequence per lane and every hard gate (commit/integration/stop) are unchanged. Only phase→skill resolution becomes selectable.
- **Valid sources:** exactly `own` | `superpowers` | `combo` | `suggest`.
- **Foundry-voiced copy is written with `foundry-studio:foundry-brand` loaded first** (Task 6). No wording may imply Anthropic endorsement.
- **Version bump:** `0.1.1` → `0.1.2` in BOTH `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
- Repo root: `~/code/nzshrimper-senior-dev`. Plugin name stays `senior-dev` (command prefix unchanged).

---

### Task 1: skills.json helpers + skills.json-aware git exclusion (`scripts/lib/state.mjs`)

**Files:**
- Modify: `scripts/lib/state.mjs` (add helpers; rewrite `ensureExcluded`)
- Test: `tests/skills-config.test.mjs` (new)

**Interfaces:**
- Consumes: existing `statePath`-style patterns; imports already present (`readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync`, `join, dirname`).
- Produces (later tasks import these):
  - `VALID_SOURCES: string[]` — `['own','superpowers','combo','suggest']`
  - `skillsConfigPath(repoRoot: string): string` — `<root>/.senior-dev/skills.json`
  - `readSkillsConfig(repoRoot: string): object | null` — null on missing/corrupt/wrong-version/invalid-source
  - `writeSkillsConfig(repoRoot: string, cfg: object): void` — atomic (tmp + rename)
  - `ensureExcluded(repoRoot: string): void` — REWRITTEN: excludes `.senior-dev/state.json` and `.senior-dev/history/` always; excludes `.senior-dev/skills.json` unless the config's `shared === true`; removes any legacy wholesale `.senior-dev/` line. Idempotent.

- [ ] **Step 1: Write the failing tests**

Create `tests/skills-config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  VALID_SOURCES, skillsConfigPath, readSkillsConfig, writeSkillsConfig,
  ensureExcluded,
} from '../scripts/lib/state.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-skills-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function excludeContent(repo) {
  try { return readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'); }
  catch { return ''; }
}

test('VALID_SOURCES is the four sources', () => {
  assert.deepEqual(VALID_SOURCES, ['own', 'superpowers', 'combo', 'suggest']);
});

test('read/write skills config roundtrip', () => {
  const repo = makeRepo();
  const cfg = { version: 1, source: 'combo', shared: false, steps: { plan: 'my-org:planner' } };
  writeSkillsConfig(repo, cfg);
  assert.deepEqual(readSkillsConfig(repo), cfg);
});

test('readSkillsConfig returns null for missing, corrupt, wrong-version, bad-source', () => {
  const repo = makeRepo();
  assert.equal(readSkillsConfig(repo), null);
  mkdirSync(join(repo, '.senior-dev'), { recursive: true });
  writeFileSync(skillsConfigPath(repo), 'not json{{');
  assert.equal(readSkillsConfig(repo), null);
  writeFileSync(skillsConfigPath(repo), JSON.stringify({ version: 99, source: 'own' }));
  assert.equal(readSkillsConfig(repo), null);
  writeFileSync(skillsConfigPath(repo), JSON.stringify({ version: 1, source: 'nonsense' }));
  assert.equal(readSkillsConfig(repo), null);
});

test('ensureExcluded (default/no config) hides state, history, and skills.json', () => {
  const repo = makeRepo();
  ensureExcluded(repo);
  const c = excludeContent(repo);
  assert.ok(c.split('\n').includes('.senior-dev/state.json'));
  assert.ok(c.split('\n').includes('.senior-dev/history/'));
  assert.ok(c.split('\n').includes('.senior-dev/skills.json'));
});

test('ensureExcluded with shared config leaves skills.json trackable', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 1, source: 'own', shared: true });
  ensureExcluded(repo);
  const lines = excludeContent(repo).split('\n');
  assert.ok(lines.includes('.senior-dev/state.json'));
  assert.ok(lines.includes('.senior-dev/history/'));
  assert.ok(!lines.includes('.senior-dev/skills.json'));
});

test('ensureExcluded migrates a legacy wholesale line and is idempotent', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.senior-dev/\n');
  ensureExcluded(repo);
  ensureExcluded(repo);
  const lines = excludeContent(repo).split('\n');
  assert.ok(!lines.includes('.senior-dev/'));
  assert.equal(lines.filter((l) => l === '.senior-dev/state.json').length, 1);
});

test('ensureExcluded flips skills.json line when share flag changes', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 1, source: 'own', shared: false });
  ensureExcluded(repo);
  assert.ok(excludeContent(repo).split('\n').includes('.senior-dev/skills.json'));
  writeSkillsConfig(repo, { version: 1, source: 'own', shared: true });
  ensureExcluded(repo);
  assert.ok(!excludeContent(repo).split('\n').includes('.senior-dev/skills.json'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/nzshrimper-senior-dev && node --test tests/skills-config.test.mjs`
Expected: FAIL — `VALID_SOURCES`/`skillsConfigPath`/etc. not exported.

- [ ] **Step 3: Add the helpers and rewrite `ensureExcluded` in `scripts/lib/state.mjs`**

Add near the top-level exports (after `statePath`):

```js
export const VALID_SOURCES = ['own', 'superpowers', 'combo', 'suggest'];

export function skillsConfigPath(repoRoot) {
  return join(repoRoot, '.senior-dev', 'skills.json');
}

export function readSkillsConfig(repoRoot) {
  try {
    const c = JSON.parse(readFileSync(skillsConfigPath(repoRoot), 'utf8'));
    if (typeof c !== 'object' || c === null || c.version !== 1) return null;
    if (c.source !== undefined && !VALID_SOURCES.includes(c.source)) return null;
    return c;
  } catch {
    return null;
  }
}

export function writeSkillsConfig(repoRoot, cfg) {
  const p = skillsConfigPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, p);
}
```

Replace the existing `ensureExcluded` function body entirely with:

```js
export function ensureExcluded(repoRoot) {
  try {
    const p = join(repoRoot, '.git', 'info', 'exclude');
    let cur = '';
    try { cur = readFileSync(p, 'utf8'); } catch {}
    const shared = readSkillsConfig(repoRoot)?.shared === true;

    // Lines we manage. skills.json is excluded only when NOT shared.
    const want = ['.senior-dev/state.json', '.senior-dev/history/'];
    if (!shared) want.push('.senior-dev/skills.json');

    // Start from existing lines, drop the legacy wholesale line and any of
    // our managed lines, then re-add exactly the set we want. Idempotent, and
    // flips skills.json in/out as `shared` changes.
    const managed = new Set([
      '.senior-dev/', '.senior-dev/state.json',
      '.senior-dev/history/', '.senior-dev/skills.json',
    ]);
    const kept = cur.split('\n').filter((l) => l !== '' && !managed.has(l));
    const out = [...kept, ...want];

    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, out.join('\n') + '\n');
  } catch {}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/code/nzshrimper-senior-dev && node --test tests/skills-config.test.mjs`
Expected: all PASS. Then the full suite: `node --test tests/*.test.mjs` — all still green (the `ensureExcluded` rewrite must not break existing state tests that assert `.senior-dev/` handling; if an existing test asserts the exact old wholesale line, update it to assert `.senior-dev/state.json` presence instead, and note it in the report).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/state.mjs tests/skills-config.test.mjs
git commit -m "feat: skills.json read/write + skills.json-aware git exclusion (private by default, share-narrowing)"
```

---

### Task 2: `skills-config` + `skill-source` CLI subcommands + status/finish surfacing (`scripts/state-cli.mjs`)

**Files:**
- Modify: `scripts/state-cli.mjs` (new subcommands; status + finish rendering; help line)
- Test: `tests/skills-cli.test.mjs` (new)

**Interfaces:**
- Consumes from `scripts/lib/state.mjs`: `VALID_SOURCES`, `readSkillsConfig`, `writeSkillsConfig`, `ensureExcluded`, plus existing `readState`, `writeState`, `requireSession`, `parseFlags`, `requireValues`, `fail`.
- Produces CLI subcommands the conductor calls:
  - `skills-config show` — prints the project config as JSON, or `none`.
  - `skills-config set --source <s> [--steps 'phase=skill,phase=skill']` — creates/updates `.senior-dev/skills.json` (preserving `shared`), then `ensureExcluded`.
  - `skills-config share` / `skills-config unshare` — set `shared` true/false, then `ensureExcluded`; prints the git-add hint on share.
  - `skill-source --source <s> [--map '<json>'] [--suggestions '<json>']` — records the run's choice into `state.skillSource`; needs an active session.
  - status/finish now surface `state.skillSource`.

- [ ] **Step 1: Write the failing tests**

Create `tests/skills-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, readSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-scli-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8' });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('skills-config set writes source + steps and excludes skills.json by default', () => {
  const repo = makeRepo();
  const r = cli(repo, ['skills-config', 'set', '--source', 'combo', '--steps', 'plan=my-org:planner,review=my-org:reviewer']);
  assert.equal(r.status, 0);
  const cfg = readSkillsConfig(repo);
  assert.equal(cfg.source, 'combo');
  assert.deepEqual(cfg.steps, { plan: 'my-org:planner', review: 'my-org:reviewer' });
  assert.equal(cfg.shared, false);
  assert.ok(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').includes('.senior-dev/skills.json'));
});

test('skills-config set rejects an invalid source', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['skills-config', 'set', '--source', 'bogus']).status, 1);
});

test('skills-config show prints none then the config', () => {
  const repo = makeRepo();
  assert.ok(cli(repo, ['skills-config', 'show']).out.includes('none'));
  cli(repo, ['skills-config', 'set', '--source', 'own']);
  assert.ok(cli(repo, ['skills-config', 'show']).out.includes('own'));
});

test('skills-config share flips the flag and untracks the exclusion', () => {
  const repo = makeRepo();
  cli(repo, ['skills-config', 'set', '--source', 'own']);
  const r = cli(repo, ['skills-config', 'share']);
  assert.equal(r.status, 0);
  assert.equal(readSkillsConfig(repo).shared, true);
  assert.ok(!readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('.senior-dev/skills.json'));
  assert.ok(r.out.includes('git add'));
  cli(repo, ['skills-config', 'unshare']);
  assert.equal(readSkillsConfig(repo).shared, false);
});

test('skill-source records the run choice into state, needs a session', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['skill-source', '--source', 'superpowers']).status, 1); // no session
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  const r = cli(repo, ['skill-source', '--source', 'combo', '--map', '{"plan":"my-org:planner"}']);
  assert.equal(r.status, 0);
  const s = readState(repo);
  assert.equal(s.skillSource.source, 'combo');
  assert.deepEqual(s.skillSource.map, { plan: 'my-org:planner' });
});

test('skill-source rejects invalid source and invalid JSON map', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  assert.equal(cli(repo, ['skill-source', '--source', 'nope']).status, 1);
  assert.equal(cli(repo, ['skill-source', '--source', 'own', '--map', '{bad']).status, 1);
});

test('status surfaces the chosen skill source', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 't', '--type', 'quick-fix']);
  cli(repo, ['skill-source', '--source', 'combo']);
  assert.ok(cli(repo, ['status']).out.includes('skill source: combo'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/nzshrimper-senior-dev && node --test tests/skills-cli.test.mjs`
Expected: FAIL — unknown subcommands.

- [ ] **Step 3: Implement the subcommands in `scripts/state-cli.mjs`**

Add these imports to the existing `import { ... } from './lib/state.mjs';` line: `VALID_SOURCES, readSkillsConfig, writeSkillsConfig`. (`ensureExcluded` is already imported.)

Add a small helper near the top (after `requireValues`):

```js
function parseSteps(raw) {
  // "plan=my-org:planner,review=my-org:reviewer" -> {plan:'my-org:planner',...}
  const steps = {};
  for (const pair of raw.split(',')) {
    const t = pair.trim();
    if (!t) continue;
    const eq = t.indexOf('=');           // split on FIRST '=', skill ids contain ':'
    if (eq < 1) fail(`bad --steps entry '${t}', expected phase=skill`);
    steps[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return steps;
}
```

Add these `case` blocks to the dispatch `switch` (alongside `waiting`, before `default`):

```js
  case 'skills-config': {
    const sub = positional[0];
    if (sub === 'show') {
      const cfg = readSkillsConfig(repoRoot);
      console.log(cfg ? JSON.stringify(cfg, null, 2) : 'none');
      break;
    }
    if (sub === 'set') {
      requireValues('skills-config set', flags, ['source', 'steps']);
      if (!VALID_SOURCES.includes(flags.source)) {
        fail(`skills-config set needs --source ${VALID_SOURCES.join('|')}`);
      }
      const existing = readSkillsConfig(repoRoot) || {};
      const cfg = {
        version: 1,
        source: flags.source,
        shared: existing.shared === true,
      };
      if (typeof flags.steps === 'string') cfg.steps = parseSteps(flags.steps);
      else if (existing.steps) cfg.steps = existing.steps;
      writeSkillsConfig(repoRoot, cfg);
      ensureExcluded(repoRoot);
      console.log(`skills config: source=${cfg.source}${cfg.steps ? ' steps=' + JSON.stringify(cfg.steps) : ''}`);
      break;
    }
    if (sub === 'share' || sub === 'unshare') {
      const cfg = readSkillsConfig(repoRoot);
      if (!cfg) fail('no skills config yet - run: skills-config set --source <s>');
      cfg.shared = sub === 'share';
      writeSkillsConfig(repoRoot, cfg);
      ensureExcluded(repoRoot);
      if (cfg.shared) console.log('skills config is now shareable. Commit it:\n  git add .senior-dev/skills.json');
      else console.log('skills config is now private (git-excluded).');
      break;
    }
    fail('skills-config needs a subcommand: show | set | share | unshare');
    break;
  }
  case 'skill-source': {
    const state = requireSession(repoRoot);
    requireValues('skill-source', flags, ['source', 'map', 'suggestions']);
    if (!VALID_SOURCES.includes(flags.source)) {
      fail(`skill-source needs --source ${VALID_SOURCES.join('|')}`);
    }
    let map = {}, suggestions = [];
    if (typeof flags.map === 'string') {
      try { map = JSON.parse(flags.map); } catch { fail('skill-source --map must be valid JSON'); }
    }
    if (typeof flags.suggestions === 'string') {
      try { suggestions = JSON.parse(flags.suggestions); } catch { fail('skill-source --suggestions must be valid JSON'); }
    }
    state.skillSource = { source: flags.source, map, suggestions, at: new Date().toISOString() };
    writeState(repoRoot, state);
    console.log(`skill source recorded: ${flags.source}`);
    break;
  }
```

In the `status` case, after the `WAITING on:` line, add:

```js
    if (state.skillSource) {
      console.log(`skill source: ${state.skillSource.source}`);
      if (state.skillSource.map && Object.keys(state.skillSource.map).length) {
        console.log(`  resolved: ${JSON.stringify(state.skillSource.map)}`);
      }
      if ((state.skillSource.suggestions || []).length) {
        console.log(`  suggestions: ${state.skillSource.suggestions.length}`);
      }
    }
```

Update the `default` help line to include the new subcommands:

```js
    fail(`unknown subcommand '${cmd || ''}'. Use: init|phase|tests-green|review|docs|degrade|bypass|waiting|scratch|skills-config|skill-source|status|sweep|finish`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/code/nzshrimper-senior-dev && node --test tests/skills-cli.test.mjs` — all PASS. Then `node --test tests/*.test.mjs` — full suite green.

- [ ] **Step 5: Commit**

```bash
git add scripts/state-cli.mjs tests/skills-cli.test.mjs
git commit -m "feat: skills-config + skill-source CLI subcommands, status surfacing"
```

---

### Task 3: Curated chain-plugin source map (`skills/conductor/references/skill-sources.md`)

**Files:**
- Create: `skills/conductor/references/skill-sources.md`

**Interfaces:**
- Consumes: nothing (reference content).
- Produces: a table the conductor reads when a chain-plugin skill is missing.

- [ ] **Step 1: Write the reference file**

Create `skills/conductor/references/skill-sources.md`:

```markdown
# Chain-plugin sources

Read this on a **chain-plugin gap** — a named `superpowers:*` / `codex:*`
process skill the run needs is not installed. `find-skills` / `npx skills`
target the skills.sh ecosystem and cannot reliably locate Claude Code
*plugins*, so these installs are curated here. Give the operator the exact
commands; offer to run them (§6 assisted install); never install without a yes.

| Skill family | Install commands | Notes |
|---|---|---|
| `superpowers:*` (brainstorming, writing-plans, using-git-worktrees, test-driven-development, subagent-driven-development, executing-plans, systematic-debugging, requesting-code-review, verification-before-completion, finishing-a-development-branch) | `claude plugin marketplace add obra/superpowers` then `claude plugin install superpowers@superpowers-marketplace` | The canonical process chain. One install covers every `superpowers:*` step. |
| `codex:*` review lanes (`/codex:review`, `/codex:adversarial-review`) | `claude plugin marketplace add openai/codex` then `claude plugin install codex@codex` | Read-only review lanes only. Never the write-capable `codex-rescue`. |
| Built-ins (`/code-review`, `/review`, `verify`) | none — ship with Claude Code | If absent on an older build, degrade to `superpowers:verification-before-completion` for verify and `superpowers:requesting-code-review` for review. |

**Restart caveat:** a newly installed plugin's skills and hooks load on the
**next Claude Code restart** — they are not usable in the current session even
after a successful install. Offer the operator: (a) proceed this run on the
built-in fallback (degrade recorded), or (b) install now, restart, and resume
(the session is resumable from state).

Verify the marketplace slugs against the operator's environment if an install
fails; these are the known-good defaults as of 2026-07.
```

- [ ] **Step 2: Commit**

```bash
git add skills/conductor/references/skill-sources.md
git commit -m "docs: curated chain-plugin source map for gap handling"
```

---

### Task 4: Conductor skill — opening step, four sources, confirm-default, gap split, assisted install (`skills/conductor/SKILL.md`)

**Files:**
- Modify: `skills/conductor/SKILL.md` (§1 Engage; rewrite "Missing skills"; new "Skill source" section)

**Interfaces:**
- Consumes: the state CLI subcommands (Tasks 1–2 exact names), `references/skill-sources.md` (Task 3), the installed `find-skills` skill (by name).
- Produces: the run-time behaviour that satisfies spec §3–§6.

- [ ] **Step 1: Add the opening skill-source step to §1 Engage**

In `skills/conductor/SKILL.md`, in "## 1. Engage", insert a new step **before** the current step 1 (the `state-cli status` resume check stays as-is, renumbered), so the very first action on a fresh (non-resumed) run is the skill-source choice. Add:

````markdown
0. **Skill source (first, before classifying).** Decide which skills fill the
   process phases this run. Run `node <plugin>/scripts/state-cli.mjs
   skills-config show`.
   - **Config present:** state its `source` as the project default and ask a
     one-beat confirm — "Project default: **<source>** (with this repo's
     `<mapped phases>`). Use it, or choose another?" A bare "yes"/"use it"
     proceeds; naming another source switches.
   - **No config:** ask the four-way question, `superpowers` marked default:
     1. **own** — this project's own skills fill each phase.
     2. **superpowers** (default) — the canonical chain.
     3. **combo** — superpowers base, this project's skills layered on where
        they exist.
     4. **suggest** — search for skills with `find-skills` and pick.
   - Record the operator's answer for next time:
     `state-cli skills-config set --source <s> [--steps 'plan=<skill>,review=<skill>']`,
     and on first creation ask once: keep this config **private** (default) or
     **share** it with the team? On "share" run `state-cli skills-config share`
     and tell them to `git add .senior-dev/skills.json`.
   - Record the run's choice once the session exists (after `init`):
     `state-cli skill-source --source <s> --map '<phase→skill json>'`.
````

- [ ] **Step 2: Add a "Skill source resolution" subsection (the four sources + assisted install)**

After §1 Engage, add a new section:

````markdown
## Skill source resolution

The phase spine never changes; the source decides which skill fills each phase.

- **own** — each phase resolves to a project skill: `skills.json` `steps`
  mapping first, then a project skill you can see (project `CLAUDE.md` /
  installed project skills). A phase with neither is a gap (below).
- **superpowers** — each phase resolves to its canonical `superpowers:*` /
  built-in skill (the chains in §2). This is the default.
- **combo** — superpowers base; a project `steps` mapping or visible project
  skill overrides that phase; phases the project doesn't cover stay on
  superpowers.
- **suggest** — invoke `find-skills` to search skills.sh, present ranked
  candidates, let the operator pick; fold chosen skills into the chain. Install
  only on an explicit yes.

**Gaps** — a phase that resolves to no available skill, whether caught here or
mid-run:

- **Chain-plugin gap** (a `superpowers:*` / `codex:*` skill isn't installed):
  read `references/skill-sources.md`, give the operator the exact install
  commands, and — especially when they *chose* superpowers — **offer to run
  them** (their yes required). State the restart caveat plainly: a fresh
  install's skills/hooks load on the next Claude Code restart, not this session.
  Then offer the choice: (a) proceed now on the built-in fallback (record
  `state-cli degrade …`), or (b) install, restart, resume (state is resumable).
  Never block; never install without the yes.
- **Domain/capability gap** (the task wants a capability no installed skill
  covers): invoke `find-skills`, present ranked candidates, install only on a
  yes.

Either way the gap is recorded via `state-cli degrade`, the nearest built-in
carries the phase if the operator declines to install, and the step is never
silently skipped.
````

- [ ] **Step 3: Rewrite the old "Missing skills" paragraph to point at the new machinery**

Replace the existing "**Missing skills:**" paragraph (in §2) with:

```markdown
**Missing skills:** handled by "Skill source resolution" above — chain-plugin
gaps use `references/skill-sources.md` (with assisted install), domain gaps use
`find-skills`. Always record the gap (`state-cli degrade …`) and fall to the
nearest built-in; never silently skip a step.
```

- [ ] **Step 4: Verify the skill description length is still ≤ 1024 chars**

Run: `cd ~/code/nzshrimper-senior-dev && python3 -c "import yaml; d=yaml.safe_load(open('skills/conductor/SKILL.md').read().split('---')[1]); print(len(d['description']))"`
Expected: a number ≤ 1024 (the description itself is unchanged by this task, so this is a guard). If the frontmatter isn't valid YAML or the number exceeds 1024, stop and report.

- [ ] **Step 5: Commit**

```bash
git add skills/conductor/SKILL.md
git commit -m "feat: conductor opening skill-source step, four sources, gap split, assisted install"
```

---

### Task 5: Command hint + docs + version bump + SMOKE (`commands/start.md`, `README.md`, `CHANGELOG.md`, `SESSION-HANDOVER.md`, `tests/SMOKE.md`, manifests)

**Files:**
- Modify: `commands/start.md`, `README.md`, `SESSION-HANDOVER.md`, `tests/SMOKE.md`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- Create or modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything built in Tasks 1–4 (documents it).
- Produces: user-facing docs + the 0.1.2 version bump.

- [ ] **Step 1: Add a line to `commands/start.md` body**

After the existing "Invoke the `senior-dev:conductor` skill now and follow it exactly." line, add:

```markdown

The conductor's first step asks which skill source drives this run (your own
skills, superpowers, a combination, or a `find-skills` search) — or confirms
your project's saved default from `.senior-dev/skills.json`.
```

- [ ] **Step 2: Bump both manifest versions to 0.1.2**

Run:
```bash
cd ~/code/nzshrimper-senior-dev
node -e "for (const f of ['.claude-plugin/plugin.json','.claude-plugin/marketplace.json']){const fs=require('fs');let t=fs.readFileSync(f,'utf8').replace(/\"version\": \"0\.1\.1\"/g,'\"version\": \"0.1.2\"');fs.writeFileSync(f,t);}"
grep -n '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json
```
Expected: every `"version"` line reads `0.1.2`.

- [ ] **Step 3: Add a README "Skill source" subsection**

In `README.md`, under the "What it adds" list (or a new "## Skill source" section near the commands), add:

```markdown
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
```

- [ ] **Step 4: Create or update `CHANGELOG.md`**

If `CHANGELOG.md` exists, prepend a `## 0.1.2 — 2026-07-04` entry; if not, create it with a header and this entry:

```markdown
# Changelog

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
```

- [ ] **Step 5: Refresh `SESSION-HANDOVER.md`**

Update the state line to note v0.1.2 shipped skill-source selection + discovery, and that `.senior-dev/skills.json` is private by default.

- [ ] **Step 6: Add SMOKE items**

In `tests/SMOKE.md`, add (renumber as needed, keep the production-mileage note last):

```markdown
- [ ] Skill-source (fresh repo): first `/senior-dev:start` asks the four-way
      source question, superpowers marked default. Answer `own`/`combo` →
      `.senior-dev/skills.json` written; `state-cli skills-config show` reflects
      it; a second run confirms the saved default in one beat instead of
      re-asking.
- [ ] Share opt-in: `state-cli skills-config share` → skills.json no longer in
      `.git/info/exclude`; `unshare` re-hides it.
- [ ] Chosen-but-missing chain plugin (simulate: pick superpowers where a step
      skill is absent) → conductor prints the exact install command, offers to
      run it, states the restart caveat, and offers proceed-on-fallback vs
      install-restart-resume.
```

- [ ] **Step 7: Run the full suite and commit**

Run: `cd ~/code/nzshrimper-senior-dev && node --test tests/*.test.mjs` — all green.
```bash
git add commands/start.md README.md CHANGELOG.md SESSION-HANDOVER.md tests/SMOKE.md .claude-plugin
git commit -m "docs: v0.1.2 - skill-source docs, changelog, smoke items, version bump"
```

---

### Task 6: Foundry Studio branding (both plugins), voiced via foundry-brand

**Files:**
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md`, `commands/*.md` (this repo)
- Modify (mirror): the same fields in `~/code/nzshrimper-promptbuilder`

**Interfaces:**
- Consumes: the surfaces table in spec §8a.
- Produces: consistent Foundry credit on both plugins' high-reach surfaces.

- [ ] **Step 1: Load the Foundry brand voice**

Invoke the `foundry-studio:foundry-brand` skill and follow it for ALL copy in this task. Do not freelance the Foundry identity. No wording may imply Anthropic endorsement.

- [ ] **Step 2: Author field → Foundry Studio (both manifests)**

In `.claude-plugin/plugin.json`, change `author` to name Foundry Studio with Chris as maintainer contact, e.g.:
```json
"author": { "name": "Foundry Studio (Chris Bennett)", "email": "nzshrimper@gmail.com" }
```
(Use the exact name form foundry-brand prescribes.)

- [ ] **Step 3: Foundry-led marketplace + plugin description**

Update `.claude-plugin/marketplace.json` `metadata.description` and the plugin entry `description` to lead with Foundry Studio, in foundry-brand voice, factual, no endorsement claims.

- [ ] **Step 4: README credit block**

Add a short "Built by Foundry Studio" section to `README.md` (bottom) with a one-line studio descriptor and link, foundry-brand voiced.

- [ ] **Step 5: Light Foundry tag on command descriptions**

Append a short, tasteful Foundry tag to each `commands/*.md` `description:` (e.g. "… · a Foundry Studio tool") — kept short so the `/` menu stays readable.

- [ ] **Step 6: Mirror to promptbuilder**

Apply Steps 2–5 to `~/code/nzshrimper-promptbuilder` (its `plugin.json`, `marketplace.json`, `README.md`, and — it has one skill, no commands — its skill/marketplace copy), same foundry-brand voice. Commit in that repo separately: `docs: Foundry Studio branding on high-reach surfaces`.

- [ ] **Step 7: Commit (this repo)**

Run `node --test tests/*.test.mjs` (unaffected, but confirm green), then:
```bash
git add .claude-plugin README.md commands
git commit -m "docs: Foundry Studio branding on high-reach surfaces"
```

---

### Task 7: Validation, final review, merge, reinstall

**Files:**
- Create: none (may fix findings across earlier files)

**Interfaces:**
- Consumes: the whole v0.1.2 branch.
- Produces: a validated, merged, reinstalled v0.1.2.

- [ ] **Step 1: Full suite baseline**

Run: `cd ~/code/nzshrimper-senior-dev && node --test tests/*.test.mjs` — all PASS.

- [ ] **Step 2: Plugin validator**

Dispatch `plugin-dev:plugin-validator` on `/Users/chrisbennett/code/nzshrimper-senior-dev`: manifests, hooks, commands, skill frontmatter (description ≤1024), the new reference file reachable, nothing dev-only shipping. Fix every blocker.

- [ ] **Step 3: Skill reviewer**

Dispatch `plugin-dev:skill-reviewer` on `skills/conductor/SKILL.md`: check the new opening step and source-resolution section are unambiguous and every `state-cli` call shown matches the real CLI (Tasks 1–2). Fix findings.

- [ ] **Step 4: Whole-branch review**

Generate the branch review package (`scripts/review-package <merge-base> HEAD`) and dispatch the most-capable-model final reviewer per superpowers:requesting-code-review: spec coverage against `docs/superpowers/specs/2026-07-04-…`, cross-component coherence (CLI ↔ SKILL.md ↔ docs), and the exclusion-mode logic (private-by-default holds, share narrows correctly, re-init doesn't re-hide a shared file). Dispatch ONE fix subagent with the full findings list.

- [ ] **Step 5: Merge, tag, reinstall, sweep**

```bash
cd ~/code/nzshrimper-senior-dev
git checkout main && git merge --ff-only v0.1.2 && git branch -d v0.1.2 && git tag v0.1.2
claude plugin marketplace update nzshrimper-senior-dev
claude plugin update senior-dev@nzshrimper-senior-dev
git worktree list && git branch --list && git status --porcelain   # zero-leftovers evidence
```
Operator restart loads v0.1.2. Report with the sweep evidence pasted verbatim.

---

## Self-Review (completed at write time)

**Spec coverage:** §2 opening-question trigger → Task 4 Step 1; §3 four sources → Task 4 Step 2; §4 opening step + confirm-default → Task 4 Steps 1–2; §5 skills.json private-by-default + share + steps → Tasks 1 (helpers/exclusion), 2 (`skills-config`); §6 gap split + assisted install + restart caveat → Tasks 3 (map) + 4 (prose); §7 state recording + status/finish → Task 2 (`skill-source`, status); §8 components → Tasks 1–5; §8a Foundry branding → Task 6; §9 failure modes → corrupt-config null (Task 1 test), missing-skill degrade (Task 4), find-skills-absent (Task 4 prose), repeat-run confirm (Task 4); §10 success criteria 1–7 → Tasks 4 (1–4), 1–2 (5), 4 (6 spine unchanged), 1–2 (7 tests).

**Placeholder scan:** clean — every code step carries full code; the one create-or-update branch (CHANGELOG, Task 5 Step 4) gives both the prepend and the from-scratch content. Foundry copy (Task 6) is deliberately not pre-written because it must come from the foundry-brand skill at build time — the task says exactly which surfaces and constraints, which is the correct deferral, not a placeholder.

**Type consistency:** subcommand names match between Task 2 code, Task 4 prose, and Task 5 docs (`skills-config` show/set/share/unshare, `skill-source`). Helper names match between Task 1 (`skillsConfigPath/readSkillsConfig/writeSkillsConfig/VALID_SOURCES/ensureExcluded`) and Task 2's imports. State field `skillSource{source,map,suggestions,at}` consistent across Task 2 code, status rendering, and Task 4 prose. `.senior-dev/skills.json` schema (`version,source,shared,steps`) consistent across Tasks 1, 2, 4.
