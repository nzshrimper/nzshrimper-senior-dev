import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
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
  assert.ok(readFileSync(exclude, 'utf8').includes('.senior-dev/'));
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

test('flags that require a value reject missing values', () => {
  const repo = makeRepo();
  // --task at end of argv must not become task:"true"
  assert.equal(cli(repo, ['init', '--type', 'feature', '--task']).status, 1);
  assert.equal(readState(repo), null);
  cli(repo, ['init', '--task', 'x', '--type', 'feature']);
  // --wanted followed by another flag must not become wanted:"true"
  assert.equal(cli(repo, ['degrade', '--wanted', '--used', 'x']).status, 1);
  assert.equal(readState(repo).degradations.length, 0);
  // --add at end of argv must not record "true"
  assert.equal(cli(repo, ['scratch', '--add']).status, 1);
  assert.equal(readState(repo).scratchFiles.length, 0);
});

test('review rejects bogus reviewer and non-numeric cycle', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'feature']);
  assert.equal(
    cli(repo, ['review', '--phase', 'implement', '--reviewer', 'bob', '--verdict', 'APPROVED', '--cycle', '1']).status,
    1,
  );
  assert.equal(
    cli(repo, ['review', '--phase', 'implement', '--reviewer', 'codex', '--verdict', 'APPROVED', '--cycle', 'abc']).status,
    1,
  );
  assert.equal(readState(repo).reviews.length, 0);
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
