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

// Resolves the MAIN checkout root, not the cwd's worktree root: inside a
// linked worktree (`git worktree add`), `git rev-parse --show-toplevel`
// returns the WORKTREE's own root, which has no .senior-dev/state.json -
// that made the CLI and both hard gates go inert from the feature lane's
// standard worktree flow. `--git-common-dir` instead always points at the
// ONE shared .git directory: for the main checkout that's <root>/.git, and
// for every linked worktree it's still <main>/.git, so its dirname is the
// main checkout root in both cases. Falls back to --show-toplevel if
// --path-format is unsupported by the installed git rather than breaking.
export function findRepoRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (out) return dirname(out);
  } catch {
    // fall through to the --show-toplevel fallback below
  }
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

export const VALID_SOURCES = ['own', 'superpowers', 'combo', 'suggest'];

export function skillsConfigPath(repoRoot) {
  return join(repoRoot, '.senior-dev', 'skills.json');
}

export function readSkillsConfig(repoRoot) {
  try {
    const c = JSON.parse(readFileSync(skillsConfigPath(repoRoot), 'utf8'));
    if (typeof c !== 'object' || c === null) return null;
    if (c.version !== 1 && c.version !== 2) return null;
    if (c.source !== undefined && !VALID_SOURCES.includes(c.source)) return null;
    if (c.guard !== undefined && !['installed', 'declined'].includes(c.guard)) return null;
    if (c.lanes !== undefined) {
      if (typeof c.lanes !== 'object' || c.lanes === null || Array.isArray(c.lanes)) return null;
      for (const laneMap of Object.values(c.lanes)) {
        if (typeof laneMap !== 'object' || laneMap === null || Array.isArray(laneMap)) return null;
        for (const v of Object.values(laneMap)) {
          const ok = typeof v === 'string'
            || (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string'));
          if (!ok) return null;
        }
      }
    }
    return c;
  } catch {
    return null;
  }
}

export function normalizeLaneValue(v) {
  return Array.isArray(v) ? v : [v];
}

// Configured resolution only: lanes -> steps -> default. Which of the
// value's entries is actually installed is the conductor's judgement.
export function resolveConfiguredSkill(cfg, laneType, phase) {
  const laneVal = cfg?.lanes?.[laneType]?.[phase];
  if (laneVal !== undefined) return { value: normalizeLaneValue(laneVal), via: 'lane' };
  const stepVal = cfg?.steps?.[phase];
  if (stepVal !== undefined) return { value: normalizeLaneValue(stepVal), via: 'steps' };
  return { value: [], via: 'default' };
}

export function writeSkillsConfig(repoRoot, cfg) {
  const p = skillsConfigPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, p);
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
    let cur = '';
    try { cur = readFileSync(p, 'utf8'); } catch {}
    const shared = readSkillsConfig(repoRoot)?.shared === true;

    // Lines we manage. skills.json is excluded only when NOT shared.
    const want = ['.senior-dev/state.json', '.senior-dev/history/'];
    if (!shared) want.push('.senior-dev/skills.json');

    // Start from existing lines, drop the legacy wholesale line and any of
    // our managed lines, then re-add exactly the set we want. Idempotent, and
    // flips skills.json in/out as `shared` changes.
    const managed = new Set([
      '.senior-dev/', '.senior-dev/state.json',
      '.senior-dev/history/', '.senior-dev/skills.json',
    ]);
    const kept = cur.split('\n').filter((l) => l !== '' && !managed.has(l));
    const out = [...kept, ...want];

    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, out.join('\n') + '\n');
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
