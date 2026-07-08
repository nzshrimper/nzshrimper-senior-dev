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
