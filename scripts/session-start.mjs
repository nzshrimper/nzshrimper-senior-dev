#!/usr/bin/env node
// SessionStart bootstrap: in a git repo, tell the session the conductor
// exists (and whether a session is in flight). Outside a repo: silence.
// Fail open: any error -> exit 0, no output.
import {
  findRepoRoot, readState, hasActiveSession, currentPhase, openGateItems,
} from './lib/state.mjs';

const BOOTSTRAP = `<IMPORTANT>
This repo is under senior-dev orchestration.
Before starting ANY coding task (feature, bug fix, refactor, quick fix, docs change), you MUST invoke the 'senior-dev:conductor' skill. It classifies the task, selects the mandatory skill chain from the installed skills, and records phase state. Commit/integration and session-stop gates are armed while a session is active.
Commands: /senior-dev:start [task] | /senior-dev:status | /senior-dev:bypass <reason> | /senior-dev:finish
</IMPORTANT>`;

async function readStdin() {
  let data = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
  } catch {}
  return data;
}

try {
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(await readStdin());
    if (parsed && typeof parsed.cwd === 'string') cwd = parsed.cwd;
  } catch {}

  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) process.exit(0);

  let ctx = BOOTSTRAP;
  const state = readState(repoRoot);
  if (hasActiveSession(state)) {
    const open = openGateItems(state);
    ctx += `\n\n<IMPORTANT>RESUME: a senior-dev session is in flight in this repo.
task: [${state.type}] ${state.task}
current phase: ${currentPhase(state) || '(all phases done)'}
open gate items: ${open.length ? open.join(', ') : 'none'}
Run /senior-dev:status for detail, then invoke 'senior-dev:conductor' to resume where it left off. Do not restart completed phases.</IMPORTANT>`;
  }

  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
  }));
} catch {}
process.exit(0);
