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
