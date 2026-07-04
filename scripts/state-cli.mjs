#!/usr/bin/env node
// Deterministic state mutations for the senior-dev orchestrator.
// The conductor skill calls this instead of hand-editing JSON.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAINS, DOCS_GATE, findRepoRoot, readState, writeState, statePath,
  hasActiveSession, currentPhase, latestVerdicts, openGateItems, ensureExcluded,
  VALID_SOURCES, readSkillsConfig, writeSkillsConfig,
} from './lib/state.mjs';

function fail(msg) {
  console.error(`senior-dev: ${msg}`);
  process.exit(1);
}

// Reads the entire stdin stream. Only ever invoked from the `bypass`
// subcommand when `--reason-stdin` is explicitly given, so every other
// subcommand invocation never touches stdin and can never hang on it.
async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        // Value-less flag: distinct boolean sentinel, never the string 'true'.
        flags[key] = true;
      }
    }
  }
  return flags;
}

// Flags that must carry a string value: reject value-less (boolean sentinel).
function requireValues(cmdName, flags, keys) {
  for (const key of keys) {
    if (flags[key] !== undefined && typeof flags[key] !== 'string') {
      fail(`${cmdName} needs a value for --${key}`);
    }
  }
}

function parseSteps(raw) {
  // "plan=my-org:planner,review=my-org:reviewer" -> {plan:'my-org:planner',...}
  const steps = {};
  for (const pair of raw.split(',')) {
    const t = pair.trim();
    if (!t) continue;
    const eq = t.indexOf('=');           // split on FIRST '=', skill ids contain ':'
    if (eq < 1) fail(`bad --steps entry '${t}', expected phase=skill`);
    steps[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return steps;
}

function requireSession(repoRoot) {
  const state = readState(repoRoot);
  if (!hasActiveSession(state)) fail('no active session (run /senior-dev:start)');
  return state;
}

function git(repoRoot, args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trimEnd();
  } catch (e) {
    return `(git ${args.join(' ')} failed: ${e.message})`;
  }
}

const repoRoot = findRepoRoot();
if (!repoRoot) fail('not inside a git repository');

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const positional = rest.filter((a, i) => !a.startsWith('--') && (i === 0 || !rest[i - 1].startsWith('--')));

switch (cmd) {
  case 'init': {
    requireValues('init', flags, ['task', 'type']);
    if (!flags.task) fail('init needs --task');
    if (!CHAINS[flags.type]) fail(`init needs --type, one of: ${Object.keys(CHAINS).join(', ')}`);
    const existing = readState(repoRoot);
    if (hasActiveSession(existing)) fail(`a session is already active ('${existing.task}'); finish or bypass it first`);
    const state = {
      version: 1,
      task: flags.task,
      type: flags.type,
      startedAt: new Date().toISOString(),
      worktree: null,
      chain: CHAINS[flags.type],
      phases: {},
      reviews: [],
      docsGate: { ...DOCS_GATE[flags.type] },
      degradations: [],
      bypasses: [],
      scratchFiles: [],
      waits: [],
      stopGate: { lastSnapshotHash: null },
    };
    writeState(repoRoot, state);
    ensureExcluded(repoRoot);
    console.log(`senior-dev session started: [${flags.type}] ${flags.task}`);
    console.log(`chain: ${state.chain.join(' -> ')}`);
    break;
  }
  case 'phase': {
    const state = requireSession(repoRoot);
    requireValues('phase', flags, ['status', 'artefact']);
    const name = positional[0];
    if (!name || !state.chain.includes(name)) fail(`phase must be one of: ${state.chain.join(', ')}`);
    if (!['in_progress', 'done'].includes(flags.status)) fail('phase needs --status in_progress|done');
    state.phases[name] = { ...(state.phases[name] || {}), status: flags.status };
    if (flags.artefact) state.phases[name].artefact = flags.artefact;
    writeState(repoRoot, state);
    console.log(`phase ${name}: ${flags.status}${flags.artefact ? ` (${flags.artefact})` : ''}`);
    break;
  }
  case 'tests-green': {
    const state = requireSession(repoRoot);
    const cur = currentPhase(state);
    if (!cur) fail('all phases already done');
    state.phases[cur] = { ...(state.phases[cur] || { status: 'in_progress' }), testsGreenAt: new Date().toISOString() };
    writeState(repoRoot, state);
    console.log(`tests green recorded on phase '${cur}'`);
    break;
  }
  case 'review': {
    const state = requireSession(repoRoot);
    requireValues('review', flags, ['phase', 'reviewer', 'verdict', 'cycle']);
    if (!flags.phase) fail('review needs --phase <name>');
    if (!['codex', 'claude'].includes(flags.reviewer)) fail('review needs --reviewer codex|claude');
    if (!['APPROVED', 'NEEDS_REVISION'].includes(flags.verdict)) fail('review needs --verdict APPROVED|NEEDS_REVISION');
    const cycleRaw = flags.cycle === undefined ? '1' : flags.cycle;
    if (!/^[0-9]+$/.test(cycleRaw) || parseInt(cycleRaw, 10) < 1) fail('review needs --cycle as a positive integer 1-3');
    const cycle = parseInt(cycleRaw, 10);
    if (cycle > 3) fail('cycle cap is 3 - stop iterating and escalate to the operator');
    state.reviews.push({
      phase: flags.phase, reviewer: flags.reviewer, verdict: flags.verdict,
      cycle, at: new Date().toISOString(),
    });
    writeState(repoRoot, state);
    console.log(`review recorded: ${flags.phase} cycle ${cycle} -> ${flags.verdict}`);
    break;
  }
  case 'docs': {
    const state = requireSession(repoRoot);
    let touched = false;
    for (const key of Object.keys(state.docsGate)) {
      if (flags[key] !== undefined) {
        if (flags[key] !== 'true' && flags[key] !== 'false') fail(`docs --${key} needs an explicit true|false`);
        state.docsGate[key] = flags[key] === 'true';
        touched = true;
      }
    }
    if (!touched) fail(`docs needs at least one of: ${Object.keys(state.docsGate).map((k) => '--' + k).join(' ')}`);
    writeState(repoRoot, state);
    console.log(`docs gate: ${JSON.stringify(state.docsGate)}`);
    break;
  }
  case 'degrade': {
    const state = requireSession(repoRoot);
    requireValues('degrade', flags, ['wanted', 'used', 'reason']);
    if (!flags.wanted || !flags.used) fail('degrade needs --wanted --used [--reason]');
    state.degradations.push({ wanted: flags.wanted, used: flags.used, reason: flags.reason || '', at: new Date().toISOString() });
    writeState(repoRoot, state);
    console.log(`degradation recorded: wanted ${flags.wanted}, using ${flags.used}`);
    break;
  }
  case 'bypass': {
    const state = requireSession(repoRoot);
    const stdinFlag = flags['reason-stdin'];
    if (stdinFlag !== undefined && stdinFlag !== true) {
      fail('bypass --reason-stdin does not take a value');
    }
    const useStdin = stdinFlag === true;
    if (useStdin && typeof flags.reason === 'string') {
      fail('bypass needs --reason "<why>" or --reason-stdin, not both');
    }
    const needBoth = 'bypass needs --reason "<why>" or --reason-stdin (reason read verbatim from stdin)';
    let reason;
    if (useStdin) {
      // Read the ENTIRE stdin text as the reason so quotes, backslashes,
      // leading `--`, and multi-word text all survive verbatim - argv-based
      // --reason is textual template substitution ($ARGUMENTS) and breaks
      // shell quoting on those inputs, silently truncating the recorded
      // reason. Only reached when --reason-stdin is explicitly passed.
      reason = (await readStdin()).trim();
      if (!reason) fail(needBoth);
    } else {
      if (typeof flags.reason !== 'string' || !flags.reason.trim()) fail(needBoth);
      reason = flags.reason;
    }
    state.bypassArmed = { reason, at: new Date().toISOString() };
    writeState(repoRoot, state);
    console.log(`bypass armed (one-shot) - reason logged: ${reason}`);
    break;
  }
  case 'waiting': {
    const state = requireSession(repoRoot);
    requireValues('waiting', flags, ['on']);
    const hasOn = flags.on !== undefined;
    const hasClear = flags.clear !== undefined;
    if (hasOn && hasClear) fail('waiting needs exactly one of --on "<desc>" or --clear, not both');
    if (!hasOn && !hasClear) fail('waiting needs exactly one of --on "<desc>" or --clear');
    if (hasOn) {
      if (!flags.on.trim()) fail('waiting --on needs a non-empty value');
      if (state.waiting) fail(`already waiting on: ${state.waiting.on} - clear it first`);
      const at = new Date().toISOString();
      state.waits = state.waits || [];
      state.waits.push({ on: flags.on, at });
      state.waiting = { on: flags.on, at };
      writeState(repoRoot, state);
      console.log(`waiting on: ${flags.on}`);
    } else {
      if (flags.clear !== true) fail('waiting --clear does not take a value');
      if (!state.waiting) fail('not currently waiting on anything');
      const w = state.waiting;
      // Find the matching open history entry (arming refuses a second wait
      // while one is active, so there is at most one uncleared entry).
      const entry = (state.waits || []).slice().reverse()
        .find((e) => e.on === w.on && e.at === w.at && !e.clearedAt);
      if (entry) entry.clearedAt = new Date().toISOString();
      delete state.waiting;
      writeState(repoRoot, state);
      console.log(`wait cleared: ${w.on}`);
    }
    break;
  }
  case 'scratch': {
    const state = requireSession(repoRoot);
    requireValues('scratch', flags, ['add']);
    if (!flags.add) fail('scratch needs --add <path>');
    state.scratchFiles = state.scratchFiles || [];
    state.scratchFiles.push(flags.add);
    writeState(repoRoot, state);
    console.log(`scratch file tracked: ${flags.add}`);
    break;
  }
  case 'status': {
    const state = readState(repoRoot);
    if (!hasActiveSession(state)) {
      console.log('senior-dev: no active session in this repo.');
      break;
    }
    console.log(`# senior-dev session\n`);
    console.log(`task:   ${state.task}`);
    console.log(`type:   ${state.type}`);
    console.log(`phase:  ${currentPhase(state) || '(all done)'}\n`);
    if (state.waiting) console.log(`WAITING on: ${state.waiting.on} (since ${state.waiting.at})\n`);
    if (state.skillSource) {
      console.log(`skill source: ${state.skillSource.source}`);
      if (state.skillSource.map && Object.keys(state.skillSource.map).length) {
        console.log(`  resolved: ${JSON.stringify(state.skillSource.map)}`);
      }
      if ((state.skillSource.suggestions || []).length) {
        console.log(`  suggestions: ${state.skillSource.suggestions.length}`);
      }
    }
    console.log('phases:');
    for (const name of state.chain) {
      const ph = state.phases[name];
      const mark = ph?.status === 'done' ? 'x' : ph?.status === 'in_progress' ? '~' : ' ';
      console.log(`  [${mark}] ${name}${ph?.artefact ? ` (${ph.artefact})` : ''}${ph?.testsGreenAt ? ' tests-green' : ''}`);
    }
    const verdicts = latestVerdicts(state);
    if (Object.keys(verdicts).length) console.log(`reviews: ${JSON.stringify(verdicts)}`);
    console.log(`docs gate: ${JSON.stringify(state.docsGate)}`);
    if (state.degradations.length) console.log(`degradations: ${state.degradations.map((d) => `${d.wanted} -> ${d.used}`).join('; ')}`);
    if (state.bypasses.length) console.log(`bypasses used: ${state.bypasses.map((b) => `${b.action}: ${b.reason}`).join('; ')}`);
    if (state.bypassArmed) console.log(`bypass ARMED: ${state.bypassArmed.reason}`);
    if ((state.waits || []).length) console.log(`past waits: ${state.waits.length}`);
    const open = openGateItems(state);
    console.log(open.length ? `open gate items (${open.length}):\n  - ${open.join('\n  - ')}` : 'all gates clear.');
    break;
  }
  case 'sweep': {
    requireSession(repoRoot);
    const state = readState(repoRoot);
    console.log('# hygiene sweep evidence\n');
    for (const args of [['worktree', 'list'], ['branch', '--list'], ['status', '--porcelain']]) {
      console.log(`$ git ${args.join(' ')}`);
      const out = git(repoRoot, args);
      console.log(out === '' ? '(clean)' : out);
      console.log('');
    }
    const scratch = state.scratchFiles || [];
    console.log('scratch files tracked this session:');
    if (!scratch.length) console.log('(none)');
    for (const f of scratch) {
      console.log(`  ${existsSync(join(repoRoot, f)) || existsSync(f) ? 'STILL PRESENT' : 'gone'}: ${f}`);
    }
    break;
  }
  case 'finish': {
    const state = requireSession(repoRoot);
    requireValues('finish', flags, ['force-open']);
    // An active wait at finish is always a bookkeeping error - either clear
    // it (the external work finished) or it was abandoned. --force-open is
    // for open GATE items with an operator sign-off; it does not apply here.
    if (state.waiting) fail(`finish refused - still waiting on: ${state.waiting.on} - clear it first or the wait was abandoned`);
    // Running `finish` completes the chain's final phase, so mark it done
    // BEFORE computing open gate items - otherwise phase:finish would always
    // read as open and every close would demand --force-open.
    state.phases.finish = { ...(state.phases.finish || {}), status: 'done' };
    const open = openGateItems(state);
    if (open.length) {
      const forceOpen = flags['force-open'];
      if (forceOpen === undefined) {
        fail(`finish refused - open gate items:\n  - ${open.join('\n  - ')}\nResolve them, run the missing phases/gates, or (operator sign-off only) re-run with --force-open "<reason>".`);
      }
      if (!forceOpen.trim()) fail('finish --force-open needs a non-empty reason');
      state.bypasses = state.bypasses || [];
      state.bypasses.push({
        at: new Date().toISOString(),
        reason: forceOpen,
        action: 'finish --force-open',
        openItems: open,
      });
    }
    state.closedAt = new Date().toISOString();
    const slug = state.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';
    const histDir = join(repoRoot, '.senior-dev', 'history');
    mkdirSync(histDir, { recursive: true });
    // Full timestamp (filesystem-safe: ':' and '.' -> '-'), not just the date,
    // so a same-day same-slug re-finish (the §1 escalation path re-inits the
    // SAME task) gets a distinct filename instead of renameSync silently
    // overwriting the prior archive - including its bypass audit trail.
    const stamp = state.closedAt.replace(/[:.]/g, '-');
    const dest = join(histDir, `${stamp}-${slug}.json`);
    writeState(repoRoot, state);
    renameSync(statePath(repoRoot), dest);
    console.log(`session closed and archived: ${dest}`);
    break;
  }
  case 'skills-config': {
    const sub = positional[0];
    if (sub === 'show') {
      const cfg = readSkillsConfig(repoRoot);
      console.log(cfg ? JSON.stringify(cfg, null, 2) : 'none');
      break;
    }
    if (sub === 'set') {
      requireValues('skills-config set', flags, ['source', 'steps']);
      if (!VALID_SOURCES.includes(flags.source)) {
        fail(`skills-config set needs --source ${VALID_SOURCES.join('|')}`);
      }
      const existing = readSkillsConfig(repoRoot) || {};
      const cfg = {
        version: 1,
        source: flags.source,
        shared: existing.shared === true,
      };
      if (typeof flags.steps === 'string') cfg.steps = parseSteps(flags.steps);
      else if (existing.steps) cfg.steps = existing.steps;
      writeSkillsConfig(repoRoot, cfg);
      ensureExcluded(repoRoot);
      console.log(`skills config: source=${cfg.source}${cfg.steps ? ' steps=' + JSON.stringify(cfg.steps) : ''}`);
      break;
    }
    if (sub === 'share' || sub === 'unshare') {
      const cfg = readSkillsConfig(repoRoot);
      if (!cfg) fail('no skills config yet - run: skills-config set --source <s>');
      cfg.shared = sub === 'share';
      writeSkillsConfig(repoRoot, cfg);
      ensureExcluded(repoRoot);
      if (cfg.shared) console.log('skills config is now shareable. Commit it:\n  git add .senior-dev/skills.json');
      else console.log('skills config is now private (git-excluded).');
      break;
    }
    fail('skills-config needs a subcommand: show | set | share | unshare');
    break;
  }
  case 'skill-source': {
    const state = requireSession(repoRoot);
    requireValues('skill-source', flags, ['source', 'map', 'suggestions']);
    if (!VALID_SOURCES.includes(flags.source)) {
      fail(`skill-source needs --source ${VALID_SOURCES.join('|')}`);
    }
    let map = {}, suggestions = [];
    if (typeof flags.map === 'string') {
      try { map = JSON.parse(flags.map); } catch { fail('skill-source --map must be valid JSON'); }
    }
    if (typeof flags.suggestions === 'string') {
      try { suggestions = JSON.parse(flags.suggestions); } catch { fail('skill-source --suggestions must be valid JSON'); }
    }
    state.skillSource = { source: flags.source, map, suggestions, at: new Date().toISOString() };
    writeState(repoRoot, state);
    console.log(`skill source recorded: ${flags.source}`);
    break;
  }
  default:
    fail(`unknown subcommand '${cmd || ''}'. Use: init|phase|tests-green|review|docs|degrade|bypass|waiting|scratch|skills-config|skill-source|status|sweep|finish`);
}
