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
  assert.ok(ctx.includes('state-cli.mjs'));
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
  assert.ok(ctx.includes('state-cli.mjs'));
});

test('in a repo with an active session and a waiting state: RESUME block flags it', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-waiting-'));
  execFileSync('git', ['init', '-q', repo]);
  writeState(repo, {
    version: 1, task: 'half-done widget', type: 'feature',
    startedAt: 'x', chain: CHAINS['feature'], phases: { brainstorm: { status: 'done' } },
    reviews: [], docsGate: { ...DOCS_GATE['feature'] }, degradations: [], bypasses: [],
    stopGate: { lastSnapshotHash: null },
    waiting: { on: 'codex review', at: '2026-01-01T00:00:00.000Z' },
  });
  const ctx = JSON.parse(run(repo)).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('WAITING on:'));
  assert.ok(ctx.includes('codex review'));
  assert.ok(ctx.includes('2026-01-01T00:00:00.000Z'));
});

test('active session with a corrupt waiting field: RESUME block still renders, no crash', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-waiting-corrupt-'));
  execFileSync('git', ['init', '-q', repo]);
  writeState(repo, {
    version: 1, task: 'half-done widget', type: 'feature',
    startedAt: 'x', chain: CHAINS['feature'], phases: { brainstorm: { status: 'done' } },
    reviews: [], docsGate: { ...DOCS_GATE['feature'] }, degradations: [], bypasses: [],
    stopGate: { lastSnapshotHash: null },
    waiting: 'not-an-object',
  });
  const ctx = JSON.parse(run(repo)).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('RESUME'));
  assert.ok(!ctx.includes('WAITING on:'));
});

test('malformed stdin: still works from process cwd', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sd-ss-badstdin-'));
  execFileSync('git', ['init', '-q', repo]);
  const out = execFileSync('node', [SCRIPT], { cwd: repo, encoding: 'utf8', input: 'not-json' });
  assert.ok(out.includes('senior-dev:conductor'));
  assert.ok(out.includes('state-cli.mjs'));
});
