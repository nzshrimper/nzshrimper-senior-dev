import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeState, readState, CHAINS, DOCS_GATE } from '../scripts/lib/state.mjs';
import { classifyCommand } from '../scripts/commit-gate.mjs';

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

// --- classifyCommand unit tests: command-aware classifier ---

test('classifyCommand: plain git commit/push/merge/subcommands', () => {
  assert.deepEqual(classifyCommand('git commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('git push origin main'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('git merge feat'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('gh pr create --fill'), { commit: false, integration: true });
});

test('classifyCommand: global-flag skipping (-C, -c, --git-dir, --work-tree, -R, --repo)', () => {
  assert.deepEqual(classifyCommand('git -C /tmp/x push origin main'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('git -c user.name=x commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('git --git-dir /tmp/x/.git push'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('git --work-tree /tmp/x commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('git --no-pager commit -m x'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('gh -R o/r pr create'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('gh --repo o/r pr create --fill'), { commit: false, integration: true });
});

test('classifyCommand: quoted text is not classified', () => {
  assert.deepEqual(classifyCommand('echo "remember to git push later"'), { commit: false, integration: false });
  assert.deepEqual(classifyCommand('git commit -m "note: git push later"'), { commit: true, integration: false });
});

test('classifyCommand: commit-graph/commit-tree are not commits', () => {
  assert.deepEqual(classifyCommand('git commit-graph write --reachable'), { commit: false, integration: false });
  assert.deepEqual(classifyCommand('git commit-tree -m x HEAD^{tree}'), { commit: false, integration: false });
});

test('classifyCommand: subtree push is integration, other subtree ops are not', () => {
  assert.deepEqual(classifyCommand('git subtree push --prefix=dist origin gh-pages'), { commit: false, integration: true });
  assert.deepEqual(classifyCommand('git subtree pull --prefix=dist origin gh-pages'), { commit: false, integration: false });
});

test('classifyCommand: segment splitting on shell operators, command can be both', () => {
  assert.deepEqual(classifyCommand('git commit -m prep && git push'), { commit: true, integration: true });
  assert.deepEqual(classifyCommand('git commit -m a; git push'), { commit: true, integration: true });
  assert.deepEqual(classifyCommand('git commit -m a | cat'), { commit: true, integration: false });
  assert.deepEqual(classifyCommand('git commit -m a\ngit push'), { commit: true, integration: true });
});

// --- scenario tests: real bypass holes and false blocks, closed ---

test('git -C <path> push is classified integration and blocked when blockers exist', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  const r = gate(repo, 'git -C /tmp/x push origin main');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('git --no-pager commit is classified commit and blocked during implement without green tests', () => {
  const repo = makeRepo();
  const phases = { brainstorm: { status: 'done' }, worktree: { status: 'done' }, plan: { status: 'done' } };
  writeState(repo, featureState({ phases: { ...phases, implement: { status: 'in_progress' } } }));
  const r = gate(repo, 'git --no-pager commit -m x');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests-green'));
});

test('gh --repo o/r pr create is classified integration and blocked when blockers exist', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  const r = gate(repo, 'gh --repo o/r pr create --fill');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('echo mentioning git push in quotes is not gated', () => {
  const repo = makeRepo();
  writeState(repo, featureState()); // blockers exist, active session
  assert.equal(gate(repo, 'echo "remember to git push later"').blocked, false);
});

test('quoted text inside a real commit does not trigger the integration policy', () => {
  const repo = makeRepo();
  writeState(repo, featureState()); // brainstorm phase - commit is free, but blockers exist for integration
  assert.equal(gate(repo, 'git commit -m "note: git push later"').blocked, false);
});

test('git commit-graph write is not classified as a commit', () => {
  const repo = makeRepo();
  const phases = { brainstorm: { status: 'done' }, worktree: { status: 'done' }, plan: { status: 'done' } };
  writeState(repo, featureState({ phases: { ...phases, implement: { status: 'in_progress' } } }));
  assert.equal(gate(repo, 'git commit-graph write --reachable').blocked, false);
});

test('git subtree push is classified integration and blocked when blockers exist', () => {
  const repo = makeRepo();
  writeState(repo, featureState());
  const r = gate(repo, 'git subtree push --prefix=dist origin gh-pages');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('/senior-dev:status'));
});

test('commit+push chain during implement with no green tests is blocked via the commit rule even when integration blockers are empty', () => {
  const repo = makeRepo();
  writeState(repo, featureState({
    type: 'docs-only',
    chain: CHAINS['docs-only'],
    phases: { implement: { status: 'in_progress' } },
    docsGate: { handover: true },
    reviews: [],
  }));
  // sanity: integration side of this session has no open blockers
  const r = gate(repo, 'git commit -m prep && git push');
  assert.equal(r.blocked, true);
  assert.ok(r.msg.includes('tests-green'), r.msg);
});

test('bypass is consumed only by an action that would otherwise be blocked', () => {
  const repo = makeRepo();
  writeState(repo, featureState({ bypassArmed: { reason: 'hotfix', at: 'x' } })); // brainstorm phase, blockers exist
  // free commit during brainstorm: would not have been blocked -> bypass must not be spent
  assert.equal(gate(repo, 'git commit -m free').blocked, false);
  let s = readState(repo);
  assert.ok(s.bypassArmed, 'bypass should still be armed after an action that was never blocked');
  // now a push that would be blocked: consumes the still-armed bypass
  assert.equal(gate(repo, 'git push').blocked, false);
  s = readState(repo);
  assert.equal(s.bypassArmed, undefined);
  assert.equal(s.bypasses[0].reason, 'hotfix');
  // bypass now spent - next blocked action blocks for real
  assert.equal(gate(repo, 'git push').blocked, true);
});
