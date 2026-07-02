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

test('bypass --reason-stdin records a reason containing double quotes verbatim', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const reason = 'he said " I dunno " do it anyway';
  const r = cli(repo, ['bypass', '--reason-stdin'], { input: reason });
  assert.equal(r.status, 0);
  assert.equal(readState(repo).bypassArmed.reason, reason);
});

test('bypass --reason-stdin records a multi-word reason with a leading -- prefix verbatim', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const reason = '--force just ship it, ignore the warning';
  const r = cli(repo, ['bypass', '--reason-stdin'], { input: reason });
  assert.equal(r.status, 0);
  assert.equal(readState(repo).bypassArmed.reason, reason);
});

test('bypass --reason-stdin trims surrounding whitespace but rejects empty/whitespace-only stdin', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const padded = cli(repo, ['bypass', '--reason-stdin'], { input: '  reason with padding  \n' });
  assert.equal(padded.status, 0);
  assert.equal(readState(repo).bypassArmed.reason, 'reason with padding');

  const empty = cli(repo, ['bypass', '--reason-stdin'], { input: '   \n  ' });
  assert.equal(empty.status, 1);
});

test('plain --reason still works when --reason-stdin is not given', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['bypass', '--reason', 'direct caller reason']);
  assert.equal(r.status, 0);
  assert.equal(readState(repo).bypassArmed.reason, 'direct caller reason');
});

test('bypass with neither --reason nor --reason-stdin exits 1', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['bypass']);
  assert.equal(r.status, 1);
});

test('bypass rejects --reason and --reason-stdin given together', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['bypass', '--reason', 'x', '--reason-stdin'], { input: 'y' });
  assert.equal(r.status, 1);
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

test('finish archives and clears active state when all gates are clear', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'Fix the thing!', '--type', 'quick-fix']);
  cli(repo, ['phase', 'implement', '--status', 'done']);
  cli(repo, ['phase', 'review', '--status', 'done']);
  cli(repo, ['phase', 'verify', '--status', 'done']);
  cli(repo, ['docs', '--handover', 'true', '--affectedDocs', 'true']);
  cli(repo, ['phase', 'docs', '--status', 'done']);
  const r = cli(repo, ['finish']);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(statePath(repo)));
  const hist = readdirSync(join(repo, '.senior-dev', 'history'));
  assert.equal(hist.length, 1);
  assert.ok(hist[0].endsWith('.json'));
});

test('finish refuses when gate items are open, listing them, and leaves state intact', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['finish']);
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('phase:implement'));
  assert.ok(existsSync(statePath(repo)));
  assert.equal(readdirSync(join(repo, '.senior-dev')).includes('history'), false);
});

test('finish --force-open with a reason archives despite open items and logs the bypass in the archived file', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['finish', '--force-open', 'operator says ship it']);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(statePath(repo)));
  const hist = readdirSync(join(repo, '.senior-dev', 'history'));
  assert.equal(hist.length, 1);
  const archived = JSON.parse(readFileSync(join(repo, '.senior-dev', 'history', hist[0]), 'utf8'));
  const bypass = archived.bypasses.find((b) => b.action === 'finish --force-open');
  assert.ok(bypass, 'expected a finish --force-open bypass entry in the archived state');
  assert.equal(bypass.reason, 'operator says ship it');
  assert.ok(Array.isArray(bypass.openItems) && bypass.openItems.length > 0);
  assert.ok(bypass.openItems.includes('phase:implement'));
  assert.ok(bypass.at);
});

test('finish --force-open without a value exits 1 and leaves state intact', () => {
  const repo = makeRepo();
  cli(repo, ['init', '--task', 'x', '--type', 'quick-fix']);
  const r = cli(repo, ['finish', '--force-open']);
  assert.equal(r.status, 1);
  assert.ok(existsSync(statePath(repo)));
});
