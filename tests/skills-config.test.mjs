import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  VALID_SOURCES, skillsConfigPath, readSkillsConfig, writeSkillsConfig,
  ensureExcluded,
} from '../scripts/lib/state.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sd-skills-'));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
function excludeContent(repo) {
  try { return readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'); }
  catch { return ''; }
}

test('VALID_SOURCES is the four sources', () => {
  assert.deepEqual(VALID_SOURCES, ['own', 'superpowers', 'combo', 'suggest']);
});

test('read/write skills config roundtrip', () => {
  const repo = makeRepo();
  const cfg = { version: 1, source: 'combo', shared: false, steps: { plan: 'my-org:planner' } };
  writeSkillsConfig(repo, cfg);
  assert.deepEqual(readSkillsConfig(repo), cfg);
});

test('readSkillsConfig returns null for missing, corrupt, wrong-version, bad-source', () => {
  const repo = makeRepo();
  assert.equal(readSkillsConfig(repo), null);
  mkdirSync(join(repo, '.senior-dev'), { recursive: true });
  writeFileSync(skillsConfigPath(repo), 'not json{{');
  assert.equal(readSkillsConfig(repo), null);
  writeFileSync(skillsConfigPath(repo), JSON.stringify({ version: 99, source: 'own' }));
  assert.equal(readSkillsConfig(repo), null);
  writeFileSync(skillsConfigPath(repo), JSON.stringify({ version: 1, source: 'nonsense' }));
  assert.equal(readSkillsConfig(repo), null);
});

test('ensureExcluded (default/no config) hides state, history, and skills.json', () => {
  const repo = makeRepo();
  ensureExcluded(repo);
  const c = excludeContent(repo);
  assert.ok(c.split('\n').includes('.senior-dev/state.json'));
  assert.ok(c.split('\n').includes('.senior-dev/history/'));
  assert.ok(c.split('\n').includes('.senior-dev/skills.json'));
});

test('ensureExcluded with shared config leaves skills.json trackable', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 1, source: 'own', shared: true });
  ensureExcluded(repo);
  const lines = excludeContent(repo).split('\n');
  assert.ok(lines.includes('.senior-dev/state.json'));
  assert.ok(lines.includes('.senior-dev/history/'));
  assert.ok(!lines.includes('.senior-dev/skills.json'));
});

test('ensureExcluded migrates a legacy wholesale line and is idempotent', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.senior-dev/\n');
  ensureExcluded(repo);
  ensureExcluded(repo);
  const lines = excludeContent(repo).split('\n');
  assert.ok(!lines.includes('.senior-dev/'));
  assert.equal(lines.filter((l) => l === '.senior-dev/state.json').length, 1);
});

test('ensureExcluded flips skills.json line when share flag changes', () => {
  const repo = makeRepo();
  writeSkillsConfig(repo, { version: 1, source: 'own', shared: false });
  ensureExcluded(repo);
  assert.ok(excludeContent(repo).split('\n').includes('.senior-dev/skills.json'));
  writeSkillsConfig(repo, { version: 1, source: 'own', shared: true });
  ensureExcluded(repo);
  assert.ok(!excludeContent(repo).split('\n').includes('.senior-dev/skills.json'));
});
