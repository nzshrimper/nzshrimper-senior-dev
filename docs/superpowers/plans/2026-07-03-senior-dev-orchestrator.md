# senior-dev Orchestrator Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `senior-dev` Claude Code plugin that orchestrates disciplined coding sessions: classify the task, enforce the right installed-skill chain, gate commits/integration/stop on review + verification + docs, run read-only Codex phase reviews, and close with a zero-leftovers hygiene sweep.

**Architecture:** One conductor skill (prose brain) + one deterministic state CLI + three fail-open hook scripts (SessionStart bootstrap, PreToolUse commit gate, Stop gate), all reading/writing `.senior-dev/state.json` in the target repo. Spec: `docs/superpowers/specs/2026-07-03-senior-dev-orchestrator-design.md`.

**Tech Stack:** Node ≥ 18 stdlib only (no npm dependencies), `node:test` runner, Claude Code plugin format (plugin.json / hooks.json / commands / skills), local marketplace install.

## Global Constraints

- **No npm dependencies.** `node:` stdlib only. No `package.json` needed; tests run via `node --test tests/`.
- **Fail open, always.** Every hook script wraps its entire body; any error → `process.exit(0)` with no output. A broken hook must never block normal work.
- **Gates arm only when an active session exists** in `.senior-dev/state.json` (`task` set, no `closedAt`).
- **Read-only Codex only.** The conductor may reference `/codex:review` and `/codex:adversarial-review`. The strings `codex-rescue`, `rescue`, or any write lane must not appear as instructions to run.
- **Skill description ≤ 1024 characters** (marketplace validation rejects longer).
- **Names are fixed:** plugin `senior-dev`, marketplace `senior-dev-local`, state file `.senior-dev/state.json`, history `.senior-dev/history/`.
- **State excluded via `.git/info/exclude`** — never touch the target repo's `.gitignore`.
- **Timestamps** via `new Date().toISOString()`.
- Repo root for all paths below: `~/code/senior-dev`.

---

### Task 1: Plugin scaffold (manifests, hooks wiring, gitignore)

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `hooks/hooks.json`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: hook wiring that later tasks' scripts must satisfy: `scripts/session-start.mjs`, `scripts/commit-gate.mjs`, `scripts/stop-gate.mjs` (exact paths referenced in hooks.json).

- [ ] **Step 1: Verify node is available**

Run: `node --version`
Expected: `v18.x` or higher (any modern version).

- [ ] **Step 2: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "senior-dev",
  "version": "0.1.0",
  "description": "Orchestrates a senior-dev coding session: classifies the task, enforces the right installed-skill chain (superpowers, codex, built-in reviews), gates commits and session-close on review + verification + documentation, and finishes with a zero-leftovers hygiene sweep.",
  "author": {
    "name": "Chris Bennett",
    "email": "nzshrimper@gmail.com"
  },
  "license": "MIT",
  "keywords": ["workflow", "orchestration", "code-review", "codex", "hygiene", "documentation"]
}
```

- [ ] **Step 3: Write `.claude-plugin/marketplace.json`**

```json
{
  "name": "senior-dev-local",
  "owner": {
    "name": "Chris Bennett",
    "email": "nzshrimper@gmail.com"
  },
  "metadata": {
    "description": "Local marketplace for the senior-dev session orchestrator plugin",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "senior-dev",
      "source": "./",
      "description": "Senior-dev session orchestrator: skill routing, hard gates, Codex phase reviews, docs gate, hygiene sweep.",
      "version": "0.1.0"
    }
  ]
}
```

- [ ] **Step 4: Write `hooks/hooks.json`**

```json
{
  "description": "senior-dev orchestrator gates: session bootstrap, commit/integration gate, stop gate. All fail open.",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/commit-gate.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-gate.mjs\"",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 5: Write `.gitignore`**

```
.DS_Store
node_modules/
```

- [ ] **Step 6: Validate all three JSON files parse**

Run: `cd ~/code/senior-dev && for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json hooks/hooks.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8')); console.log('OK $f')"; done`
Expected: three `OK` lines.

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin hooks .gitignore
git commit -m "feat: plugin scaffold - manifests, hook wiring, gitignore"
```

---

### Task 2: State library (`scripts/lib/state.mjs`)

**Files:**
- Create: `scripts/lib/state.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (exact signatures; every later script imports from here):
  - `findRepoRoot(cwd?: string): string | null`
  - `statePath(repoRoot: string): string`
  - `readState(repoRoot: string): object | null` — null on missing/corrupt/wrong-version
  - `writeState(repoRoot: string, state: object): void` — atomic (tmp + rename)
  - `hasActiveSession(state: object | null): boolean`
  - `currentPhase(state: object): string | null` — first chain phase not `done`
  - `latestVerdicts(state: object): Record<string, string>` — last verdict per phase
  - `openGateItems(state: object | null): string[]` — `phase:X`, `review:X=V`, `docs:X` strings
  - `integrationBlockers(state: object): string[]` — human-readable blockers for merge/push/PR
  - `snapshotHash(items: string[]): string` — sha256 hex, order-insensitive
  - `ensureExcluded(repoRoot: string): void` — adds `.senior-dev/` to `.git/info/exclude`, idempotent
  - `consumeBypass(repoRoot: string, state: object, action: string): boolean`
  - `CHAINS: Record<string, string[]>` and `DOCS_GATE: Record<string, object>` — lane definitions

- [ ] **Step 1: Write the failing tests**

Create `tests/state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  findRepoRoot, readState, writeState, hasActiveSession, currentPhase,
  latestVerdicts, openGateItems, integrationBlockers, snapshotHash,
  ensureExcluded, consumeBypass, statePath, CHAINS, DOCS_GATE,
} from '../scripts/lib/state.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-test-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function activeState(overrides = {}) {
  return {
    version: 1,
    task: 'test task',
    type: 'feature',
    startedAt: '2026-07-03T00:00:00.000Z',
    chain: CHAINS['feature'],
    phases: {},
    reviews: [],
    docsGate: { ...DOCS_GATE['feature'] },
    degradations: [],
    bypasses: [],
    stopGate: { lastSnapshotHash: null },
    ...overrides,
  };
}

test('findRepoRoot returns null outside a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-norepo-'));
  assert.equal(findRepoRoot(dir), null);
});

test('findRepoRoot finds the repo root', () => {
  const repo = makeRepo();
  const sub = join(repo, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  assert.equal(realpath(findRepoRoot(sub)), realpath(repo));
});

function realpath(p) {
  return execFileSync('realpath', [p]).toString().trim();
}

test('read/write state roundtrip', () => {
  const repo = makeRepo();
  const s = activeState();
  writeState(repo, s);
  assert.deepEqual(readState(repo), s);
});

test('readState returns null for missing, corrupt, and wrong-version files', () => {
  const repo = makeRepo();
  assert.equal(readState(repo), null);
  mkdirSync(join(repo, '.senior-dev'), { recursive: true });
  writeFileSync(statePath(repo), 'not json{{{');
  assert.equal(readState(repo), null);
  writeFileSync(statePath(repo), JSON.stringify({ version: 99, task: 'x' }));
  assert.equal(readState(repo), null);
});

test('hasActiveSession', () => {
  assert.equal(hasActiveSession(null), false);
  assert.equal(hasActiveSession(activeState()), true);
  assert.equal(hasActiveSession(activeState({ closedAt: 'now' })), false);
});

test('currentPhase walks the chain', () => {
  const s = activeState();
  assert.equal(currentPhase(s), 'brainstorm');
  s.phases.brainstorm = { status: 'done' };
  s.phases.worktree = { status: 'done' };
  assert.equal(currentPhase(s), 'plan');
});

test('latestVerdicts keeps the last verdict per phase', () => {
  const s = activeState({
    reviews: [
      { phase: 'implement', reviewer: 'codex', cycle: 1, verdict: 'NEEDS_REVISION' },
      { phase: 'implement', reviewer: 'codex', cycle: 2, verdict: 'APPROVED' },
    ],
  });
  assert.deepEqual(latestVerdicts(s), { implement: 'APPROVED' });
});

test('openGateItems lists undone phases, unapproved reviews, missing docs', () => {
  const s = activeState({
    reviews: [{ phase: 'implement', reviewer: 'codex', cycle: 1, verdict: 'NEEDS_REVISION' }],
  });
  const items = openGateItems(s);
  assert.ok(items.includes('phase:brainstorm'));
  assert.ok(items.includes('review:implement=NEEDS_REVISION'));
  assert.ok(items.includes('docs:spec'));
  assert.deepEqual(openGateItems(null), []);
});

test('openGateItems ignores waived docs items (null) and true items', () => {
  const s = activeState({ docsGate: { spec: null, plan: true, handover: false } });
  const items = openGateItems(s);
  assert.ok(!items.includes('docs:spec'));
  assert.ok(!items.includes('docs:plan'));
  assert.ok(items.includes('docs:handover'));
});

test('integrationBlockers requires approved reviews, verify done, docs ticked', () => {
  const s = activeState({
    reviews: [{ phase: 'implement', reviewer: 'codex', cycle: 1, verdict: 'NEEDS_REVISION' }],
  });
  const blockers = integrationBlockers(s);
  assert.ok(blockers.some((b) => b.includes('implement')));
  assert.ok(blockers.some((b) => b.includes('verification')));
  assert.ok(blockers.some((b) => b.includes('spec')));
  // all-green case
  const g = activeState({
    reviews: [{ phase: 'implement', reviewer: 'codex', cycle: 1, verdict: 'APPROVED' }],
    phases: { verify: { status: 'done' } },
    docsGate: { spec: true, plan: true, handover: true, affectedDocs: true },
  });
  assert.deepEqual(integrationBlockers(g), []);
});

test('integrationBlockers demands at least one review except docs-only/investigation', () => {
  const s = activeState({
    phases: { verify: { status: 'done' } },
    docsGate: { spec: true, plan: true, handover: true, affectedDocs: true },
  });
  assert.ok(integrationBlockers(s).some((b) => b.includes('no review')));
  const d = activeState({
    type: 'docs-only', chain: CHAINS['docs-only'],
    docsGate: { handover: true },
  });
  assert.ok(!integrationBlockers(d).some((b) => b.includes('no review')));
});

test('snapshotHash is order-insensitive and content-sensitive', () => {
  assert.equal(snapshotHash(['a', 'b']), snapshotHash(['b', 'a']));
  assert.notEqual(snapshotHash(['a']), snapshotHash(['a', 'b']));
});

test('ensureExcluded adds .senior-dev/ once', () => {
  const repo = makeRepo();
  ensureExcluded(repo);
  ensureExcluded(repo);
  const content = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(content.split('\n').filter((l) => l === '.senior-dev/').length, 1);
});

test('consumeBypass is one-shot and logged', () => {
  const repo = makeRepo();
  const s = activeState({ bypassArmed: { reason: 'hotfix', at: 'now' } });
  writeState(repo, s);
  assert.equal(consumeBypass(repo, s, 'git push'), true);
  const after = readState(repo);
  assert.equal(after.bypassArmed, undefined);
  assert.equal(after.bypasses.length, 1);
  assert.equal(after.bypasses[0].action, 'git push');
  assert.equal(consumeBypass(repo, after, 'git push'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/senior-dev && node --test tests/`
Expected: FAIL — `Cannot find module '../scripts/lib/state.mjs'`.

- [ ] **Step 3: Write `scripts/lib/state.mjs`**

```js
// Shared state for the senior-dev orchestrator. Single source of truth for
// lane definitions and gate logic; hooks and the CLI both import from here.
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

export const CHAINS = {
  'feature':       ['brainstorm', 'worktree', 'plan', 'implement', 'review', 'verify', 'docs', 'finish'],
  'bug-fix':       ['debug', 'implement', 'review', 'verify', 'docs', 'finish'],
  'refactor':      ['worktree', 'plan', 'implement', 'review', 'verify', 'docs', 'finish'],
  'quick-fix':     ['implement', 'review', 'verify', 'docs', 'finish'],
  'docs-only':     ['implement', 'review', 'docs', 'finish'],
  'investigation': ['investigate', 'finish'],
};

// false = required and missing; true = done; null = waived for this lane.
export const DOCS_GATE = {
  'feature':       { spec: false, plan: false, handover: false, affectedDocs: false },
  'refactor':      { spec: false, plan: false, handover: false, affectedDocs: false },
  'bug-fix':       { handover: false, affectedDocs: false },
  'quick-fix':     { handover: false, affectedDocs: false },
  'docs-only':     { handover: false },
  'investigation': {},
};

// Lanes where a recorded review is not demanded before integration.
const REVIEW_EXEMPT = new Set(['docs-only', 'investigation']);

export function findRepoRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

export function statePath(repoRoot) {
  return join(repoRoot, '.senior-dev', 'state.json');
}

export function readState(repoRoot) {
  try {
    const s = JSON.parse(readFileSync(statePath(repoRoot), 'utf8'));
    if (typeof s !== 'object' || s === null || s.version !== 1) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeState(repoRoot, state) {
  const p = statePath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, p);
}

export function hasActiveSession(state) {
  return !!(state && state.task && !state.closedAt);
}

export function currentPhase(state) {
  for (const name of state.chain || []) {
    const ph = (state.phases || {})[name];
    if (!ph || ph.status !== 'done') return name;
  }
  return null;
}

export function latestVerdicts(state) {
  const by = {};
  for (const r of state.reviews || []) by[r.phase] = r.verdict;
  return by;
}

export function openGateItems(state) {
  if (!hasActiveSession(state)) return [];
  const items = [];
  for (const name of state.chain || []) {
    const ph = (state.phases || {})[name];
    if (!ph || ph.status !== 'done') items.push(`phase:${name}`);
  }
  for (const [phase, v] of Object.entries(latestVerdicts(state))) {
    if (v !== 'APPROVED') items.push(`review:${phase}=${v}`);
  }
  for (const [k, v] of Object.entries(state.docsGate || {})) {
    if (v === false) items.push(`docs:${k}`);
  }
  return items;
}

export function integrationBlockers(state) {
  const blockers = [];
  for (const [phase, v] of Object.entries(latestVerdicts(state))) {
    if (v !== 'APPROVED') blockers.push(`review for '${phase}' is ${v}, not APPROVED`);
  }
  if ((state.reviews || []).length === 0 && !REVIEW_EXEMPT.has(state.type)) {
    blockers.push('no review recorded for this session');
  }
  if ((state.chain || []).includes('verify') && (state.phases || {}).verify?.status !== 'done') {
    blockers.push('verification phase not done');
  }
  for (const [k, v] of Object.entries(state.docsGate || {})) {
    if (v === false) blockers.push(`docs gate item '${k}' incomplete`);
  }
  return blockers;
}

export function snapshotHash(items) {
  return createHash('sha256').update(items.slice().sort().join('|')).digest('hex');
}

export function ensureExcluded(repoRoot) {
  try {
    const p = join(repoRoot, '.git', 'info', 'exclude');
    const line = '.senior-dev/';
    let cur = '';
    try { cur = readFileSync(p, 'utf8'); } catch {}
    if (!cur.split('\n').includes(line)) {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, (cur === '' || cur.endsWith('\n') ? '' : '\n') + line + '\n');
    }
  } catch {}
}

export function consumeBypass(repoRoot, state, action) {
  if (!state.bypassArmed) return false;
  state.bypasses = state.bypasses || [];
  state.bypasses.push({
    at: new Date().toISOString(),
    reason: state.bypassArmed.reason,
    action,
  });
  delete state.bypassArmed;
  writeState(repoRoot, state);
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/code/senior-dev && node --test tests/`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/state.mjs tests/state.test.mjs
git commit -m "feat: state library - lanes, gate logic, atomic persistence"
```

---

### Task 3: State CLI (`scripts/state-cli.mjs`)

**Files:**
- Create: `scripts/state-cli.mjs`
- Test: `tests/state-cli.test.mjs`

**Interfaces:**
- Consumes: everything from `scripts/lib/state.mjs` (Task 2 signatures).
- Produces a CLI later tasks (conductor skill + commands) call as
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" <subcommand> [flags]`:
  - `init --task <text> --type <feature|bug-fix|refactor|quick-fix|docs-only|investigation>` — creates state, runs `ensureExcluded`
  - `phase <name> --status <in_progress|done> [--artefact <path>]`
  - `tests-green` — stamps `testsGreenAt` on the current phase
  - `review --phase <name> --reviewer <codex|claude> --verdict <APPROVED|NEEDS_REVISION> --cycle <n>`
  - `docs --<spec|plan|handover|affectedDocs> <true|false>` (repeatable)
  - `degrade --wanted <skill> --used <fallback> --reason <text>`
  - `bypass --reason <text>` — arms one-shot bypass; refuses empty reason
  - `scratch --add <path>` — records a scratch file for the sweep
  - `status` — human-readable report
  - `sweep` — prints evidence: `git worktree list`, `git branch --list`, `git status --porcelain`, scratch-file existence
  - `finish` — archives state to `.senior-dev/history/<date>-<slug>.json`, sets `closedAt`, removes active state file
- All subcommands print to stdout; exit 1 with a message on bad usage; exit 0 otherwise.

- [ ] **Step 1: Write the failing tests**

Create `tests/state-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, statePath } from '../scripts/lib/state.mjs';

const CLI = new URL('../scripts/state-cli.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-cli-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function cli(repo, args, opts = {}) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8', ...opts });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('init creates state with the right chain and docs gate, and excludes dir', () => {
  const repo = makeRepo();
  const r = cli(repo, ['init', '--task', 'add widget', '--type', 'feature']);
  assert.equal(r.status, 0);
  const s = readState(repo);
  assert.equal(s.task, 'add widget');
  assert.equal(s.type, 'feature');
  assert.equal(s.chain[0], 'brainstorm');
  assert.equal(s.docsGate.spec, false);
  const exclude = join(repo, '.git', 'info', 'exclude');
  assert.ok(require('node:fs').readFileSync(exclude, 'utf8').includes('.senior-dev/'));
});

test('init rejects unknown type', () => {
  const repo = makeRepo();
  const r = cli(repo, ['init', '--task', 'x', '--type', 'nonsense']);
  assert.equal(r.status, 1);
});

test('phase + tests-green + review + docs update state', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'bug-fix']);
  cli(repo, ['phase', 'debug', '--status', 'done', '--artefact', 'notes.md']);
  cli(repo, ['phase', 'implement', '--status', 'in_progress']);
  cli(repo, ['tests-green']);
  cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--verdict', 'APPROVED', '--cycle', '1']);
  cli(repo, ['docs', '--handover', 'true']);
  const s = readState(repo);
  assert.equal(s.phases.debug.status, 'done');
  assert.equal(s.phases.debug.artefact, 'notes.md');
  assert.ok(s.phases.implement.testsGreenAt);
  assert.equal(s.reviews[0].verdict, 'APPROVED');
  assert.equal(s.docsGate.handover, true);
});

test('bypass requires a reason and arms one-shot flag', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  assert.equal(cli(repo, ['bypass', '--reason', '']).status, 1);
  assert.equal(cli(repo, ['bypass']).status, 1);
  assert.equal(cli(repo, ['bypass', '--reason', 'operator hotfix']).status, 0);
  assert.equal(readState(repo).bypassArmed.reason, 'operator hotfix');
});

test('status renders without crashing and mentions task + phase', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'my task', '--type', 'feature']);
  const r = cli(repo, ['status']);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('my task'));
  assert.ok(r.out.includes('brainstorm'));
});

test('status reports no active session when none exists', () => {
  const repo = makeRepo();
  const r = cli(repo, ['status']);
  assert.equal(r.status, 0);
  assert.ok(r.out.toLowerCase().includes('no active'));
});

test('sweep prints git evidence sections', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['sweep']);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('git worktree list'));
  assert.ok(r.out.includes('git status --porcelain'));
});

test('finish archives and clears active state', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'Fix the thing!', '--type', 'quick-fix']);
  const r = cli(repo, ['finish']);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(statePath(repo)));
  const hist = readdirSync(join(repo, '.senior-dev', 'history'));
  assert.equal(hist.length, 1);
  assert.ok(hist[0].endsWith('.json'));
});
```

Note: the first test uses `require('node:fs')` inside an ESM file — replace with a top-of-file `import { readFileSync } from 'node:fs';` and call `readFileSync(exclude, 'utf8')` directly when writing the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/senior-dev && node --test tests/state-cli.test.mjs`
Expected: FAIL — cannot find `../scripts/state-cli.mjs`.

- [ ] **Step 3: Write `scripts/state-cli.mjs`**

```js
#!/usr/bin/env node
// Deterministic state mutations for the senior-dev orchestrator.
// The conductor skill calls this instead of hand-editing JSON.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAINS, DOCS_GATE, findRepoRoot, readState, writeState, statePath,
  hasActiveSession, currentPhase, latestVerdicts, openGateItems, ensureExcluded,
} from './lib/state.mjs';

function fail(msg) {
  console.error(`senior-dev: ${msg}`);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

function requireSession(repoRoot) {
  const state = readState(repoRoot);
  if (!hasActiveSession(state)) fail('no active session (run /senior-dev:start)');
  return state;
}

function git(repoRoot, args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trimEnd();
  } catch (e) {
    return `(git ${args.join(' ')} failed: ${e.message})`;
  }
}

const repoRoot = findRepoRoot();
if (!repoRoot) fail('not inside a git repository');

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const positional = rest.filter((a, i) => !a.startsWith('--') && (i === 0 || !rest[i - 1].startsWith('--')));

switch (cmd) {
  case 'init': {
    if (!flags.task) fail('init needs --task');
    if (!CHAINS[flags.type]) fail(`init needs --type, one of: ${Object.keys(CHAINS).join(', ')}`);
    const existing = readState(repoRoot);
    if (hasActiveSession(existing)) fail(`a session is already active ('${existing.task}'); finish or bypass it first`);
    const state = {
      version: 1,
      task: flags.task,
      type: flags.type,
      startedAt: new Date().toISOString(),
      worktree: null,
      chain: CHAINS[flags.type],
      phases: {},
      reviews: [],
      docsGate: { ...DOCS_GATE[flags.type] },
      degradations: [],
      bypasses: [],
      scratchFiles: [],
      stopGate: { lastSnapshotHash: null },
    };
    writeState(repoRoot, state);
    ensureExcluded(repoRoot);
    console.log(`senior-dev session started: [${flags.type}] ${flags.task}`);
    console.log(`chain: ${state.chain.join(' -> ')}`);
    break;
  }
  case 'phase': {
    const state = requireSession(repoRoot);
    const name = positional[0];
    if (!name || !state.chain.includes(name)) fail(`phase must be one of: ${state.chain.join(', ')}`);
    if (!['in_progress', 'done'].includes(flags.status)) fail('phase needs --status in_progress|done');
    state.phases[name] = { ...(state.phases[name] || {}), status: flags.status };
    if (flags.artefact) state.phases[name].artefact = flags.artefact;
    writeState(repoRoot, state);
    console.log(`phase ${name}: ${flags.status}${flags.artefact ? ` (${flags.artefact})` : ''}`);
    break;
  }
  case 'tests-green': {
    const state = requireSession(repoRoot);
    const cur = currentPhase(state);
    if (!cur) fail('all phases already done');
    state.phases[cur] = { ...(state.phases[cur] || { status: 'in_progress' }), testsGreenAt: new Date().toISOString() };
    writeState(repoRoot, state);
    console.log(`tests green recorded on phase '${cur}'`);
    break;
  }
  case 'review': {
    const state = requireSession(repoRoot);
    if (!flags.phase || !flags.reviewer || !['APPROVED', 'NEEDS_REVISION'].includes(flags.verdict)) {
      fail('review needs --phase --reviewer --verdict APPROVED|NEEDS_REVISION [--cycle n]');
    }
    const cycle = parseInt(flags.cycle || '1', 10);
    if (cycle > 3) fail('cycle cap is 3 - stop iterating and escalate to the operator');
    state.reviews.push({
      phase: flags.phase, reviewer: flags.reviewer, verdict: flags.verdict,
      cycle, at: new Date().toISOString(),
    });
    writeState(repoRoot, state);
    console.log(`review recorded: ${flags.phase} cycle ${cycle} -> ${flags.verdict}`);
    break;
  }
  case 'docs': {
    const state = requireSession(repoRoot);
    let touched = false;
    for (const key of Object.keys(state.docsGate)) {
      if (flags[key] !== undefined) {
        state.docsGate[key] = flags[key] === 'true';
        touched = true;
      }
    }
    if (!touched) fail(`docs needs at least one of: ${Object.keys(state.docsGate).map((k) => '--' + k).join(' ')}`);
    writeState(repoRoot, state);
    console.log(`docs gate: ${JSON.stringify(state.docsGate)}`);
    break;
  }
  case 'degrade': {
    const state = requireSession(repoRoot);
    if (!flags.wanted || !flags.used) fail('degrade needs --wanted --used [--reason]');
    state.degradations.push({ wanted: flags.wanted, used: flags.used, reason: flags.reason || '', at: new Date().toISOString() });
    writeState(repoRoot, state);
    console.log(`degradation recorded: wanted ${flags.wanted}, using ${flags.used}`);
    break;
  }
  case 'bypass': {
    const state = requireSession(repoRoot);
    if (!flags.reason || flags.reason === 'true' || !flags.reason.trim()) fail('bypass needs --reason "<why>"');
    state.bypassArmed = { reason: flags.reason, at: new Date().toISOString() };
    writeState(repoRoot, state);
    console.log(`bypass armed (one-shot) - reason logged: ${flags.reason}`);
    break;
  }
  case 'scratch': {
    const state = requireSession(repoRoot);
    if (!flags.add) fail('scratch needs --add <path>');
    state.scratchFiles = state.scratchFiles || [];
    state.scratchFiles.push(flags.add);
    writeState(repoRoot, state);
    console.log(`scratch file tracked: ${flags.add}`);
    break;
  }
  case 'status': {
    const state = readState(repoRoot);
    if (!hasActiveSession(state)) {
      console.log('senior-dev: no active session in this repo.');
      break;
    }
    console.log(`# senior-dev session\n`);
    console.log(`task:   ${state.task}`);
    console.log(`type:   ${state.type}`);
    console.log(`phase:  ${currentPhase(state) || '(all done)'}\n`);
    console.log('phases:');
    for (const name of state.chain) {
      const ph = state.phases[name];
      const mark = ph?.status === 'done' ? 'x' : ph?.status === 'in_progress' ? '~' : ' ';
      console.log(`  [${mark}] ${name}${ph?.artefact ? ` (${ph.artefact})` : ''}${ph?.testsGreenAt ? ' tests-green' : ''}`);
    }
    const verdicts = latestVerdicts(state);
    if (Object.keys(verdicts).length) console.log(`reviews: ${JSON.stringify(verdicts)}`);
    console.log(`docs gate: ${JSON.stringify(state.docsGate)}`);
    if (state.degradations.length) console.log(`degradations: ${state.degradations.map((d) => `${d.wanted} -> ${d.used}`).join('; ')}`);
    if (state.bypasses.length) console.log(`bypasses used: ${state.bypasses.map((b) => `${b.action}: ${b.reason}`).join('; ')}`);
    if (state.bypassArmed) console.log(`bypass ARMED: ${state.bypassArmed.reason}`);
    const open = openGateItems(state);
    console.log(open.length ? `open gate items (${open.length}):\n  - ${open.join('\n  - ')}` : 'all gates clear.');
    break;
  }
  case 'sweep': {
    requireSession(repoRoot);
    const state = readState(repoRoot);
    console.log('# hygiene sweep evidence\n');
    for (const args of [['worktree', 'list'], ['branch', '--list'], ['status', '--porcelain']]) {
      console.log(`$ git ${args.join(' ')}`);
      const out = git(repoRoot, args);
      console.log(out === '' ? '(clean)' : out);
      console.log('');
    }
    const scratch = state.scratchFiles || [];
    console.log('scratch files tracked this session:');
    if (!scratch.length) console.log('(none)');
    for (const f of scratch) {
      console.log(`  ${existsSync(join(repoRoot, f)) || existsSync(f) ? 'STILL PRESENT' : 'gone'}: ${f}`);
    }
    break;
  }
  case 'finish': {
    const state = requireSession(repoRoot);
    state.closedAt = new Date().toISOString();
    const slug = state.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
    const histDir = join(repoRoot, '.senior-dev', 'history');
    mkdirSync(histDir, { recursive: true });
    const dest = join(histDir, `${state.closedAt.slice(0, 10)}-${slug}.json`);
    writeState(repoRoot, state);
    renameSync(statePath(repoRoot), dest);
    console.log(`session closed and archived: ${dest}`);
    break;
  }
  default:
    fail(`unknown subcommand '${cmd || ''}'. Use: init|phase|tests-green|review|docs|degrade|bypass|scratch|status|sweep|finish`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/code/senior-dev && node --test tests/state-cli.test.mjs`
Expected: all PASS. Then run the full suite: `node --test tests/` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/state-cli.mjs tests/state-cli.test.mjs
git commit -m "feat: state CLI - deterministic session mutations, status, sweep, finish"
```

---

### Task 4: SessionStart bootstrap (`scripts/session-start.mjs`)

**Files:**
- Create: `scripts/session-start.mjs`
- Test: `tests/session-start.test.mjs`

**Interfaces:**
- Consumes: `findRepoRoot`, `readState`, `hasActiveSession`, `currentPhase`, `openGateItems` from `scripts/lib/state.mjs`.
- Produces: stdout JSON `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "<text>" } }` in a git repo; **no output at all** outside one. Reads hook stdin JSON for `cwd` (falls back to `process.cwd()`).

- [ ] **Step 1: Write the failing tests**

Create `tests/session-start.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeState, CHAINS, DOCS_GATE } from '../scripts/lib/state.mjs';

const SCRIPT = new URL('../scripts/session-start.mjs', import.meta.url).pathname;

function run(cwd, stdinObj = {}) {
  return execFileSync('node', [SCRIPT], {
    cwd, encoding: 'utf8', input: JSON.stringify({ cwd, ...stdinObj }),
  });
}

test('outside a git repo: silent, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sd-ss-norepo-'));
  assert.equal(run(dir), '');
});

test('in a repo with no session: emits bootstrap context', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-'));
  execFileSync('git', ['init', '-q', repo]);
  const out = JSON.parse(run(repo));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(ctx.includes('senior-dev:conductor'));
  assert.ok(!ctx.includes('RESUME'));
});

test('in a repo with an active session: emits resume notice', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-active-'));
  execFileSync('git', ['init', '-q', repo]);
  writeState(repo, {
    version: 1, task: 'half-done widget', type: 'feature',
    startedAt: 'x', chain: CHAINS['feature'], phases: { brainstorm: { status: 'done' } },
    reviews: [], docsGate: { ...DOCS_GATE['feature'] }, degradations: [], bypasses: [],
    stopGate: { lastSnapshotHash: null },
  });
  const ctx = JSON.parse(run(repo)).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('RESUME'));
  assert.ok(ctx.includes('half-done widget'));
  assert.ok(ctx.includes('worktree'));
});

test('malformed stdin: still works from process cwd', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-badstdin-'));
  execFileSync('git', ['init', '-q', repo]);
  const out = execFileSync('node', [SCRIPT], { cwd: repo, encoding: 'utf8', input: 'not-json' });
  assert.ok(out.includes('senior-dev:conductor'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/senior-dev && node --test tests/session-start.test.mjs`
Expected: FAIL — script not found.

- [ ] **Step 3: Write `scripts/session-start.mjs`**

```js
#!/usr/bin/env node
// SessionStart bootstrap: in a git repo, tell the session the conductor
// exists (and whether a session is in flight). Outside a repo: silence.
// Fail open: any error -> exit 0, no output.
import {
  findRepoRoot, readState, hasActiveSession, currentPhase, openGateItems,
} from './lib/state.mjs';

const BOOTSTRAP = `<IMPORTANT>
This repo is under senior-dev orchestration.
Before starting ANY coding task (feature, bug fix, refactor, quick fix, docs change), you MUST invoke the 'senior-dev:conductor' skill. It classifies the task, selects the mandatory skill chain from the installed skills, and records phase state. Commit/integration and session-stop gates are armed while a session is active.
Commands: /senior-dev:start [task] | /senior-dev:status | /senior-dev:bypass <reason> | /senior-dev:finish
</IMPORTANT>`;

async function readStdin() {
  let data = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
  } catch {}
  return data;
}

try {
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(await readStdin());
    if (parsed && typeof parsed.cwd === 'string') cwd = parsed.cwd;
  } catch {}

  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) process.exit(0);

  let ctx = BOOTSTRAP;
  const state = readState(repoRoot);
  if (hasActiveSession(state)) {
    const open = openGateItems(state);
    ctx += `\n\n<IMPORTANT>RESUME: a senior-dev session is in flight in this repo.
task: [${state.type}] ${state.task}
current phase: ${currentPhase(state) || '(all phases done)'}
open gate items: ${open.length ? open.join(', ') : 'none'}
Run /senior-dev:status for detail, then invoke 'senior-dev:conductor' to resume where it left off. Do not restart completed phases.</IMPORTANT>`;
  }

  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
  }));
} catch {}
process.exit(0);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/code/senior-dev && node --test tests/session-start.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/session-start.mjs tests/session-start.test.mjs
git commit -m "feat: SessionStart bootstrap - conductor announcement + resume notice"
```

---

### Task 5: Commit/integration gate (`scripts/commit-gate.mjs`)

**Files:**
- Create: `scripts/commit-gate.mjs`
- Test: `tests/commit-gate.test.mjs`

**Interfaces:**
- Consumes: `findRepoRoot`, `readState`, `hasActiveSession`, `currentPhase`, `integrationBlockers`, `consumeBypass` from `scripts/lib/state.mjs`.
- Produces: a PreToolUse hook. stdin: Claude Code hook JSON (`tool_name`, `tool_input.command`, `cwd`). Behaviour:
  - exit 0 (allow) for non-Bash tools, non-git commands, no active session, or any internal error;
  - exit 2 + stderr message (block) per the decision table below.

Decision table (test each row):

| Command matches | Session state | Result |
|---|---|---|
| anything | no active session | allow |
| `git commit` | current phase not `implement`/`debug` | allow (spec/plan/docs commits are free) |
| `git commit` | phase `implement`/`debug`, no `testsGreenAt` | **block**: record green tests first |
| `git commit` | phase `implement`/`debug`, `testsGreenAt` set | allow |
| `git merge` / `git push` / `gh pr create` | `integrationBlockers()` non-empty | **block**, list blockers |
| `git merge` / `git push` / `gh pr create` | no blockers | allow |
| any gated action | `bypassArmed` set | allow once, consume + log bypass |
| corrupt state / script error | — | allow (fail open) |

- [ ] **Step 1: Write the failing tests**

Create `tests/commit-gate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeState, readState, CHAINS, DOCS_GATE } from '../scripts/lib/state.mjs';

const SCRIPT = new URL('../scripts/commit-gate.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-cg-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function gate(repo, command, toolName = 'Bash') {
  try {
    execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: repo }),
    });
    return { blocked: false, msg: '' };
  } catch (e) {
    return { blocked: e.status === 2, msg: e.stderr || '' };
  }
}

function featureState(overrides = {}) {
  return {
    version: 1, task: 't', type: 'feature', startedAt: 'x',
    chain: CHAINS['feature'], phases: {}, reviews: [],
    docsGate: { ...DOCS_GATE['feature'] }, degradations: [], bypasses: [],
    scratchFiles: [], stopGate: { lastSnapshotHash: null }, ...overrides,
  };
}

test('no active session: everything allowed', () => {
  const repo = makeRepo();
  assert.equal(gate(repo, 'git commit -m x').blocked, false);
  assert.equal(gate(repo, 'git push').blocked, false);
});

test('non-git and non-Bash calls always allowed', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  assert.equal(gate(repo, 'ls -la').blocked, false);
  assert.equal(gate(repo, 'git commit -m x', 'Grep').blocked, false);
});

test('commit free outside implement/debug phases', () => {
  const repo = makeRepo();
  writeState(repo, featureState()); // current phase = brainstorm
  assert.equal(gate(repo, 'git commit -m "docs: spec"').blocked, false);
});

test('commit blocked during implement without green tests, allowed with', () => {
  const repo = makeRepo();
  const phases = { brainstorm: { status: 'done' }, worktree: { status: 'done' }, plan: { status: 'done' } };
  writeState(repo, featureState({ phases: { ...phases, implement: { status: 'in_progress' } } }));
  const r = gate(repo, 'git commit -m wip');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests-green'));
  writeState(repo, featureState({
    phases: { ...phases, implement: { status: 'in_progress', testsGreenAt: 'now' } },
  }));
  assert.equal(gate(repo, 'git commit -m ok').blocked, false);
});

test('integration blocked with blockers, allowed when clear', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  for (const cmd of ['git push origin main', 'git merge feat', 'gh pr create --fill']) {
    const r = gate(repo, cmd);
    assert.equal(r.blocked, true, cmd);
    assert.ok(r.msg.includes('/senior-dev:status'), cmd);
  }
  writeState(repo, featureState({
    reviews: [{ phase: 'implement', reviewer: 'codex', verdict: 'APPROVED', cycle: 1 }],
    phases: { verify: { status: 'done' } },
    docsGate: { spec: true, plan: true, handover: true, affectedDocs: true },
  }));
  assert.equal(gate(repo, 'git push origin main').blocked, false);
});

test('armed bypass allows one gated action and is consumed', () => {
  const repo = makeRepo();
  writeState(repo, featureState({ bypassArmed: { reason: 'hotfix', at: 'x' } }));
  assert.equal(gate(repo, 'git push').blocked, false);
  const s = readState(repo);
  assert.equal(s.bypassArmed, undefined);
  assert.equal(s.bypasses[0].reason, 'hotfix');
  assert.equal(gate(repo, 'git push').blocked, true); // consumed - blocks again
});

test('corrupt stdin: fail open', () => {
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8', input: '{{{' });
    assert.ok(true);
  } catch {
    assert.fail('should not exit non-zero on corrupt stdin');
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/senior-dev && node --test tests/commit-gate.test.mjs`
Expected: FAIL — script not found.

- [ ] **Step 3: Write `scripts/commit-gate.mjs`**

```js
#!/usr/bin/env node
// PreToolUse(Bash) gate. Worktree commits need green tests during
// implement/debug; integration (merge/push/PR) needs approved reviews,
// verification, and a full docs gate. Fail open on any error.
import {
  findRepoRoot, readState, hasActiveSession, currentPhase,
  integrationBlockers, consumeBypass,
} from './lib/state.mjs';

const INTEGRATION = /\bgit\s+(merge|push)\b|\bgh\s+pr\s+create\b/;
const COMMIT = /\bgit\s+commit\b/;
const TEST_GATED_PHASES = new Set(['implement', 'debug']);

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function block(msg) {
  console.error(`senior-dev gate: ${msg}\nSee /senior-dev:status for detail, or /senior-dev:bypass <reason> to waive (logged).`);
  process.exit(2);
}

try {
  const data = JSON.parse(await readStdin());
  if (data.tool_name !== 'Bash') process.exit(0);
  const command = data.tool_input?.command || '';
  const isIntegration = INTEGRATION.test(command);
  const isCommit = !isIntegration && COMMIT.test(command);
  if (!isIntegration && !isCommit) process.exit(0);

  const repoRoot = findRepoRoot(data.cwd || process.cwd());
  if (!repoRoot) process.exit(0);
  const state = readState(repoRoot);
  if (!hasActiveSession(state)) process.exit(0);

  if (consumeBypass(repoRoot, state, command.slice(0, 120))) process.exit(0);

  if (isIntegration) {
    const blockers = integrationBlockers(state);
    if (blockers.length) {
      block(`integration blocked (${blockers.length} item${blockers.length > 1 ? 's' : ''}):\n- ${blockers.join('\n- ')}`);
    }
    process.exit(0);
  }

  // isCommit
  const cur = currentPhase(state);
  if (cur && TEST_GATED_PHASES.has(cur) && !state.phases?.[cur]?.testsGreenAt) {
    block(`commit blocked: phase '${cur}' has no green test run recorded. Run the tests, then: node "$CLAUDE_PLUGIN_ROOT/scripts/state-cli.mjs" tests-green (conductor skill shows the exact call).`);
  }
  process.exit(0);
} catch {
  process.exit(0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/code/senior-dev && node --test tests/commit-gate.test.mjs`
Expected: all PASS. Full suite too: `node --test tests/`.

- [ ] **Step 5: Commit**

```bash
git add scripts/commit-gate.mjs tests/commit-gate.test.mjs
git commit -m "feat: commit/integration gate - green-tests rule + integration blockers + one-shot bypass"
```

---

### Task 6: Stop gate (`scripts/stop-gate.mjs`)

**Files:**
- Create: `scripts/stop-gate.mjs`
- Test: `tests/stop-gate.test.mjs`

**Interfaces:**
- Consumes: `findRepoRoot`, `readState`, `writeState`, `hasActiveSession`, `currentPhase`, `openGateItems`, `snapshotHash` from `scripts/lib/state.mjs`.
- Produces: a Stop hook. stdin: hook JSON (`stop_hook_active`, `transcript_path`, `cwd`). Blocks (exit 2 + checklist on stderr) only when ALL of: active session, open gate items, (current phase is `finish` OR last assistant message claims completion), snapshot differs from last blocked snapshot, and `stop_hook_active` is false. Everything else: exit 0.

Three loop-protection layers: `stop_hook_active` short-circuit, snapshot-hash once-per-state block, and the completion-claim heuristic (regex: `/\b(done|complete|completed|finished|shipped|ready to merge|all set|task is finished)\b/i` — known to overfire on words like "one item done"; acceptable because the other two layers bound it. Note this in a code comment).

- [ ] **Step 1: Write the failing tests**

Create `tests/stop-gate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeState, readState, CHAINS, DOCS_GATE } from '../scripts/lib/state.mjs';

const SCRIPT = new URL('../scripts/stop-gate.mjs', import.meta.url).pathname;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-sg-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

function transcript(dir, lastAssistantText) {
  const p = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: lastAssistantText }] } }),
  ];
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function gate(repo, { stopActive = false, lastText = 'All done, the feature is complete.' } = {}) {
  try {
    execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      input: JSON.stringify({
        stop_hook_active: stopActive,
        transcript_path: transcript(repo, lastText),
        cwd: repo,
      }),
    });
    return { blocked: false, msg: '' };
  } catch (e) {
    return { blocked: e.status === 2, msg: e.stderr || '' };
  }
}

function openState(overrides = {}) {
  return {
    version: 1, task: 't', type: 'quick-fix', startedAt: 'x',
    chain: CHAINS['quick-fix'], phases: {}, reviews: [],
    docsGate: { ...DOCS_GATE['quick-fix'] }, degradations: [], bypasses: [],
    scratchFiles: [], stopGate: { lastSnapshotHash: null }, ...overrides,
  };
}

test('no active session: allow', () => {
  const repo = makeRepo();
  assert.equal(gate(repo).blocked, false);
});

test('stop_hook_active: allow (loop protection)', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  assert.equal(gate(repo, { stopActive: true }).blocked, false);
});

test('open items + completion claim: block with checklist', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  const r = gate(repo);
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('phase:implement'));
});

test('open items but no completion claim and not finishing: allow', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  assert.equal(gate(repo, { lastText: 'I will continue tomorrow with the next phase.' }).blocked, false);
});

test('finish phase in progress: blocks even without claim wording', () => {
  const repo = makeRepo();
  writeState(repo, openState({
    phases: { implement: { status: 'done' }, review: { status: 'done' }, verify: { status: 'done' }, docs: { status: 'done' } },
  })); // current phase = finish, docsGate still open
  const r = gate(repo, { lastText: 'Wrapping up.' });
  assert.equal(r.blocked, true);
});

test('identical snapshot: second stop allowed (no ping-pong)', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  assert.equal(gate(repo).blocked, true);
  assert.equal(gate(repo).blocked, false); // same open items -> let through
});

test('changed snapshot: blocks again', () => {
  const repo = makeRepo();
  writeState(repo, openState());
  assert.equal(gate(repo).blocked, true);
  const s = readState(repo);
  s.phases.implement = { status: 'done' }; // items change
  writeState(repo, s);
  assert.equal(gate(repo).blocked, true);
});

test('corrupt stdin: fail open', () => {
  try {
    execFileSync('node', [SCRIPT], { encoding: 'utf8', input: 'garbage' });
    assert.ok(true);
  } catch {
    assert.fail('should not exit non-zero on corrupt stdin');
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/code/senior-dev && node --test tests/stop-gate.test.mjs`
Expected: FAIL — script not found.

- [ ] **Step 3: Write `scripts/stop-gate.mjs`**

```js
#!/usr/bin/env node
// Stop gate: refuse to let a session that claims completion stop while gate
// items are open. Three loop protections: stop_hook_active short-circuit,
// once-per-snapshot blocking, and a claim heuristic. Fail open on any error.
import { readFileSync } from 'node:fs';
import {
  findRepoRoot, readState, writeState, hasActiveSession, currentPhase,
  openGateItems, snapshotHash,
} from './lib/state.mjs';

// Deliberately loose - overfires on phrases like "one item done"; bounded by
// the snapshot hash (one block per distinct state) and stop_hook_active.
const CLAIMS = /\b(done|complete|completed|finished|shipped|ready to merge|all set|task is finished)\b/i;

function lastAssistantText(transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      }
      if (typeof content === 'string') return content;
    }
  } catch {}
  return '';
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const data = JSON.parse(await readStdin());
  if (data.stop_hook_active) process.exit(0);

  const repoRoot = findRepoRoot(data.cwd || process.cwd());
  if (!repoRoot) process.exit(0);
  const state = readState(repoRoot);
  if (!hasActiveSession(state)) process.exit(0);

  const items = openGateItems(state);
  if (!items.length) process.exit(0);

  const finishing = currentPhase(state) === 'finish';
  const claims = CLAIMS.test(lastAssistantText(data.transcript_path));
  if (!finishing && !claims) process.exit(0);

  const hash = snapshotHash(items);
  if (state.stopGate?.lastSnapshotHash === hash) process.exit(0); // already challenged this exact state

  state.stopGate = { lastSnapshotHash: hash };
  writeState(repoRoot, state);
  console.error(`senior-dev stop gate: the session is not finished. Open gate items:\n- ${items.join('\n- ')}\nResolve them (conductor skill shows how), run /senior-dev:finish, or /senior-dev:bypass <reason>.`);
  process.exit(2);
} catch {
  process.exit(0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/code/senior-dev && node --test tests/stop-gate.test.mjs`
Expected: all PASS. Full suite: `node --test tests/` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/stop-gate.mjs tests/stop-gate.test.mjs
git commit -m "feat: stop gate - once-per-snapshot completion challenge with triple loop protection"
```

---

### Task 7: Conductor skill (`skills/conductor/SKILL.md`)

**Files:**
- Create: `skills/conductor/SKILL.md`

**Interfaces:**
- Consumes: the state CLI (`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" ...`) with Task 3's exact subcommands; installed skills referenced by canonical name.
- Produces: the skill `senior-dev:conductor` that the SessionStart bootstrap and `/senior-dev:start` both point at.

- [ ] **Step 1: Write the skill file**

Create `skills/conductor/SKILL.md` with exactly this content:

````markdown
---
name: conductor
description: Use at the start of ANY coding task in a git repo (feature, bug fix, refactor, quick fix, docs change, investigation) and when resuming a senior-dev session. Classifies the task, routes it through the mandatory installed-skill chain (superpowers brainstorming/worktrees/plans/TDD/systematic-debugging, built-in code-review and verify, read-only Codex phase reviews), records every phase in .senior-dev/state.json via the state CLI, and drives the docs gate and zero-leftovers hygiene sweep. Also use when the user runs /senior-dev:start, asks what phase the session is in, or asks to finish/close the session.
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

1. If `/senior-dev:status` shows an active session: resume at the current
   phase. Do not restart completed phases.
2. Otherwise classify the task as exactly one of:

| Type | When |
|---|---|
| `feature` | New behaviour or capability |
| `bug-fix` | Existing behaviour is wrong |
| `refactor` | Behaviour preserved, structure improved |
| `quick-fix` | ≤3 files, ≤~30 min, obvious change |
| `docs-only` | Prose/docs only, no code |
| `investigation` | Read-only question answering |

If genuinely ambiguous, ask the operator ONE multiple-choice question.

3. Initialise: `state-cli init --task "<one-line task>" --type <type>`

**Escalation rule:** a `quick-fix` that grows past 3 files or ~30 minutes is
no longer a quick fix. Say so, `state-cli finish` the mini-session, and
re-init at the true type.

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
6. `verify`: run the built-in `verify` skill, then
   `superpowers:verification-before-completion`. Record: `state-cli phase verify --status done`.
7. `docs`: see §4.
8. `finish`: see §5.

**bug-fix** — `debug → implement → review → verify → docs → finish`
`debug` MUST be `superpowers:systematic-debugging` — no fixes before a root
cause. `implement` starts with a failing test reproducing the bug (TDD).

**refactor** — `worktree → plan → implement → review → verify → docs → finish`
Record a green baseline (`state-cli tests-green`) BEFORE changing anything.

**quick-fix** — `implement → review → verify → docs → finish`
No spec/plan. Review is `/code-review` at low effort plus ONE Codex pass.

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
   on the phase diff. Fix findings via `superpowers:systematic-debugging` +
   TDD, never by patching blind.
2. Codex pass (READ-ONLY — `/codex:review` or `/codex:adversarial-review`;
   NEVER any write-capable lane):
   - Capture `git status --porcelain` and `git log -1 --format=%H` BEFORE.
   - Ask Codex to review the phase diff and reply with ONLY:
     `{"verdict":"APPROVED"|"NEEDS_REVISION","concerns":[],"missedCases":[],"suggestions":[]}`
   - Re-run the two git commands AFTER. Any difference = Codex wrote to the
     repo: stop everything and tell the operator immediately.
   - Record: `state-cli review --phase <phase> --reviewer codex --verdict <V> --cycle <n>`
3. `NEEDS_REVISION` → address concerns → re-review at cycle n+1.
   **Cycle cap is 3** (the CLI enforces it). At the cap: stop iterating,
   present both positions to the operator, let them decide.

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

1. Codex final pass over the complete branch diff (same contract as §3).
2. `superpowers:finishing-a-development-branch` (merge/PR/discard menu).
3. Hygiene sweep: `state-cli sweep` — then FIX anything it shows: stray
   worktrees, leftover branches, dirty status, surviving scratch files
   (track them during the session with `state-cli scratch --add <path>`).
   Where a remote exists, verify the pushed end, not just local state.
4. `state-cli finish` — archives state to `.senior-dev/history/`.
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
| "I'll bypass just this once, quietly" | Bypass exists, but it is LOGGED and needs a reason. |
````

- [ ] **Step 2: Verify the description length is ≤ 1024 characters**

Run: `cd ~/code/senior-dev && node -e "const m=require('fs').readFileSync('skills/conductor/SKILL.md','utf8').match(/description: (.*)/); console.log(m[1].length)"`
Expected: a number ≤ 1024. If over, trim the description and re-check.

- [ ] **Step 3: Commit**

```bash
git add skills/conductor/SKILL.md
git commit -m "feat: conductor skill - lanes, chains, review contract, docs gate, finish protocol"
```

---

### Task 8: Commands (start, status, bypass, finish)

**Files:**
- Create: `commands/start.md`
- Create: `commands/status.md`
- Create: `commands/bypass.md`
- Create: `commands/finish.md`

**Interfaces:**
- Consumes: the conductor skill (Task 7) and state CLI (Task 3).
- Produces: `/senior-dev:start`, `/senior-dev:status`, `/senior-dev:bypass`, `/senior-dev:finish`.

- [ ] **Step 1: Write `commands/start.md`**

```markdown
---
description: Start (or resume) an orchestrated senior-dev session for a task
argument-hint: '[task description]'
---

Invoke the `senior-dev:conductor` skill now and follow it exactly.

Task from the operator: $ARGUMENTS

If no task was given, ask the operator what the task is (one question), then
proceed through the conductor's Engage steps: resume if a session is active,
otherwise classify and `init`.
```

- [ ] **Step 2: Write `commands/status.md`**

```markdown
---
description: Show the senior-dev session state - phases, gates, reviews, degradations, bypasses
disable-model-invocation: false
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" status`

Present the command output above to the operator verbatim in a code block.
If it shows open gate items, add one sentence on what the next action is.
Do not editorialize beyond that.
```

- [ ] **Step 3: Write `commands/bypass.md`**

```markdown
---
description: Waive the next senior-dev gate action (one-shot, reason required, logged)
argument-hint: '<reason>'
allowed-tools: Bash(node:*)
---

The operator wants to bypass a senior-dev gate. Their reason: $ARGUMENTS

If the reason is empty, ask for one - a bypass without a reason is refused.

Run:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state-cli.mjs" bypass --reason-stdin <<'SENIOR_DEV_EOF'
$ARGUMENTS
SENIOR_DEV_EOF
```
(`--reason "$ARGUMENTS"` was the original form; it silently truncates reasons containing double quotes because $ARGUMENTS is textual template substitution — the quoted-heredoc stdin form records the reason verbatim. state-cli's `bypass` accepts `--reason <value>` for direct callers or the value-less `--reason-stdin` reading the reason from stdin.)

Confirm to the operator: the NEXT gated action (commit/merge/push/PR) will be
allowed through, the bypass is logged in session state, and it will appear in
the finish summary.
```

- [ ] **Step 4: Write `commands/finish.md`**

```markdown
---
description: Close the senior-dev session - final Codex pass, docs gate, hygiene sweep, archive
---

Invoke the `senior-dev:conductor` skill and execute its Finish protocol (§5)
now: final read-only Codex pass on the branch diff, finishing-a-development-
branch, `state-cli sweep` with every finding fixed, `state-cli finish`, and
an evidence-backed summary. Do not skip steps; do not summarize evidence -
paste it.
```

- [ ] **Step 5: Verify command frontmatter parses (spot check)**

Run: `cd ~/code/senior-dev && head -6 commands/*.md`
Expected: each file shows a `---` fenced frontmatter block with a `description:` line.

- [ ] **Step 6: Commit**

```bash
git add commands
git commit -m "feat: commands - start, status, bypass, finish"
```

---

### Task 9: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything built so far (documents it).
- Produces: install/usage doc.

- [ ] **Step 1: Write `README.md`**

```markdown
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
  verification, and a complete docs gate.
- **Stop gate** - a session claiming "done" with open gate items gets the
  checklist back, once per distinct state (never loops).
- **Codex phase reviews** - read-only `/codex:review` verdicts per phase,
  JSON contract, 3-cycle cap, post-review write-detection guard.
- **Docs gate** - spec, plan, handover, affected docs.
- **Hygiene sweep** - evidence-based zero-leftovers close.

All hooks fail open: a broken hook never blocks normal work. Gates arm only
while a session is active. `/senior-dev:bypass <reason>` is the logged escape
hatch.

## Install

```bash
claude plugin marketplace add ~/code/senior-dev
claude plugin install senior-dev@senior-dev-local
# restart Claude Code to load hooks
```

Update flow: edit source, bump both versions in `.claude-plugin/`, then
`claude plugin marketplace update senior-dev-local` and
`claude plugin update senior-dev@senior-dev-local`, restart.

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
node --test tests/
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README - install, commands, state, companions"
```

---

### Task 10: Static validation pass

**Files:**
- Modify: whatever the validators flag (expect small fixes in `skills/conductor/SKILL.md`, `.claude-plugin/*.json`, `commands/*.md`).

**Interfaces:**
- Consumes: the whole plugin.
- Produces: a plugin that passes `plugin-dev:plugin-validator` and a conductor skill that passes `plugin-dev:skill-reviewer`.

- [ ] **Step 1: Run the full test suite as a baseline**

Run: `cd ~/code/senior-dev && node --test tests/`
Expected: all PASS.

- [ ] **Step 2: Dispatch the plugin validator**

Use the Agent tool with `subagent_type: "plugin-dev:plugin-validator"` and prompt: "Validate the Claude Code plugin at ~/code/nzshrimper-senior-dev - manifest, marketplace.json, hooks/hooks.json, commands frontmatter, skill frontmatter. Report every issue with file and line."

- [ ] **Step 3: Dispatch the skill reviewer**

Use the Agent tool with `subagent_type: "plugin-dev:skill-reviewer"` and prompt: "Review the skill at ~/code/nzshrimper-senior-dev/skills/conductor/SKILL.md for description quality (triggering), structure, and best practices. Report concrete improvements."

- [ ] **Step 4: Fix every finding from both agents**

Apply fixes; re-run `node --test tests/` to confirm nothing broke.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: address plugin-validator and skill-reviewer findings"
```

---

### Task 11: Install + live smoke test

**Files:**
- Create: `tests/SMOKE.md` (checklist with expected outputs, kept for future releases)

**Interfaces:**
- Consumes: the installed plugin end-to-end.
- Produces: verified working plugin; known-good smoke checklist.

- [ ] **Step 1: Write `tests/SMOKE.md`**

```markdown
# senior-dev smoke checklist

Run after every install/update, in a THROWAWAY repo (scratchpad), with the
plugin installed and Claude Code restarted.

Setup: `mkdir -p <scratch>/sd-smoke && cd <scratch>/sd-smoke && git init && git commit --allow-empty -m init`

1. [ ] New Claude session in the throwaway repo -> bootstrap context mentions
       senior-dev:conductor. In a non-git dir -> no mention.
2. [ ] /senior-dev:status -> "no active session".
3. [ ] /senior-dev:start add a hello script (quick-fix lane expected) ->
       state file created, .git/info/exclude contains .senior-dev/.
4. [ ] During implement with no tests-green: `git commit` -> BLOCKED with
       tests-green message. After state-cli tests-green -> commit passes.
5. [ ] `git push` before review/verify/docs -> BLOCKED listing blockers.
6. [ ] Claim "all done" with open items -> stop gate returns checklist once;
       identical second stop -> allowed through.
7. [ ] /senior-dev:bypass testing the escape hatch -> next push allowed,
       bypass visible in /senior-dev:status.
8. [ ] Codex absent/unauthed simulation (or real /codex:review) -> verdict
       recorded via state-cli review; cycle 4 refused by CLI.
9. [ ] /senior-dev:finish -> sweep evidence printed, state archived to
       .senior-dev/history/, /senior-dev:status -> "no active session".
10. [ ] Delete throwaway repo. Zero leftovers on the machine.
```

- [ ] **Step 2: Install the plugin**

```bash
claude plugin marketplace add ~/code/senior-dev
claude plugin install senior-dev@senior-dev-local
```

Expected: both commands succeed. **Operator step: restart Claude Code.**

- [ ] **Step 3: Execute the smoke checklist**

Work through `tests/SMOKE.md` items 1-10 in a fresh session, ticking each with observed output. Any failure: fix, bump nothing (still 0.1.0 pre-release), re-run the failed item.

- [ ] **Step 4: Commit and tag**

```bash
git add tests/SMOKE.md
git commit -m "test: smoke checklist"
git tag v0.1.0
```

---

## Self-Review (completed at write time)

**Spec coverage:** §5 bootstrap → Task 4; §6 conductor/lanes/insist/record → Tasks 3+7; §7 state file → Tasks 2-3; §8 Codex gate (contract, cap, write-guard) → Task 7 §3 + CLI cycle cap in Task 3; §9 docs gate → Tasks 2 (DOCS_GATE), 3 (`docs`), 7 (§4); §10.1 commit gate → Task 5; §10.2 stop gate → Task 6; §11 commands → Task 8; §12 sweep → Tasks 3 (`sweep`) + 7 (§5); §14 failure modes → fail-open in every script + degrade/bypass paths; §15 testing → Tasks 2-6 unit, 10 static, 11 smoke. Gap check: `worktree` field in state is written by conductor prose only (acceptable — informational). Escalation rule covered in Task 7 §1.

**Placeholder scan:** clean — every step has full code/content; the one intentional note (ESM `require` fix in Task 3 Step 1) instructs the exact replacement.

**Type consistency:** `state-cli` subcommand names match between Task 3 code, Task 7 skill prose, and Task 8 commands (`init/phase/tests-green/review/docs/degrade/bypass/scratch/status/sweep/finish`). `CHAINS`/`DOCS_GATE` keys match lane names everywhere. Verdict strings `APPROVED|NEEDS_REVISION` consistent across CLI, gates, skill, tests.
