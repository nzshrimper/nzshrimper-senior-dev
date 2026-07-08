# senior-dev v0.2 — Universal Guard + Skill Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a git-hook enforcement layer (guard bundle + chained shims, consent once per repo, pass-token handshake with the Claude Code gate) so the hard gates hold in Cowork/Codex/plain terminals, and upgrade own-skill control (schema v2: per-lane + ordered fallbacks; interactive picker; `/senior-dev:skills`).

**Architecture:** Deterministic parts live in `scripts/lib/state.mjs` (schema v2 + configured-resolution helper), `scripts/guard.mjs` (standalone evaluator, runs from a copied bundle at `.senior-dev/guard/`), `scripts/state-cli.mjs` (guard install/status/uninstall + set-lane/resolve), and a token write in `scripts/commit-gate.mjs`. Judgement parts (consent ask, picker, fallback-by-installed) are conductor prose. Spec: `docs/superpowers/specs/2026-07-08-universal-guard-skill-picker-design.md`.

**Tech Stack:** Node ≥18 stdlib only, POSIX sh shims, `node --test`.

## Global Constraints

- **No npm dependencies.** `node:` stdlib only; shims are POSIX sh. Full suite via `node --test tests/*.test.mjs` (never bare `tests/`).
- **Fail open, always:** guard/hook/token errors → exit 0 + stderr warning. The guard is inert (`exit 0`) when no active session exists.
- **Never clobber existing hooks:** prior hook → preserved as `<name>.pre-senior-dev` and chained first; `core.hooksPath` respected; impossible installs print exact manual lines and fail the CLI call (exit 1) without recording `guard: "installed"`.
- **Bypass consumed exactly once**, whichever layer evaluates. Pass token: written ONLY by the Claude Code gate on an ALLOWED integration action when `guard === "installed"`; single-use; 60s TTL; guard matches on `{type:'integration', unexpired}` (pre-push args carry no original command string, so no hash match guard-side — `commandHash` is audit-only).
- **Schema compatibility:** `readSkillsConfig` accepts version 1 AND 2; v1 files work unchanged.
- Resolution precedence: `lanes[lane][phase]` → `steps[phase]` → source default. Fallback arrays = ordered; first *installed* wins (installed-ness is conductor judgement, not CLI).
- Versions: bump BOTH manifests `0.1.2` → `0.2.0` (Task 6 only).
- Repo `~/code/nzshrimper-senior-dev`, branch `v0.2`. Timestamps via `new Date().toISOString()`.
- Guard bundle files: `.senior-dev/guard/guard.mjs` (copied from `scripts/guard.mjs` verbatim), `.senior-dev/guard/state-lib.mjs` (copied from `scripts/lib/state.mjs` verbatim), `.senior-dev/guard/version` (plugin version string). `scripts/guard.mjs` imports `./state-lib.mjs` — it ONLY runs from a bundle; tests install a bundle first.

---

### Task 1: Schema v2 + configured-resolution helper (`scripts/lib/state.mjs`)

**Files:**
- Modify: `scripts/lib/state.mjs` (extend `readSkillsConfig`; add `normalizeLaneValue`, `resolveConfiguredSkill`)
- Test: `tests/skills-v2.test.mjs` (new)

**Interfaces:**
- Consumes: existing `CHAINS`, `skillsConfigPath`, `writeSkillsConfig`, `VALID_SOURCES`.
- Produces (later tasks import):
  - `readSkillsConfig(repoRoot)` — now accepts `version: 1 | 2`; v2 adds optional `lanes` (object: laneType → {phase → string|string[]}) and optional `guard` (`'installed'|'declined'`). Invalid `lanes`/`guard` shapes → null (corrupt = absent).
  - `normalizeLaneValue(v): string[]` — string→[string], array→array.
  - `resolveConfiguredSkill(cfg, laneType, phase): { value: string[] , via: 'lane'|'steps'|'default' }` — applies precedence; `via:'default'` returns `value: []` (the source's default is the conductor's business).

- [ ] **Step 1: Write the failing tests**

Create `tests/skills-v2.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readSkillsConfig, writeSkillsConfig, skillsConfigPath,
  normalizeLaneValue, resolveConfiguredSkill,
} from '../scripts/lib/state.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-v2-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

const V2 = {
  version: 2, source: 'combo', shared: false, guard: 'installed',
  steps: { plan: 'my-org:planner' },
  lanes: {
    'feature': { implement: ['my-org:builder', 'superpowers:subagent-driven-development'] },
    'bug-fix': { debug: 'my-org:debugger' },
  },
};

test('v1 config still reads unchanged', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 1, source: 'own', shared: false, steps: { plan: 'x:y' } });
  const c = readSkillsConfig(repo);
  assert.equal(c.version, 1);
  assert.equal(c.steps.plan, 'x:y');
});

test('v2 config roundtrips with lanes and guard', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, V2);
  assert.deepEqual(readSkillsConfig(repo), V2);
});

test('invalid v2 shapes are treated as corrupt (null)', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.senior-dev'), { recursive: true });
  writeFileSync(skillsConfigPath(repo), JSON.stringify({ version: 2, source: 'own', guard: 'maybe' }));
  assert.equal(readSkillsConfig(repo), null);
  writeFileSync(skillsConfigPath(repo), JSON.stringify({ version: 2, source: 'own', lanes: { feature: 'not-an-object' } }));
  assert.equal(readSkillsConfig(repo), null);
  writeFileSync(skillsConfigPath(repo), JSON.stringify({ version: 2, source: 'own', lanes: { feature: { implement: 42 } } }));
  assert.equal(readSkillsConfig(repo), null);
});

test('normalizeLaneValue', () => {
  assert.deepEqual(normalizeLaneValue('a:b'), ['a:b']);
  assert.deepEqual(normalizeLaneValue(['a', 'b']), ['a', 'b']);
});

test('resolveConfiguredSkill precedence: lane over steps over default', () => {
  assert.deepEqual(resolveConfiguredSkill(V2, 'feature', 'implement'),
    { value: ['my-org:builder', 'superpowers:subagent-driven-development'], via: 'lane' });
  assert.deepEqual(resolveConfiguredSkill(V2, 'feature', 'plan'),
    { value: ['my-org:planner'], via: 'steps' });
  assert.deepEqual(resolveConfiguredSkill(V2, 'feature', 'verify'),
    { value: [], via: 'default' });
  assert.deepEqual(resolveConfiguredSkill(V2, 'bug-fix', 'debug'),
    { value: ['my-org:debugger'], via: 'lane' });
  assert.deepEqual(resolveConfiguredSkill(null, 'feature', 'plan'),
    { value: [], via: 'default' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/nzshrimper-senior-dev && node --test tests/skills-v2.test.mjs`
Expected: FAIL — `normalizeLaneValue`/`resolveConfiguredSkill` not exported; v2 read returns null.

- [ ] **Step 3: Implement in `scripts/lib/state.mjs`**

Replace the body of `readSkillsConfig` with:

```js
export function readSkillsConfig(repoRoot) {
  try {
    const c = JSON.parse(readFileSync(skillsConfigPath(repoRoot), 'utf8'));
    if (typeof c !== 'object' || c === null) return null;
    if (c.version !== 1 && c.version !== 2) return null;
    if (c.source !== undefined && !VALID_SOURCES.includes(c.source)) return null;
    if (c.guard !== undefined && !['installed', 'declined'].includes(c.guard)) return null;
    if (c.lanes !== undefined) {
      if (typeof c.lanes !== 'object' || c.lanes === null || Array.isArray(c.lanes)) return null;
      for (const laneMap of Object.values(c.lanes)) {
        if (typeof laneMap !== 'object' || laneMap === null || Array.isArray(laneMap)) return null;
        for (const v of Object.values(laneMap)) {
          const ok = typeof v === 'string'
            || (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string'));
          if (!ok) return null;
        }
      }
    }
    return c;
  } catch {
    return null;
  }
}
```

Add after it:

```js
export function normalizeLaneValue(v) {
  return Array.isArray(v) ? v : [v];
}

// Configured resolution only: lanes -> steps -> default. Which of the
// value's entries is actually installed is the conductor's judgement.
export function resolveConfiguredSkill(cfg, laneType, phase) {
  const laneVal = cfg?.lanes?.[laneType]?.[phase];
  if (laneVal !== undefined) return { value: normalizeLaneValue(laneVal), via: 'lane' };
  const stepVal = cfg?.steps?.[phase];
  if (stepVal !== undefined) return { value: normalizeLaneValue(stepVal), via: 'steps' };
  return { value: [], via: 'default' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/skills-v2.test.mjs` — all PASS. Then full suite `node --test tests/*.test.mjs` — the existing 105 stay green (v1 paths untouched).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/state.mjs tests/skills-v2.test.mjs
git commit -m "feat: skills.json schema v2 - lanes, ordered fallbacks, guard field, configured resolution"
```

---

### Task 2: Guard evaluator + `state-cli guard install|status|uninstall`

**Files:**
- Create: `scripts/guard.mjs`
- Modify: `scripts/state-cli.mjs` (new `guard` case; extend imports)
- Test: `tests/guard.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1's `readSkillsConfig` (guard field), existing lib exports.
- Produces:
  - `scripts/guard.mjs` — argv: `node guard.mjs <pre-commit|pre-push|pre-merge-commit> [...git args]`. Runs ONLY from a bundle (imports `./state-lib.mjs`). Exit 0 allow / 1 block. Used by shims.
  - CLI: `state-cli guard install` (bundle + shims, sets `guard:"installed"`), `guard status` (prints `installed|stale|absent|declined` + wired hooks), `guard uninstall` (removes shims, restores preserved, deletes bundle, sets `guard:"declined"`).
  - `HOOK_NAMES = ['pre-commit','pre-push','pre-merge-commit']` (exported from state-cli? No — keep local constants in each file, same list).

- [ ] **Step 1: Write the failing tests**

Create `tests/guard.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeState, readState, CHAINS, DOCS_GATE, writeSkillsConfig, readSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-guard-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}
function cli(repo, args, input) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', ...(input ? { input } : {}) });
    return { status: 0, out };
  } catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
function hook(repo, name, args = []) {
  try {
    const out = execFileSync(join(repo, '.git', 'hooks', name), args, { cwd: repo, encoding: 'utf8' });
    return { status: 0, out };
  } catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
function blockedState(overrides = {}) {
  return {
    version: 1, task: 'guard test', type: 'quick-fix', startedAt: 'x',
    chain: CHAINS['quick-fix'], phases: { implement: { status: 'done' } },
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'NEEDS_REVISION', cycle: 1 }],
    docsGate: { ...DOCS_GATE['quick-fix'] }, degradations: [], bypasses: [],
    scratchFiles: [], waits: [], stopGate: { lastSnapshotHash: null }, ...overrides,
  };
}

test('guard install creates bundle, shims, and records consent', () => {
  const repo = makeRepo();
  const r = cli(repo, ['guard', 'install']);
  assert.equal(r.status, 0);
  for (const f of ['guard.mjs', 'state-lib.mjs', 'version']) {
    assert.ok(existsSync(join(repo, '.senior-dev', 'guard', f)), f);
  }
  for (const h of ['pre-commit', 'pre-push', 'pre-merge-commit']) {
    const p = join(repo, '.git', 'hooks', h);
    assert.ok(existsSync(p), h);
    assert.ok(readFileSync(p, 'utf8').includes('senior-dev guard shim'));
  }
  assert.equal(readSkillsConfig(repo).guard, 'installed');
});

test('guard status reports installed / absent / declined', () => {
  const repo = makeRepo();
  assert.ok(cli(repo, ['guard', 'status']).out.includes('absent'));
  cli(repo, ['guard', 'install']);
  assert.ok(cli(repo, ['guard', 'status']).out.includes('installed'));
  cli(repo, ['guard', 'uninstall']);
  assert.ok(cli(repo, ['guard', 'status']).out.includes('declined'));
});

test('pre-push hook blocks a staged open-gate session, plain terminal', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState());
  const r = hook(repo, 'pre-push', ['origin', 'file:///dev/null']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('senior-dev gate: integration blocked'));
});

test('pre-push allows when gates are clear, and when no session', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  assert.equal(hook(repo, 'pre-push').status, 0); // no session
  writeState(repo, blockedState({
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'APPROVED', cycle: 1 }],
    phases: { implement: { status: 'done' }, verify: { status: 'done' } },
    docsGate: { handover: true, affectedDocs: true },
  }));
  assert.equal(hook(repo, 'pre-push').status, 0);
});

test('pre-commit enforces tests-green during implement', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState({ phases: { implement: { status: 'in_progress' } }, reviews: [] }));
  const r = hook(repo, 'pre-commit');
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('tests-green'));
  const s = readState(repo);
  s.phases.implement.testsGreenAt = 'now';
  writeState(repo, s);
  assert.equal(hook(repo, 'pre-commit').status, 0);
});

test('armed bypass is consumed once by the guard on a would-block push', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  writeState(repo, blockedState({ bypassArmed: { reason: 'hotfix', at: 'x' } }));
  assert.equal(hook(repo, 'pre-push').status, 0);
  const s = readState(repo);
  assert.equal(s.bypassArmed, undefined);
  assert.equal(s.bypasses.length, 1);
  assert.equal(hook(repo, 'pre-push').status, 1); // consumed - blocks again
});

test('existing hook is preserved and chained; uninstall restores it', () => {
  const repo = makeRepo();
  const hooksDir = join(repo, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\necho prior-hook-ran >&2\nexit 0\n');
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
  cli(repo, ['guard', 'install']);
  assert.ok(existsSync(join(hooksDir, 'pre-push.pre-senior-dev')));
  writeState(repo, blockedState());
  const r = hook(repo, 'pre-push');
  assert.equal(r.status, 1);                       // guard still blocks
  assert.ok(r.out.includes('prior-hook-ran'));     // prior hook ran first
  cli(repo, ['guard', 'uninstall']);
  assert.ok(readFileSync(join(hooksDir, 'pre-push'), 'utf8').includes('prior-hook-ran'));
  assert.ok(!existsSync(join(hooksDir, 'pre-push.pre-senior-dev')));
});

test('prior hook that blocks wins before the guard runs', () => {
  const repo = makeRepo();
  const hooksDir = join(repo, '.git', 'hooks');
  writeFileSync(join(hooksDir, 'pre-push'), '#!/bin/sh\necho prior-block >&2\nexit 7\n');
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
  cli(repo, ['guard', 'install']);
  const r = hook(repo, 'pre-push');
  assert.equal(r.status, 7);
  assert.ok(r.out.includes('prior-block'));
});

test('guard fails open on corrupt state', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  mkdirSync(join(repo, '.senior-dev'), { recursive: true });
  writeFileSync(join(repo, '.senior-dev', 'state.json'), '{corrupt');
  assert.equal(hook(repo, 'pre-push').status, 0);
});

test('install is idempotent and respects core.hooksPath', () => {
  const repo = makeRepo();
  cli(repo, ['guard', 'install']);
  assert.equal(cli(repo, ['guard', 'install']).status, 0); // no double-preserve of our own shim
  assert.ok(!existsSync(join(repo, '.git', 'hooks', 'pre-push.pre-senior-dev')));
  const repo2 = makeRepo();
  mkdirSync(join(repo2, 'myhooks'), { recursive: true });
  execFileSync('git', ['-C', repo2, 'config', 'core.hooksPath', 'myhooks']);
  cli(repo2, ['guard', 'install']);
  assert.ok(existsSync(join(repo2, 'myhooks', 'pre-push')));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/guard.test.mjs`
Expected: FAIL — unknown `guard` subcommand.

- [ ] **Step 3: Write `scripts/guard.mjs`**

```js
#!/usr/bin/env node
// senior-dev universal guard. Runs from the repo bundle at
// .senior-dev/guard/ (installed by `state-cli guard install`), invoked by
// the git hook shims: node guard.mjs <pre-commit|pre-push|pre-merge-commit>.
// Same policies as the Claude Code PreToolUse gate; fails open on any error.
import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findRepoRoot, readState, hasActiveSession, currentPhase,
  integrationBlockers, consumeBypass,
} from './state-lib.mjs';

const TEST_GATED_PHASES = new Set(['implement', 'debug']);
const INTEGRATION_HOOKS = new Set(['pre-push', 'pre-merge-commit']);

function warnOpen(msg) {
  console.error(`senior-dev guard: ${msg} - failing open`);
  process.exit(0);
}

try {
  const hookName = process.argv[2] || '';
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) process.exit(0);
  const state = readState(repoRoot);
  if (!hasActiveSession(state)) process.exit(0);

  // Pass token: written by the Claude Code gate when it ALLOWED an
  // integration action. pre-push args carry no original command string, so
  // we match on type + freshness only; single-use.
  if (INTEGRATION_HOOKS.has(hookName)) {
    const tokenPath = join(dirname(fileURLToPath(import.meta.url)), 'pass.json');
    try {
      const tok = JSON.parse(readFileSync(tokenPath, 'utf8'));
      unlinkSync(tokenPath); // single-use, consumed (or purged) on sight
      if (tok.type === 'integration' && new Date(tok.expiresAt) > new Date()) {
        process.exit(0);
      }
    } catch {}
  }

  let blockMsg = null;
  if (INTEGRATION_HOOKS.has(hookName)) {
    const blockers = integrationBlockers(state);
    if (blockers.length) {
      blockMsg = `integration blocked (${blockers.length} item${blockers.length > 1 ? 's' : ''}):\n- ${blockers.join('\n- ')}`;
    }
  } else if (hookName === 'pre-commit') {
    const cur = currentPhase(state);
    if (cur && TEST_GATED_PHASES.has(cur) && !state.phases?.[cur]?.testsGreenAt) {
      blockMsg = `commit blocked: phase '${cur}' has no green test run recorded. Run the tests, then record tests-green (the conductor skill shows the exact call).`;
    }
  }

  if (blockMsg) {
    if (consumeBypass(repoRoot, state, `git hook ${hookName}`)) process.exit(0);
    console.error(`senior-dev gate: ${blockMsg}\nSee /senior-dev:status for detail, or /senior-dev:bypass <reason> to waive (logged).`);
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  warnOpen(`internal error (${e?.message || e})`);
}
```

- [ ] **Step 4: Add the `guard` case to `scripts/state-cli.mjs`**

Add to the lib import line: `hasActiveSession` is already imported; no new lib imports needed. Add these node imports if absent at top: `import { copyFileSync, chmodSync, unlinkSync, readdirSync } from 'node:fs';` (merge into the existing `node:fs` import) and `import { fileURLToPath } from 'node:url';`.

Add helpers near `parseSteps`:

```js
const GUARD_HOOKS = ['pre-commit', 'pre-push', 'pre-merge-commit'];
const SHIM_MARK = '# senior-dev guard shim';

function pluginVersion() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(p, 'utf8')).version || 'unknown';
  } catch { return 'unknown'; }
}

function hooksDir(repoRoot) {
  try {
    const cfg = execFileSync('git', ['config', 'core.hooksPath'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (cfg) return cfg.startsWith('/') ? cfg : join(repoRoot, cfg);
  } catch {}
  return join(repoRoot, '.git', 'hooks');
}

function shimSource(hookName) {
  return `#!/bin/sh
${SHIM_MARK} (${hookName}) - installed by the senior-dev plugin; 'state-cli guard uninstall' removes it.
HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$HOOK_DIR/${hookName}.pre-senior-dev" ]; then
  "$HOOK_DIR/${hookName}.pre-senior-dev" "$@" || exit $?
fi
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
[ -n "$COMMON_DIR" ] || exit 0
REPO_ROOT=$(dirname "$COMMON_DIR")
GUARD="$REPO_ROOT/.senior-dev/guard/guard.mjs"
if [ ! -f "$GUARD" ]; then echo "senior-dev guard: bundle missing - failing open" >&2; exit 0; fi
if ! command -v node >/dev/null 2>&1; then echo "senior-dev guard: node not found - failing open" >&2; exit 0; fi
exec node "$GUARD" ${hookName} "$@"
`;
}
```

Add the `case 'guard':` block to the switch (near `skills-config`):

```js
  case 'guard': {
    const sub = positional[0];
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const bundleDir = join(repoRoot, '.senior-dev', 'guard');
    const dir = hooksDir(repoRoot);

    if (sub === 'install') {
      mkdirSync(bundleDir, { recursive: true });
      copyFileSync(join(scriptsDir, 'guard.mjs'), join(bundleDir, 'guard.mjs'));
      copyFileSync(join(scriptsDir, 'lib', 'state.mjs'), join(bundleDir, 'state-lib.mjs'));
      writeFileSync(join(bundleDir, 'version'), pluginVersion() + '\n');
      let dirWritable = true;
      try { mkdirSync(dir, { recursive: true }); } catch { dirWritable = false; }
      if (!dirWritable) {
        fail(`cannot write to hooks dir ${dir} - add the shims manually: for each of ${GUARD_HOOKS.join(', ')}, exec node "${join(bundleDir, 'guard.mjs')}" <hook-name>`);
      }
      for (const h of GUARD_HOOKS) {
        const p = join(dir, h);
        try {
          const existing = readFileSync(p, 'utf8');
          if (!existing.includes(SHIM_MARK)) renameSync(p, join(dir, `${h}.pre-senior-dev`));
        } catch {}
        writeFileSync(p, shimSource(h));
        chmodSync(p, 0o755);
      }
      const cfg = readSkillsConfig(repoRoot) || { version: 2, source: 'superpowers', shared: false };
      cfg.version = 2;
      cfg.guard = 'installed';
      writeSkillsConfig(repoRoot, cfg);
      ensureExcluded(repoRoot);
      console.log(`guard installed: bundle at .senior-dev/guard/, hooks (${GUARD_HOOKS.join(', ')}) in ${dir}`);
      break;
    }
    if (sub === 'status') {
      const cfg = readSkillsConfig(repoRoot);
      const bundleOk = existsSync(join(bundleDir, 'guard.mjs')) && existsSync(join(bundleDir, 'state-lib.mjs'));
      const wired = GUARD_HOOKS.filter((h) => {
        try { return readFileSync(join(dir, h), 'utf8').includes(SHIM_MARK); } catch { return false; }
      });
      let verdict;
      if (cfg?.guard === 'declined') verdict = 'declined';
      else if (!bundleOk || wired.length === 0) verdict = 'absent';
      else {
        let stamped = '';
        try { stamped = readFileSync(join(bundleDir, 'version'), 'utf8').trim(); } catch {}
        verdict = stamped === pluginVersion() ? 'installed' : 'stale';
      }
      console.log(`guard: ${verdict}${wired.length ? ` (hooks wired: ${wired.join(', ')})` : ''}`);
      break;
    }
    if (sub === 'uninstall') {
      for (const h of GUARD_HOOKS) {
        const p = join(dir, h);
        try {
          if (readFileSync(p, 'utf8').includes(SHIM_MARK)) unlinkSync(p);
        } catch {}
        try { renameSync(join(dir, `${h}.pre-senior-dev`), p); } catch {}
      }
      for (const f of ['guard.mjs', 'state-lib.mjs', 'version', 'pass.json']) {
        try { unlinkSync(join(bundleDir, f)); } catch {}
      }
      const cfg = readSkillsConfig(repoRoot) || { version: 2, source: 'superpowers', shared: false };
      cfg.version = 2;
      cfg.guard = 'declined';
      writeSkillsConfig(repoRoot, cfg);
      console.log('guard uninstalled: shims removed, any preserved hooks restored');
      break;
    }
    fail('guard needs a subcommand: install | status | uninstall');
    break;
  }
```

(`existsSync` and `renameSync` must be in the `node:fs` import; add if missing.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/guard.test.mjs` — all PASS. Full suite `node --test tests/*.test.mjs` — everything green.

- [ ] **Step 6: Commit**

```bash
git add scripts/guard.mjs scripts/state-cli.mjs tests/guard.test.mjs
git commit -m "feat: universal guard - bundle, chained git-hook shims, install/status/uninstall"
```

---

### Task 3: Pass token (Claude Code gate → guard handshake)

**Files:**
- Modify: `scripts/commit-gate.mjs` (write token on allowed integration)
- Test: `tests/pass-token.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1's `readSkillsConfig` (guard field); Task 2's guard token-consume behaviour.
- Produces: `.senior-dev/guard/pass.json` — `{ "type": "integration", "commandHash": "<sha256 hex>", "expiresAt": "<ISO now+60s>" }`, written ONLY when: active session AND `readSkillsConfig(root)?.guard === 'installed'` AND the decision was ALLOW for an integration-classified command.

- [ ] **Step 1: Write the failing tests**

Create `tests/pass-token.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeState, CHAINS, DOCS_GATE, writeSkillsConfig } from '../scripts/lib/state.mjs';

const GATE = new URL('../scripts/commit-gate.mjs', import.meta.url).pathname;
const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-tok-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}
function gate(repo, command) {
  try {
    execFileSync('node', [GATE], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }) });
    return { blocked: false };
  } catch (e) { return { blocked: e.status === 2 }; }
}
function clearState(overrides = {}) {
  return {
    version: 1, task: 't', type: 'quick-fix', startedAt: 'x',
    chain: CHAINS['quick-fix'],
    phases: { implement: { status: 'done' }, verify: { status: 'done' } },
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'APPROVED', cycle: 1 }],
    docsGate: { handover: true, affectedDocs: true },
    degradations: [], bypasses: [], scratchFiles: [], waits: [],
    stopGate: { lastSnapshotHash: null }, ...overrides,
  };
}
const tokenPath = (repo) => join(repo, '.senior-dev', 'guard', 'pass.json');

test('allowed integration with guard installed writes a fresh token', () => {
  const repo = makeRepo();
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo });
  writeState(repo, clearState());
  assert.equal(gate(repo, 'git push origin main').blocked, false);
  const tok = JSON.parse(readFileSync(tokenPath(repo), 'utf8'));
  assert.equal(tok.type, 'integration');
  assert.equal(typeof tok.commandHash, 'string');
  assert.ok(new Date(tok.expiresAt) > new Date());
});

test('no token when guard not installed, on block, or for plain commits', () => {
  const repo = makeRepo();
  writeState(repo, clearState());
  gate(repo, 'git push origin main');                       // guard absent
  assert.ok(!existsSync(tokenPath(repo)));
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo });
  writeState(repo, clearState({ docsGate: { handover: false, affectedDocs: true } }));
  assert.equal(gate(repo, 'git push origin main').blocked, true);  // blocked
  assert.ok(!existsSync(tokenPath(repo)));
  writeState(repo, clearState());
  gate(repo, 'git commit -m x');                            // commit, not integration
  assert.ok(!existsSync(tokenPath(repo)));
});

test('guard consumes a fresh token and allows; stale token is purged and evaluated', () => {
  const repo = makeRepo();
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo });
  // blocked state + fresh token -> allowed once, token gone, second push blocks
  writeState(repo, clearState({ docsGate: { handover: false, affectedDocs: true } }));
  mkdirSync(join(repo, '.senior-dev', 'guard'), { recursive: true });
  writeFileSync(tokenPath(repo), JSON.stringify({ type: 'integration', commandHash: 'x', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const hookP = join(repo, '.git', 'hooks', 'pre-push');
  const run = () => { try { execFileSync(hookP, [], { cwd: repo, encoding: 'utf8' }); return 0; } catch (e) { return e.status; } };
  assert.equal(run(), 0);
  assert.ok(!existsSync(tokenPath(repo)));
  assert.equal(run(), 1);
  // expired token -> purged, evaluation proceeds (blocks)
  writeFileSync(tokenPath(repo), JSON.stringify({ type: 'integration', commandHash: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(run(), 1);
  assert.ok(!existsSync(tokenPath(repo)));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pass-token.test.mjs`
Expected: first two tests FAIL (no token written); third PASSES already (guard consume shipped in Task 2) — confirm that's the case.

- [ ] **Step 3: Implement the token write in `scripts/commit-gate.mjs`**

Add to imports: `import { createHash } from 'node:crypto';`, `import { writeFileSync, mkdirSync } from 'node:fs';`, `import { join } from 'node:path';`, and add `readSkillsConfig` to the `./lib/state.mjs` import list.

In `main()`, replace the final `process.exit(0);` (after the `if (blockMsg) {...}` block) with:

```js
    // Allowed. If this was an integration action and the universal guard is
    // installed, leave a single-use pass token so the git hook does not
    // re-evaluate (and cannot double-consume a bypass). Best-effort.
    if (isIntegration) {
      try {
        if (readSkillsConfig(repoRoot)?.guard === 'installed') {
          const dir = join(repoRoot, '.senior-dev', 'guard');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'pass.json'), JSON.stringify({
            type: 'integration',
            commandHash: createHash('sha256').update(command).digest('hex'),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }));
        }
      } catch {}
    }
    process.exit(0);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pass-token.test.mjs` — all PASS. Full suite green.

- [ ] **Step 5: Commit**

```bash
git add scripts/commit-gate.mjs tests/pass-token.test.mjs
git commit -m "feat: pass token - Claude Code gate hands allowed integrations to the guard once"
```

---

### Task 4: `skills-config set-lane` + `resolve` CLI

**Files:**
- Modify: `scripts/state-cli.mjs` (two new `skills-config` subcommands)
- Test: `tests/skills-lane-cli.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1's `resolveConfiguredSkill`, `normalizeLaneValue`, v2 read/write; existing `CHAINS`, `parseSteps` pattern.
- Produces:
  - `state-cli skills-config set-lane <lane> --steps 'phase=skill|fallback,phase2=skill'` — `|` separates ordered fallbacks within a phase; `,` separates phases; split each entry on FIRST `=`. Validates lane ∈ CHAINS and each phase ∈ CHAINS[lane]. Writes v2 (upgrades v1 in place, preserving fields).
  - `state-cli skills-config resolve [--lane <lane>]` — prints one line per phase of that lane's chain: `phase: <skill list> (via lane|steps)` or `phase: (source default)`. Default lane: the active session's type, else `feature`.

- [ ] **Step 1: Write the failing tests**

Create `tests/skills-lane-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSkillsConfig, writeSkillsConfig } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-lane-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function cli(repo, args) {
  try { return { status: 0, out: execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8' }) }; }
  catch (e) { return { status: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('set-lane writes v2 lanes with fallback arrays and upgrades v1 in place', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 1, source: 'combo', shared: false, steps: { plan: 'x:y' } });
  const r = cli(repo, ['skills-config', 'set-lane', 'feature', '--steps',
    'implement=my-org:builder|superpowers:subagent-driven-development,plan=my-org:planner']);
  assert.equal(r.status, 0);
  const c = readSkillsConfig(repo);
  assert.equal(c.version, 2);
  assert.equal(c.source, 'combo');               // preserved
  assert.equal(c.steps.plan, 'x:y');             // preserved
  assert.deepEqual(c.lanes.feature.implement, ['my-org:builder', 'superpowers:subagent-driven-development']);
  assert.equal(c.lanes.feature.plan, 'my-org:planner');  // single stays string
});

test('set-lane validates lane and phase names', () => {
  const repo = makeRepo();
  assert.equal(cli(repo, ['skills-config', 'set-lane', 'nonsense', '--steps', 'plan=x']).status, 1);
  assert.equal(cli(repo, ['skills-config', 'set-lane', 'feature', '--steps', 'notaphase=x']).status, 1);
  assert.equal(cli(repo, ['skills-config', 'set-lane', 'feature', '--steps', 'plan']).status, 1);
});

test('resolve prints precedence-applied table for a lane', () => {
  const repo = makeRepo();
  cli(repo, ['skills-config', 'set', '--source', 'combo', '--steps', 'plan=my-org:planner']);
  cli(repo, ['skills-config', 'set-lane', 'feature', '--steps', 'implement=my-org:builder|sp:sdd']);
  const r = cli(repo, ['skills-config', 'resolve', '--lane', 'feature']);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('implement: my-org:builder | sp:sdd (via lane)'));
  assert.ok(r.out.includes('plan: my-org:planner (via steps)'));
  assert.ok(r.out.includes('verify: (source default)'));
});

test('resolve defaults lane from active session type, else feature', () => {
  const repo = makeRepo();
  assert.ok(cli(repo, ['skills-config', 'resolve']).out.includes('brainstorm:')); // feature chain
  cli(repo, ['init', '--task', 't', '--type', 'bug-fix']);
  assert.ok(cli(repo, ['skills-config', 'resolve']).out.includes('debug:'));      // bug-fix chain
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/skills-lane-cli.test.mjs` — FAIL (unknown subcommands).

- [ ] **Step 3: Implement in `scripts/state-cli.mjs`**

Add `resolveConfiguredSkill, normalizeLaneValue` to the lib import. Inside the existing `case 'skills-config':`, add before the final `fail(...)`:

```js
    if (sub === 'set-lane') {
      const lane = positional[1];
      if (!CHAINS[lane]) fail(`set-lane needs a lane, one of: ${Object.keys(CHAINS).join(', ')}`);
      requireValues('skills-config set-lane', flags, ['steps']);
      if (typeof flags.steps !== 'string') fail("set-lane needs --steps 'phase=skill|fallback,...'");
      const laneMap = {};
      for (const pair of flags.steps.split(',')) {
        const t = pair.trim();
        if (!t) continue;
        const eq = t.indexOf('=');
        if (eq < 1) fail(`bad --steps entry '${t}', expected phase=skill[|fallback...]`);
        const phase = t.slice(0, eq).trim();
        if (!CHAINS[lane].includes(phase)) fail(`phase '${phase}' is not in the ${lane} chain (${CHAINS[lane].join(', ')})`);
        const skills = t.slice(eq + 1).split('|').map((s) => s.trim()).filter(Boolean);
        if (!skills.length) fail(`bad --steps entry '${t}': no skill given`);
        laneMap[phase] = skills.length === 1 ? skills[0] : skills;
      }
      const cfg = readSkillsConfig(repoRoot) || { version: 2, source: 'superpowers', shared: false };
      cfg.version = 2;
      cfg.lanes = cfg.lanes || {};
      cfg.lanes[lane] = { ...(cfg.lanes[lane] || {}), ...laneMap };
      writeSkillsConfig(repoRoot, cfg);
      ensureExcluded(repoRoot);
      console.log(`lane '${lane}' skills: ${JSON.stringify(cfg.lanes[lane])}`);
      break;
    }
    if (sub === 'resolve') {
      let lane = typeof flags.lane === 'string' ? flags.lane : null;
      if (!lane) {
        const st = readState(repoRoot);
        lane = (hasActiveSession(st) && CHAINS[st.type]) ? st.type : 'feature';
      }
      if (!CHAINS[lane]) fail(`resolve --lane must be one of: ${Object.keys(CHAINS).join(', ')}`);
      const cfg = readSkillsConfig(repoRoot);
      console.log(`# resolved skills - lane: ${lane} (source: ${cfg?.source || 'superpowers'})`);
      for (const phase of CHAINS[lane]) {
        const { value, via } = resolveConfiguredSkill(cfg, lane, phase);
        console.log(value.length
          ? `${phase}: ${value.join(' | ')} (via ${via})`
          : `${phase}: (source default)`);
      }
      break;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/skills-lane-cli.test.mjs` — all PASS. Full suite green.

- [ ] **Step 5: Commit**

```bash
git add scripts/state-cli.mjs tests/skills-lane-cli.test.mjs
git commit -m "feat: skills-config set-lane + resolve - per-lane fallback mappings via CLI"
```

---

### Task 5: Conductor prose + `/senior-dev:skills` + `/senior-dev:guard` commands

**Files:**
- Modify: `skills/conductor/SKILL.md`
- Create: `commands/skills.md`, `commands/guard.md`

**Interfaces:**
- Consumes: exact CLI surfaces from Tasks 2 & 4 (`guard install|status|uninstall`; `skills-config set-lane <lane> --steps 'phase=skill|fallback,…'`; `skills-config resolve [--lane <lane>]`).
- Produces: the run-time behaviour for spec §6 (consent) and §8 (picker).

- [ ] **Step 1: Add the guard-consent sub-step to §1 Engage in `skills/conductor/SKILL.md`**

Insert a new step after the skill-source step (current step 2), renumbering the classify/init steps that follow:

```markdown
3. **Universal guard (fresh run only, once per repo).** Run
   `state-cli guard status`.
   - `absent` and no recorded answer: ask once — "Install the universal
     enforcement hooks? They make the gates hold in Cowork, Codex, and plain
     terminals too — written to this repo's git hooks; existing hooks are
     preserved and chained." Yes → `state-cli guard install`. No → the CLI
     records the decline; never re-ask.
   - `installed`: proceed silently. `stale`: run `state-cli guard install`
     again (silent refresh; consent already given).
   - `absent` but the config says installed (hooks went missing): mention it
     once and re-offer.
   - `declined`: stay silent; `/senior-dev:guard` remains available.
```

- [ ] **Step 2: Add the picker + fallback rules to the "Skill source resolution" section**

Append after the four-source bullets:

```markdown
**Per-phase picker.** When the operator chooses `own` or `combo` — or asks to
customise skills — offer the picker for the current lane: for each phase show
the current mapping (`state-cli skills-config resolve --lane <lane>`), the
project skills you can see, and installed candidates; let the operator pick per
phase or accept all defaults in one answer. Record picks with
`state-cli skills-config set-lane <lane> --steps 'phase=skill|fallback,...'`
(`|` = ordered fallback, first INSTALLED skill wins; skipping an uninstalled
entry is recorded with `state-cli degrade`). Never hand-edit skills.json.

**Resolution precedence** (the CLI applies it; you honour it): lane mapping →
flat `steps` → the source's default for that phase.
```

- [ ] **Step 3: Create `commands/skills.md`**

```markdown
---
description: Show and customise which skills fill each process phase · Foundry Studio
argument-hint: '[lane]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" skills-config resolve $ARGUMENTS`

Present the resolved table above to the operator verbatim. Then offer the
per-phase picker from the `senior-dev:conductor` skill ("Skill source
resolution" section): for any phase they want to change, collect their pick
and record it with
`state-cli skills-config set-lane <lane> --steps 'phase=skill|fallback,...'`.
```

- [ ] **Step 4: Create `commands/guard.md`**

```markdown
---
description: Install, check, or remove the universal enforcement git hooks · Foundry Studio
argument-hint: '[install|status|uninstall]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" guard ${ARGUMENTS:-status}`

Present the output above. If the operator asked to install or uninstall and
the output shows it happened, confirm what changed (hooks written or removed,
prior hooks preserved/restored). The guard makes the senior-dev gates hold
outside Claude Code too — Cowork, Codex, plain terminals. `gh pr create` has
no git hook and stays Claude-Code-only; say so if asked.
```

- [ ] **Step 5: Verify frontmatter + description length guard**

Run: `python3 -c "import yaml; d=yaml.safe_load(open('skills/conductor/SKILL.md').read().split('---')[1]); print('desc:', len(d['description']))"` → ≤1024 (unchanged).
Run: `head -6 commands/skills.md commands/guard.md` → both show valid frontmatter.

- [ ] **Step 6: Commit**

```bash
git add skills/conductor/SKILL.md commands/skills.md commands/guard.md
git commit -m "feat: conductor guard consent + per-phase picker, /senior-dev:skills and :guard commands"
```

---

### Task 6: Docs, version bump, SMOKE

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `tests/SMOKE.md`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

- [ ] **Step 1: Bump versions**

```bash
cd ~/code/nzshrimper-senior-dev
node -e "for (const f of ['.claude-plugin/plugin.json','.claude-plugin/marketplace.json']){const fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\"version\": \"0\.1\.2\"/g,'\"version\": \"0.2.0\"'));}"
grep -n '"version"' .claude-plugin/*.json
```
Expected: all three `"version"` fields read `0.2.0`.

- [ ] **Step 2: README — add "Universal enforcement" + rewrite the compatibility section**

Insert a new section after "Choosing a skill source":

```markdown
## Universal enforcement (the guard)

The gates don't have to live only in Claude Code. On first run in a repo the
conductor offers to install the **universal guard**: real git hooks
(`pre-commit`, `pre-push`, `pre-merge-commit`) that run the same gate checks
from a self-contained bundle in `.senior-dev/guard/`. Existing hooks are
preserved and chained, never clobbered. With the guard installed, an
unreviewed push is blocked in Cowork, in OpenAI Codex, and in a plain
terminal — same message, same rules. `/senior-dev:guard` installs, checks, or
removes it; uninstall restores whatever hooks were there before.

One honest gap: `gh pr create` has no client-side git hook, so PR creation is
enforced only under Claude Code.
```

Replace the body of "## Requires Claude Code" with (retitle it "## Where the gates hold"):

```markdown
## Where the gates hold

Claude Code is the richest host: the PreToolUse gate stops a gated action
before it even reaches git, the stop gate challenges premature "done", and the
SessionStart bootstrap auto-engages the conductor. Other hosts (Cowork, OpenAI
Codex) don't fire Claude Code plugin hooks (verified 2026-07) — but with the
universal guard installed, the commit/merge/push gates hold there too, enforced
by git itself. Without the guard, non-Claude-Code hosts run the conductor and
state tracking in advisory mode only.
```

- [ ] **Step 3: CHANGELOG entry**

Prepend to `CHANGELOG.md`:

```markdown
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
```

- [ ] **Step 4: SMOKE items**

Append to `tests/SMOKE.md` before the production-mileage note (renumber as needed):

```markdown
- [ ] Guard consent: fresh repo run asks once; decline is remembered
      (state-cli guard status -> declined); /senior-dev:guard install works
      later.
- [ ] Plain-terminal block: with guard installed and open gates staged,
      `git push` in a NON-agent terminal is blocked with the gate message.
- [ ] Token flow (Claude Code): clear all gates, push via the session ->
      allowed once, no double block, no leftover pass.json.
- [ ] Uninstall: prior hook restored byte-identical; guard status -> declined.
- [ ] Codex re-test: sd-demo fixture push now BLOCKED in Codex.
- [ ] Cowork re-test: sd-demo fixture push now BLOCKED in Cowork.
- [ ] Picker: choose combo -> customise implement with a fallback list ->
      /senior-dev:skills shows it; skills.json is v2.
```

- [ ] **Step 5: Full suite + commit**

Run: `node --test tests/*.test.mjs` — green.
```bash
git add README.md CHANGELOG.md tests/SMOKE.md .claude-plugin
git commit -m "docs: v0.2.0 - universal guard + picker docs, changelog, smoke, version bump"
```

---

### Task 7: Validation, final review, merge, reinstall

- [ ] **Step 1: Full suite baseline** — `node --test tests/*.test.mjs` all green.
- [ ] **Step 2: Dispatch `plugin-dev:plugin-validator`** on the repo (manifests at 0.2.0, two new commands' frontmatter, skill description ≤1024, no dev artifacts shipping). Fix blockers.
- [ ] **Step 3: Dispatch `plugin-dev:skill-reviewer`** on `skills/conductor/SKILL.md` (new §1 step numbering coherent; every CLI call matches the real CLI: `guard install|status|uninstall`, `set-lane` syntax with `|` and `,`, `resolve --lane`). Fix findings.
- [ ] **Step 4: Whole-branch review** — `review-package $(git merge-base main HEAD) HEAD`; most capable model; special attention: guard-vs-commit-gate policy parity (same block decisions from the same state), token single-use under races, uninstall restore fidelity, hooksPath handling, schema-v2 backward compat. ONE fix subagent for the findings list.
- [ ] **Step 5: Merge, tag, push, reinstall**

```bash
cd ~/code/nzshrimper-senior-dev
git checkout main && git merge --ff-only v0.2 && git branch -d v0.2 && git tag v0.2.0
# push via the nzshrimper account, then:
claude plugin marketplace update nzshrimper-senior-dev
claude plugin update senior-dev@nzshrimper-senior-dev
git worktree list && git branch --list && git status --porcelain
```
Operator restart loads v0.2.0.

- [ ] **Step 6: Live acceptance (operator at keyboard)** — re-stage the `~/sd-demo` fixture (`guard install` + open-gate state), then re-run the naughty push in **Codex** and **Cowork**: both must now show `senior-dev gate: integration blocked`. Record results in SMOKE.md; only then update the README/directory claims if desired.

---

## Self-Review (completed at write time)

**Spec coverage:** §3 bundle+CLI → Task 2; §4 shims/chaining/hooksPath/coverage note → Task 2 + README Task 6; §5 token → Task 3 (with the pre-push-args correction encoded); §6 consent → Task 5 §1-step + Task 2 CLI; §7 schema v2 → Task 1; §8 picker + skills/resolve → Tasks 4–5; §9 failure modes → fail-open in guard.mjs/shims + corrupt-state test + hooksPath fail path; §10 testing → Tasks 1–4 unit/integration, Task 7 live acceptance; §12 docs/version → Task 6; §13 criteria 1(T2/T7), 2(T3), 3(T2/T5), 4(T2), 5(T1/T4/T5), 6(T2 fail-open tests), 7(all).

**Placeholder scan:** clean — every code step carries complete code; the operator-run live tests are explicit operator steps, not placeholders.

**Type consistency:** `guard install|status|uninstall` consistent across Tasks 2/5/6; `set-lane`/`resolve` syntax identical in Tasks 4/5; token shape `{type, commandHash, expiresAt}` identical in Tasks 2/3; bundle filenames (`guard.mjs`, `state-lib.mjs`, `version`, `pass.json`) consistent across Tasks 2/3; `readSkillsConfig` v2 fields (`lanes`, `guard`) consistent across Tasks 1/2/3/4.
