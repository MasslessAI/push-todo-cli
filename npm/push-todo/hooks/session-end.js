#!/usr/bin/env node
/**
 * Session end hook for Push CLI.
 *
 * Reports session_finished status to Supabase when a Claude Code session ends.
 * Reads the active task from ~/.push/active_task.json (written by fetch.js showTask).
 *
 * This mirrors the daemon's completion flow: daemon sends session_finished
 * when its Claude process exits, this hook does the same for foreground sessions.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { homedir, hostname } from 'os';
import { join } from 'path';

const CONFIG_FILE = join(homedir(), '.config', 'push', 'config');
const MACHINE_ID_FILE = join(homedir(), '.config', 'push', 'machine_id');
const ACTIVE_TASK_FILE = join(homedir(), '.push', 'active_task.json');
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

function getMachineId() {
  if (existsSync(MACHINE_ID_FILE)) {
    try {
      return readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    } catch {
      return null;
    }
  }
  return null;
}

function getActiveTask() {
  if (!existsSync(ACTIVE_TASK_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(ACTIVE_TASK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function clearActiveTask() {
  try {
    if (existsSync(ACTIVE_TASK_FILE)) {
      unlinkSync(ACTIVE_TASK_FILE);
    }
  } catch {
    // Ignore cleanup errors
  }
}

async function reportSessionFinished(apiKey, activeTask) {
  const machineId = getMachineId();
  const machineName = hostname();
  const startedAt = activeTask.startedAt ? new Date(activeTask.startedAt) : null;
  const now = new Date();

  const durationMs = startedAt ? now.getTime() - startedAt.getTime() : null;
  const durationStr = durationMs
    ? `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
    : null;

  const payload = {
    todoId: activeTask.taskId || undefined,
    displayNumber: activeTask.displayNumber,
    status: 'session_finished',
    machineId,
    machineName,
    event: {
      type: 'session_finished',
      timestamp: now.toISOString(),
      machineName: machineName || undefined,
      summary: durationStr
        ? `Foreground session ended (${durationStr})`
        : 'Foreground session ended',
    },
  };

  try {
    const response = await fetch(`${API_BASE}/update-task-execution`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  const apiKey = getApiKey();
  const activeTask = getActiveTask();

  if (!apiKey || !activeTask) {
    // Not configured or no active task — silent exit
    process.exit(0);
  }

  await reportSessionFinished(apiKey, activeTask);
  clearActiveTask();

  process.exit(0);
}

main().catch(() => process.exit(0));
