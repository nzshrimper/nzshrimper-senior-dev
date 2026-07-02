#!/usr/bin/env node
// PreToolUse(Bash) gate. Worktree commits need green tests during
// implement/debug; integration (merge/push/PR) needs approved reviews,
// verification, and a full docs gate. Fail open on any error.
import {
  findRepoRoot, readState, hasActiveSession, currentPhase,
  integrationBlockers, consumeBypass,
} from './lib/state.mjs';

const INTEGRATION = /\bgit\s+(merge|push)\b|\bgh\s+pr\s+create\b/;
const COMMIT = /\bgit\s+commit\b/;
const TEST_GATED_PHASES = new Set(['implement', 'debug']);

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function block(msg) {
  console.error(`senior-dev gate: ${msg}\nSee /senior-dev:status for detail, or /senior-dev:bypass <reason> to waive (logged).`);
  process.exit(2);
}

try {
  const data = JSON.parse(await readStdin());
  if (data.tool_name !== 'Bash') process.exit(0);
  const command = data.tool_input?.command || '';
  const isIntegration = INTEGRATION.test(command);
  const isCommit = !isIntegration && COMMIT.test(command);
  if (!isIntegration && !isCommit) process.exit(0);

  const repoRoot = findRepoRoot(data.cwd || process.cwd());
  if (!repoRoot) process.exit(0);
  const state = readState(repoRoot);
  if (!hasActiveSession(state)) process.exit(0);

  if (consumeBypass(repoRoot, state, command.slice(0, 120))) process.exit(0);

  if (isIntegration) {
    const blockers = integrationBlockers(state);
    if (blockers.length) {
      block(`integration blocked (${blockers.length} item${blockers.length > 1 ? 's' : ''}):\n- ${blockers.join('\n- ')}`);
    }
    process.exit(0);
  }

  // isCommit
  const cur = currentPhase(state);
  if (cur && TEST_GATED_PHASES.has(cur) && !state.phases?.[cur]?.testsGreenAt) {
    block(`commit blocked: phase '${cur}' has no green test run recorded. Run the tests, then: node "$CLAUDE_PLUGIN_ROOT/scripts/state-cli.mjs" tests-green (conductor skill shows the exact call).`);
  }
  process.exit(0);
} catch {
  process.exit(0);
}
