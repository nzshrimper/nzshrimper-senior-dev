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
