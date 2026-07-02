#!/usr/bin/env node
// PreToolUse(Bash) gate. Worktree commits need green tests during
// implement/debug; integration (merge/push/PR) needs approved reviews,
// verification, and a full docs gate. Fail open on any error.
import { fileURLToPath } from 'node:url';
import {
  findRepoRoot, readState, hasActiveSession, currentPhase,
  integrationBlockers, consumeBypass,
} from './lib/state.mjs';

const TEST_GATED_PHASES = new Set(['implement', 'debug']);

// Flags that consume a following value token (when given as a separate
// token rather than `--flag=value`). Applies to both `git` and `gh`.
const VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '-R', '--repo']);

// Command-aware classifier: replaces the old regex match (defeatable by
// `git -C <path> push`, quoted strings, `commit-graph`/`commit-tree`, etc).
// Strips quoted spans, splits into shell segments, and only classifies a
// segment when its FIRST token is exactly `git` or `gh`, walking past
// leading flags (and their values) to find the real subcommand.
export function classifyCommand(command) {
  const stripped = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '');
  const segments = stripped.split(/&&|\|\||;|\n|\|/);

  let commit = false;
  let integration = false;

  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [head, ...rest] = tokens;
    if (head !== 'git' && head !== 'gh') continue;

    let i = 0;
    while (i < rest.length && rest[i].startsWith('-')) {
      if (VALUE_FLAGS.has(rest[i])) i += 2;
      else i += 1;
    }
    if (i >= rest.length) continue;

    if (head === 'git') {
      const sub = rest[i];
      if (sub === 'commit') {
        commit = true;
      } else if (sub === 'push' || sub === 'merge') {
        integration = true;
      } else if (sub === 'subtree' && rest.slice(i + 1).includes('push')) {
        integration = true;
      }
    } else {
      // gh
      if (rest[i] === 'pr' && rest[i + 1] === 'create') {
        integration = true;
      }
    }
  }

  return { commit, integration };
}

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

async function main() {
  try {
    const data = JSON.parse(await readStdin());
    if (data.tool_name !== 'Bash') process.exit(0);
    const command = data.tool_input?.command || '';
    const { commit: isCommit, integration: isIntegration } = classifyCommand(command);
    if (!isIntegration && !isCommit) process.exit(0);

    const repoRoot = findRepoRoot(data.cwd || process.cwd());
    if (!repoRoot) process.exit(0);
    const state = readState(repoRoot);
    if (!hasActiveSession(state)) process.exit(0);

    // Compute the decision BEFORE touching any armed bypass: an action that
    // was never going to be blocked must not spend the operator's one-shot
    // bypass token.
    let blockMsg = null;

    if (isIntegration) {
      const blockers = integrationBlockers(state);
      if (blockers.length) {
        blockMsg = `integration blocked (${blockers.length} item${blockers.length > 1 ? 's' : ''}):\n- ${blockers.join('\n- ')}`;
      }
    }

    if (!blockMsg && isCommit) {
      const cur = currentPhase(state);
      if (cur && TEST_GATED_PHASES.has(cur) && !state.phases?.[cur]?.testsGreenAt) {
        blockMsg = `commit blocked: phase '${cur}' has no green test run recorded. Run the tests, then: node "$CLAUDE_PLUGIN_ROOT/scripts/state-cli.mjs" tests-green (conductor skill shows the exact call).`;
      }
    }

    if (blockMsg) {
      if (consumeBypass(repoRoot, state, command.slice(0, 120))) process.exit(0);
      block(blockMsg);
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
}

// Only run the PreToolUse hook body when this file is executed directly
// (as the hook script). When it's `import`-ed (e.g. by tests pulling in
// `classifyCommand`), evaluating the module must NOT block on stdin.
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  await main();
}
