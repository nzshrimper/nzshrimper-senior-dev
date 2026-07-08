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

test('no token when guard not installed, or on a block with no bypass armed', () => {
  const repo = makeRepo();
  writeState(repo, clearState());
  gate(repo, 'git push origin main');                       // guard absent
  assert.ok(!existsSync(tokenPath(repo)));
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo });
  writeState(repo, clearState({ docsGate: { handover: false, affectedDocs: true } }));
  assert.equal(gate(repo, 'git push origin main').blocked, true);  // blocked, no bypass
  assert.ok(!existsSync(tokenPath(repo)));
});

test('allowed plain commit with guard installed writes a commit-type token', () => {
  const repo = makeRepo();
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo });
  writeState(repo, clearState());
  assert.equal(gate(repo, 'git commit -m x').blocked, false);
  const tok = JSON.parse(readFileSync(tokenPath(repo), 'utf8'));
  assert.equal(tok.type, 'commit');
  assert.ok(new Date(tok.expiresAt) > new Date());
});

test('bypassed would-block push writes a token and the git hook honours it', () => {
  const repo = makeRepo();
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo });
  writeState(repo, clearState({ docsGate: { handover: false, affectedDocs: true } }));
  execFileSync('node', [CLI, 'bypass', '--reason', 'test'], { cwd: repo });
  assert.equal(gate(repo, 'git push origin main').blocked, false);
  assert.ok(existsSync(tokenPath(repo)));
  const hookP = join(repo, '.git', 'hooks', 'pre-push');
  const run = () => { try { execFileSync(hookP, [], { cwd: repo, encoding: 'utf8' }); return 0; } catch (e) { return e.status; } };
  assert.equal(run(), 0);
  assert.ok(!existsSync(tokenPath(repo)));
  assert.equal(run(), 1);
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

function debugBlockedState(overrides = {}) {
  // implement in_progress, no tests-green -> a plain COMMIT would block.
  return clearState({
    phases: { implement: { status: 'in_progress' } },
    reviews: [],
    ...overrides,
  });
}

test('bypassed would-block commit writes a commit token; the real pre-commit hook honours it once then blocks again', () => {
  const repo = makeRepo();
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo });
  writeState(repo, debugBlockedState());
  execFileSync('node', [CLI, 'bypass', '--reason', 'test'], { cwd: repo });
  assert.equal(gate(repo, 'git commit -m x').blocked, false);
  const tok = JSON.parse(readFileSync(tokenPath(repo), 'utf8'));
  assert.equal(tok.type, 'commit');
  const hookP = join(repo, '.git', 'hooks', 'pre-commit');
  const run = () => { try { execFileSync(hookP, [], { cwd: repo, encoding: 'utf8' }); return 0; } catch (e) { return e.status; } };
  assert.equal(run(), 0);               // token honoured once
  assert.ok(!existsSync(tokenPath(repo)));
  assert.equal(run(), 1);               // token spent, re-evaluated, blocks (no re-arming loop)
});

test('an integration-type token does not satisfy pre-commit', () => {
  const repo = makeRepo();
  execFileSync('node', [CLI, 'guard', 'install'], { cwd: repo });
  writeState(repo, debugBlockedState());
  mkdirSync(join(repo, '.senior-dev', 'guard'), { recursive: true });
  writeFileSync(tokenPath(repo), JSON.stringify({ type: 'integration', commandHash: 'x', expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const hookP = join(repo, '.git', 'hooks', 'pre-commit');
  const run = () => { try { execFileSync(hookP, [], { cwd: repo, encoding: 'utf8' }); return 0; } catch (e) { return e.status; } };
  assert.equal(run(), 1);               // integration token must not satisfy pre-commit
});
