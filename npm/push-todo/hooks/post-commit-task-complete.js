#!/usr/bin/env node
/**
 * PostToolUse hook: auto-complete Push tasks on git commit.
 *
 * Fires after every Bash tool call. Detects "Task #NNNN" patterns in git
 * commit messages and marks the corresponding Push tasks as completed.
 *
 * This closes the workflow gap where work committed directly to master
 * (outside the daemon worktree pipeline) would otherwise leave tasks
 * in session_finished state indefinitely.
 *
 * Guards:
 * - Only fires on successful git commit commands
 * - Skips tasks that are already completed
 * - Skips tasks with execution_status=running or queued (daemon owns them)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_FILE = join(homedir(), '.config', 'push', 'config');
const API_BASE = 'https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1';

function getApiKey() {
  if (process.env.PUSH_API_KEY) {
    return process.env.PUSH_API_KEY;
  }
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(CONFIG_FILE, 'utf8');
    const match = content.match(/^export\s+PUSH_API_KEY\s*=\s*["']?([^"'\n]+)["']?/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchTask(apiKey, displayNumber) {
  const response = await fetch(
    `${API_BASE}/synced-todos?display_number=${displayNumber}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!response.ok) return null;
  const data = await response.json();
  const todos = data.todos || [];
  return todos.length > 0 ? todos[0] : null;
}

async function markCompleted(apiKey, todoId) {
  const response = await fetch(`${API_BASE}/todo-status`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      todoId,
      isCompleted: true,
      completedAt: new Date().toISOString(),
      completionComment: 'Completed via direct commit in Claude Code session',
    }),
    signal: AbortSignal.timeout(8000),
  });
  return response.ok;
}

async function main() {
  const apiKey = getApiKey();
  if (!apiKey) process.exit(0);

  const stdin = await readStdin();
  if (!stdin.trim()) process.exit(0);

  let hookData;
  try {
    hookData = JSON.parse(stdin);
  } catch {
    process.exit(0);
  }

  // Only handle Bash tool calls
  if (hookData.tool_name !== 'Bash') process.exit(0);

  // Only handle successful calls (skip errored commands)
  if (hookData.tool_response?.isError) process.exit(0);

  const command = hookData.tool_input?.command || '';

  // Only handle git commit commands
  if (!command.includes('git commit')) process.exit(0);

  // Extract all unique Task #NNNN patterns from the commit message
  const taskMatches = [...command.matchAll(/Task\s+#(\d+)/gi)];
  if (taskMatches.length === 0) process.exit(0);

  const taskNumbers = [...new Set(taskMatches.map((m) => parseInt(m[1], 10)))];

  for (const num of taskNumbers) {
    try {
      const task = await fetchTask(apiKey, num);
      if (!task) continue;

      // Skip already completed tasks
      if (task.isCompleted) continue;

      // Skip tasks the daemon is actively working on
      const status = task.executionStatus;
      if (status === 'running' || status === 'queued') continue;

      await markCompleted(apiKey, task.id);
    } catch {
      // Never block Claude on hook errors
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
