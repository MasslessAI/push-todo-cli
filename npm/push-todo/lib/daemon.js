#!/usr/bin/env node
/**
 * Push Task Execution Daemon
 *
 * Polls Supabase for queued tasks and executes them via Claude Code.
 * Auto-heals (starts) on any /push-todo command via daemon-health.js.
 *
 * Architecture:
 * - Git branch = worktree = Claude session (1:1:1 mapping)
 * - Uses Claude's --continue to resume sessions in worktrees
 * - All tasks execute with bypassPermissions mode
 *
 * Ported from: plugins/push-todo/scripts/daemon.py
 */

import { randomUUID } from 'crypto';
import { spawn, execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, statSync, renameSync, readdirSync } from 'fs';
import { homedir, hostname, platform } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { checkForUpdate, performUpdate } from './self-update.js';
import { getProjectContext, buildSmartPrompt, invalidateCache } from './context-engine.js';
import { sendMacNotification } from './utils/notify.js';
import { checkAndRunDueJobs } from './cron.js';
import { runHeartbeatChecks } from './heartbeat.js';
import { getAgentVersions, formatAgentVersionSummary, checkAllAgentUpdates, performAgentUpdate, checkVersionParity } from './agent-versions.js';
import { checkAllProjectsFreshness } from './project-freshness.js';
import { getStatus as getLaunchAgentStatus, install as refreshLaunchAgent } from './launchagent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== Configuration ====================

const API_BASE_URL = 'https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1';
const POLL_INTERVAL = 30000; // 30 seconds
const MAX_CONCURRENT_TASKS = 5;
const TASK_TIMEOUT_MS = 3600000; // 1 hour

// Retry configuration
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INITIAL_DELAY = 2000;
const RETRY_MAX_DELAY = 30000;
const RETRY_BACKOFF_FACTOR = 2;

// Certainty thresholds
const CERTAINTY_HIGH_THRESHOLD = 0.7;
const CERTAINTY_LOW_THRESHOLD = 0.4;

// Idle auto-recovery (Level B)
const IDLE_TIMEOUT_MS = 900000; // 15 min no stdout → kill (smarter than absolute timeout)
const HEARTBEAT_INTERVAL_MS = 300000; // 5 min progress heartbeat to Supabase (Level A)

// Stuck detection
const STUCK_IDLE_THRESHOLD = 600000; // 10 min
const STUCK_WARNING_THRESHOLD = 300000; // 5 min

// Stuck patterns that indicate Claude is waiting for input
const STUCK_PATTERNS = [
  'waiting for permission',
  'approve this action',
  'permission required',
  'plan ready for approval',
  'waiting for user',
  'enter plan mode',
  'press enter to continue',
  'y/n',
  '[Y/n]',
  'confirm:'
];

// Retryable error patterns
const RETRYABLE_ERRORS = [
  'timeout', 'connection refused', 'connection reset',
  'network is unreachable', 'temporary failure', 'rate limit',
  '429', '502', '503', '504'
];

// Notification settings
const NOTIFY_ON_COMPLETE = true;
const NOTIFY_ON_FAILURE = true;
const NOTIFY_ON_NEEDS_INPUT = true;

// Paths
const PUSH_DIR = join(homedir(), '.push');
const CONFIG_DIR = join(homedir(), '.config', 'push');
const PID_FILE = join(PUSH_DIR, 'daemon.pid');
const LOG_FILE = join(PUSH_DIR, 'daemon.log');
const STATUS_FILE = join(PUSH_DIR, 'daemon_status.json');
const VERSION_FILE = join(PUSH_DIR, 'daemon.version');
const LOCK_FILE = join(PUSH_DIR, 'daemon.lock');
const CONFIG_FILE = join(CONFIG_DIR, 'config');
const MACHINE_ID_FILE = join(CONFIG_DIR, 'machine_id');
const REGISTRY_FILE = join(CONFIG_DIR, 'projects.json');

// Log rotation settings
const LOG_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const LOG_BACKUP_COUNT = 3;

// State
const runningTasks = new Map(); // displayNumber -> taskInfo
const taskDetails = new Map();  // displayNumber -> details
const completedToday = [];
const COMPLETED_TODAY_MAX = 100;

function trackCompleted(entry) {
  completedToday.push(entry);
  if (completedToday.length > COMPLETED_TODAY_MAX) {
    completedToday.splice(0, completedToday.length - COMPLETED_TODAY_MAX);
  }
}
const taskLastOutput = new Map(); // displayNumber -> timestamp
const taskStdoutBuffer = new Map(); // displayNumber -> lines[]
const taskStderrBuffer = new Map(); // displayNumber -> lines[]
const taskProjectPaths = new Map(); // displayNumber -> projectPath
const taskLastHeartbeat = new Map(); // displayNumber -> timestamp of last progress heartbeat

// Stream-json state (Phase 1: real-time progress)
const taskStreamLineBuffer = new Map(); // displayNumber -> partial NDJSON line fragment
const taskActivityState = new Map(); // displayNumber -> { filesRead: Set, filesEdited: Set, currentTool: string, lastText: string }
const taskLastStreamProgress = new Map(); // displayNumber -> timestamp of last stream progress sent
const STREAM_PROGRESS_THROTTLE_MS = 30000; // 30s between stream progress updates to Supabase
let daemonStartTime = null;

// ==================== Utilities ====================

function parseJsonField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

// ==================== Logging ====================

function rotateLogs() {
  try {
    if (!existsSync(LOG_FILE)) return;

    const stats = statSync(LOG_FILE);
    if (stats.size < LOG_MAX_SIZE) return;

    // Rotate existing backups
    for (let i = LOG_BACKUP_COUNT; i > 0; i--) {
      const oldBackup = `${LOG_FILE}.${i}`;
      const newBackup = `${LOG_FILE}.${i + 1}`;

      if (i === LOG_BACKUP_COUNT && existsSync(oldBackup)) {
        unlinkSync(oldBackup);
      } else if (existsSync(oldBackup)) {
        renameSync(oldBackup, newBackup);
      }
    }

    // Rotate current log
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // Non-critical - continue even if rotation fails
  }
}

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [PID:${process.pid}] [${level}] ${message}\n`;

  if (process.env.PUSH_DAEMON !== '1') {
    process.stdout.write(line);
  }

  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

function logError(message) {
  log(message, 'ERROR');
}

// ==================== Lock File ====================

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const holderPid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (!isNaN(holderPid) && holderPid !== process.pid && isProcessRunning(holderPid)) {
        return false;
      }
      // Holder is dead or is us — clean up stale lock
      try { unlinkSync(LOCK_FILE); } catch {}
    }
    writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch {}
}

// ==================== Config ====================

function getApiKey() {
  if (process.env.PUSH_API_KEY) {
    return process.env.PUSH_API_KEY;
  }

  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, 'utf8');
      const match = content.match(/^export\s+PUSH_API_KEY\s*=\s*["']?([^"'\n]+)["']?/m);
      if (match) return match[1];
    } catch {}
  }

  return null;
}

function getMachineId() {
  if (existsSync(MACHINE_ID_FILE)) {
    try {
      return readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    } catch {}
  }
  return null;
}

function getMachineName() {
  return hostname();
}

function getVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || '3.0.0';
  } catch {
    return '3.0.0';
  }
}

function getConfigValueFromFile(key, defaultValue = '') {
  const fullKey = `PUSH_${key}`;
  if (!existsSync(CONFIG_FILE)) return defaultValue;
  try {
    const content = readFileSync(CONFIG_FILE, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`export ${fullKey}=`)) {
        let value = trimmed.split('=')[1] || '';
        value = value.trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {}
  return defaultValue;
}

function getAutoMergeEnabled() {
  const v = getConfigValueFromFile('AUTO_MERGE', 'true');
  return v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes';
}

function getAutoCompleteEnabled() {
  const v = getConfigValueFromFile('AUTO_COMPLETE', 'true');
  return v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes';
}

function getAutoUpdateEnabled() {
  const v = getConfigValueFromFile('AUTO_UPDATE', 'true');
  return v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes';
}

function getAutoUpdateAgentsEnabled() {
  const v = getConfigValueFromFile('AUTO_UPDATE_AGENTS', 'false');
  return v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes';
}

// ==================== Capabilities Detection ====================

let cachedCapabilities = null;
let lastCapabilityCheck = 0;
const CAPABILITY_CHECK_INTERVAL = 3600000; // 1 hour

/**
 * Discover skills for all registered projects.
 * Scans ~/.claude/skills/ (global) and <projectPath>/.claude/skills/ (per-project).
 * Returns: { "github.com/user/repo": ["skill1", "skill2"], ... }
 */
function discoverProjectSkills() {
  const globalSkillsDir = join(homedir(), '.claude', 'skills');
  const globalSkills = [];

  // Enumerate global skills
  if (existsSync(globalSkillsDir)) {
    try {
      for (const entry of readdirSync(globalSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          globalSkills.push(entry.name);
        }
      }
    } catch { /* ignore */ }
  }

  // For each registered project, enumerate project-local skills and merge with global
  const result = {};
  if (!existsSync(REGISTRY_FILE)) return result;

  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    for (const [, info] of Object.entries(data.projects || {})) {
      const remote = info.gitRemote;
      const localPath = info.localPath || info.local_path;
      if (!remote || !localPath) continue;

      const projectSkillsDir = join(localPath, '.claude', 'skills');
      const projectSkills = new Set(globalSkills);

      if (existsSync(projectSkillsDir)) {
        try {
          for (const entry of readdirSync(projectSkillsDir, { withFileTypes: true })) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              projectSkills.add(entry.name);
            }
          }
        } catch { /* ignore */ }
      }

      if (projectSkills.size > 0) {
        result[remote] = [...projectSkills].sort();
      }
    }
  } catch { /* ignore */ }

  return result;
}

function detectCapabilities() {
  const caps = {
    auto_merge: getAutoMergeEnabled(),
    auto_complete: getAutoCompleteEnabled(),
    auto_update: getAutoUpdateEnabled(),
  };

  try {
    execFileSync('gh', ['--version'], { timeout: 5000, stdio: 'pipe' });
    try {
      execFileSync('gh', ['auth', 'status'], { timeout: 5000, stdio: 'pipe' });
      caps.gh_cli = 'authenticated';
    } catch {
      caps.gh_cli = 'installed_not_authenticated';
    }
  } catch {
    caps.gh_cli = 'not_installed';
  }

  caps.project_skills = discoverProjectSkills();

  return caps;
}

function getCapabilities() {
  const now = Date.now();
  if (!cachedCapabilities || now - lastCapabilityCheck > CAPABILITY_CHECK_INTERVAL) {
    cachedCapabilities = detectCapabilities();
    lastCapabilityCheck = now;
  }
  return cachedCapabilities;
}

// ==================== E2EE Decryption ====================

let decryptTodoField = null;
let e2eeAvailable = false;

try {
  const encryption = await import('./encryption.js');
  decryptTodoField = encryption.decryptTodoField;
  const [available] = encryption.isE2EEAvailable();
  e2eeAvailable = available;
} catch {
  e2eeAvailable = false;
}

function decryptTaskFields(task) {
  if (!e2eeAvailable || !decryptTodoField) {
    return task;
  }

  const decrypted = { ...task };
  const encryptedFields = [
    'summary', 'content', 'normalizedContent', 'normalized_content',
    'originalTranscript', 'original_transcript', 'transcript', 'title'
  ];

  for (const field of encryptedFields) {
    if (decrypted[field]) {
      decrypted[field] = decryptTodoField(decrypted[field]);
    }
  }

  return decrypted;
}

// ==================== API ====================

function isRetryableError(error) {
  const errorStr = String(error).toLowerCase();
  return RETRYABLE_ERRORS.some(pattern => errorStr.includes(pattern.toLowerCase()));
}

async function apiRequest(endpoint, options = {}, retry = true) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No API key configured');
  }

  const url = `${API_BASE_URL}/${endpoint}`;
  const maxAttempts = retry ? RETRY_MAX_ATTEMPTS : 1;
  let delay = RETRY_INITIAL_DELAY;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...options.headers
        }
      });

      clearTimeout(timeout);
      return response;
    } catch (error) {
      const isLast = attempt === maxAttempts;

      if (!isLast && retry && isRetryableError(error)) {
        log(`API request failed (attempt ${attempt}/${maxAttempts}): ${error.message}`);
        log(`Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * RETRY_BACKOFF_FACTOR, RETRY_MAX_DELAY);
      } else {
        throw error;
      }
    }
  }
}

async function fetchQueuedTasks() {
  try {
    const machineId = getMachineId();
    const machineName = getMachineName();
    const params = new URLSearchParams();
    params.set('execution_status', 'queued');
    if (machineId) {
      params.set('machine_id', machineId);
    }

    // Get registered git_remotes for heartbeat tracking
    // This enables iOS app to check if daemon is online for specific projects
    const projects = getListedProjects();
    const gitRemotes = Object.keys(projects);

    // Get projects with action type for structured heartbeat (multi-agent support)
    const projectsWithType = getListedProjectsWithActionType();

    // Add machine registry headers for daemon status tracking
    // See: /docs/20260204_daemon_heartbeat_status_indicator_implementation_plan.md (machine_registry table)
    const heartbeatHeaders = {};
    if (machineId && gitRemotes.length > 0) {
      heartbeatHeaders['X-Machine-Id'] = machineId;
      heartbeatHeaders['X-Machine-Name'] = machineName || 'Unknown Mac';
      // Structured format: "remote::type,remote::type" (backward compat: old parsers split on , and ignore ::)
      heartbeatHeaders['X-Git-Remotes'] = projectsWithType
        .map(p => `${p.gitRemote}::${p.actionType}`)
        .join(',');
      heartbeatHeaders['X-Daemon-Version'] = getVersion();
      heartbeatHeaders['X-Capabilities'] = JSON.stringify(getCapabilities());
    }

    const response = await apiRequest(`synced-todos?${params}`, {
      headers: heartbeatHeaders
    });

    if (!response.ok) {
      if (response.status === 404) return [];
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.todos || [];
  } catch (error) {
    logError(`Failed to fetch queued tasks: ${error.message}`);
    return [];
  }
}

// ==================== Scheduled Reminder Bridge ====================

async function fetchScheduledTodos() {
  try {
    const machineId = getMachineId();
    const params = new URLSearchParams();
    params.set('scheduled_before', new Date().toISOString());
    if (machineId) {
      params.set('machine_id', machineId);
    }

    // Include registered git_remotes so backend can scope to this machine's projects
    const projects = getListedProjects();
    const gitRemotes = Object.keys(projects);
    const headers = {};
    if (machineId && gitRemotes.length > 0) {
      headers['X-Machine-Id'] = machineId;
      headers['X-Git-Remotes'] = gitRemotes.join(',');
    }

    const response = await apiRequest(`synced-todos?${params}`, { headers });
    if (!response.ok) return [];

    const data = await response.json();
    return data.todos || [];
  } catch (error) {
    logError(`Failed to fetch scheduled todos: ${error.message}`);
    return [];
  }
}

async function checkAndQueueScheduledTodos() {
  const scheduledTodos = await fetchScheduledTodos();
  if (scheduledTodos.length === 0) return;

  const registeredProjects = getListedProjects();

  for (const todo of scheduledTodos) {
    const dn = todo.displayNumber || todo.display_number;
    const todoId = todo.id;

    // Skip tasks already in an execution state (running, queued, completed, failed, etc.)
    const execStatus = todo.executionStatus || todo.execution_status;
    if (execStatus && execStatus !== 'none') {
      continue;
    }

    // Skip completed tasks
    if (todo.isCompleted || todo.is_completed) {
      continue;
    }

    // Skip tasks whose project is not registered on this machine
    const gitRemote = todo.gitRemote || todo.git_remote;
    if (gitRemote && Object.keys(registeredProjects).length > 0) {
      if (!(gitRemote in registeredProjects)) {
        log(`Schedule skipped #${dn}: project ${gitRemote} not registered on this machine`);
        continue;
      }
    }

    log(`Schedule triggered for #${dn} (reminder_date: ${todo.reminderDate || todo.reminder_date})`);

    try {
      await updateTaskStatus(dn, 'queued', {
        event: {
          type: 'scheduled_trigger',
          timestamp: new Date().toISOString(),
          summary: 'Auto-queued: reminder time reached',
        }
      }, todoId);

      log(`Queued #${dn} via schedule trigger`);
    } catch (error) {
      logError(`Failed to queue scheduled todo #${dn}: ${error.message}`);
    }
  }
}

// ==================== Task Status Updates ====================

async function updateTaskStatus(displayNumber, status, extra = {}, todoId = null) {
  try {
    const payload = {
      displayNumber,
      status,
      ...extra
    };
    // Prefer UUID for API lookup (displayNumber kept for backward compat)
    if (todoId) {
      payload.todoId = todoId;
    }

    const machineId = getMachineId();
    const machineName = getMachineName();
    if (machineId) {
      payload.machineId = machineId;
      payload.machineName = machineName;
    }

    // Auto-generate execution event for timeline
    if (!payload.event) {
      const eventType = status === 'running' ? 'started'
        : status === 'session_finished' ? 'session_finished'
        : status === 'failed' ? 'failed'
        : null;
      if (eventType) {
        payload.event = {
          type: eventType,
          timestamp: new Date().toISOString(),
          machineName: machineName || undefined,
        };
        if (extra.summary) payload.event.summary = extra.summary;
        if (extra.error) payload.event.summary = extra.error;
        if (extra.sessionId) payload.event.sessionId = extra.sessionId;
      }
    }

    const response = await apiRequest('update-task-execution', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => null);
    if (!response.ok) {
      logError(`Task status update failed: HTTP ${response.status} for #${displayNumber} -> ${status}`);
      return false;
    }
    if (result?.success === false) {
      logError(`Task status update rejected for #${displayNumber} -> ${status}: ${JSON.stringify(result)}`);
      return false;
    }
    return true;
  } catch (error) {
    logError(`Failed to update task status: ${error.message}`);
    return false;
  }
}

async function claimTask(displayNumber, todoId, sessionId) {
  const machineId = getMachineId();
  const machineName = getMachineName();

  if (!machineId) {
    // No machine ID - skip atomic claiming
    return true;
  }

  const branch = getBranchName(displayNumber);

  const payload = {
    todoId: todoId || undefined,     // UUID lookup (primary, avoids display_number collisions)
    displayNumber,                   // Fallback + kept for logging
    status: 'running',
    machineId,
    machineName,
    branch,
    sessionId,                       // Pre-assigned session ID for reliable resume
    atomic: true,
    event: {
      type: 'started',
      timestamp: new Date().toISOString(),
      machineName: machineName || undefined,
    }
  };

  try {
    const response = await apiRequest('update-task-execution', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (result.claimed === true) {
      log(`Task #${displayNumber} claimed by this machine (${machineName})`);
      return true;
    }

    if (result.claimed === false) {
      log(`Task #${displayNumber} already claimed by ${result.claimedBy || 'another machine'}`);
      return false;
    }

    // Backward compatibility
    return response.ok;
  } catch (error) {
    log(`Task #${displayNumber} claim request failed: ${error.message}`);
    return false;
  }
}

// ==================== Project Registry ====================

function getProjectPath(gitRemote, actionType) {
  if (!existsSync(REGISTRY_FILE)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    const projects = data.projects || {};

    // Try exact composite key first (V2 format)
    if (actionType) {
      const key = `${gitRemote}::${actionType}`;
      if (projects[key]) {
        return projects[key].localPath || projects[key].local_path || null;
      }
    }

    // Fall back to scanning for matching gitRemote (V2 or V1 format)
    for (const [key, info] of Object.entries(projects)) {
      if ((info.gitRemote || key) === gitRemote) {
        return info.localPath || info.local_path || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get project info including path and action metadata.
 * Like getProjectPath but also returns actionName for the prompt engine.
 */
function getProjectInfo(gitRemote, actionType) {
  if (!existsSync(REGISTRY_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    const projects = data.projects || {};

    // Try exact composite key first (V2 format)
    if (actionType) {
      const key = `${gitRemote}::${actionType}`;
      if (projects[key]) {
        return {
          path: projects[key].localPath || projects[key].local_path || null,
          actionName: projects[key].actionName || null,
        };
      }
    }

    // Fallback scan
    for (const [key, info] of Object.entries(projects)) {
      if ((info.gitRemote || key) === gitRemote) {
        return {
          path: info.localPath || info.local_path || null,
          actionName: info.actionName || null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List all registered projects (backward-compatible: gitRemote -> localPath).
 */
function getListedProjects() {
  if (!existsSync(REGISTRY_FILE)) {
    return {};
  }

  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    const result = {};
    for (const [key, info] of Object.entries(data.projects || {})) {
      const remote = info.gitRemote || key;
      if (!(remote in result)) {
        result[remote] = info.localPath || info.local_path;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * List all registered projects with action type info.
 * Returns array of {gitRemote, actionType} for structured heartbeat.
 */
function getListedProjectsWithActionType() {
  if (!existsSync(REGISTRY_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    const result = [];
    for (const [key, info] of Object.entries(data.projects || {})) {
      result.push({
        gitRemote: info.gitRemote || key,
        actionType: info.actionType || 'claude-code',
      });
    }
    return result;
  } catch {
    return [];
  }
}

// ==================== Git Worktree Management ====================

function getWorktreeSuffix() {
  const machineId = getMachineId();
  if (machineId) {
    // Extract the random suffix from machine_id (last 8 chars after hyphen)
    const parts = machineId.split('-');
    if (parts.length > 1) {
      return parts[parts.length - 1].slice(0, 8);
    }
    return machineId.slice(0, 8);
  }
  return 'local';
}

// Worktree name passed to Claude Code's --worktree flag
function getWorktreeName(displayNumber) {
  const suffix = getWorktreeSuffix();
  return `push-${displayNumber}-${suffix}`;
}

// Branch name created by Claude Code's --worktree (adds "worktree-" prefix)
function getBranchName(displayNumber) {
  return `worktree-${getWorktreeName(displayNumber)}`;
}

function getWorktreePath(displayNumber, projectPath) {
  const wtName = getWorktreeName(displayNumber);
  const basePath = projectPath || process.cwd();
  return join(basePath, '.claude', 'worktrees', wtName);
}

// createWorktree() removed — Claude Code's --worktree flag handles creation

function cleanupWorktree(displayNumber, projectPath) {
  const worktreePath = getWorktreePath(displayNumber, projectPath);

  if (!existsSync(worktreePath)) return;

  const gitCwd = projectPath || process.cwd();
  const branch = getBranchName(displayNumber);

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: gitCwd,
      timeout: 30000,
      stdio: 'pipe'
    });
    log(`Cleaned up worktree: ${worktreePath}`);
    log(`Branch preserved for review: ${branch}`);
  } catch (e) {
    logError(`Failed to cleanup worktree: ${e.message}`);
  }
}

// ==================== PR Auto-Creation ====================

function createPRForTask(displayNumber, summary, projectPath) {
  const branch = getBranchName(displayNumber);
  const gitCwd = projectPath || process.cwd();

  try {
    // Check if branch has commits
    const logResult = execSync(`git log HEAD..${branch} --oneline`, {
      cwd: gitCwd,
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (!logResult.trim()) {
      log(`Branch ${branch} has no new commits, skipping PR creation`);
      return null;
    }

    const commitCount = logResult.trim().split('\n').length;
    log(`Branch ${branch} has ${commitCount} new commit(s)`);

    // Push branch
    execSync(`git push -u origin ${branch}`, {
      cwd: gitCwd,
      timeout: 60000,
      stdio: 'pipe'
    });
    log(`Pushed branch ${branch} to origin`);

    // Create PR using gh CLI
    const prTitle = `Push Task #${displayNumber}: ${summary.slice(0, 50)}`;
    const prBody = `## Summary

Automated PR from Push daemon for task #${displayNumber}.

**Task:** ${summary}

---

*This PR was created automatically by the Push task execution daemon.*
*Review the changes and merge when ready.*`;

    const prResult = execSync(`gh pr create --head ${branch} --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`, {
      cwd: gitCwd,
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const prUrl = prResult.trim();
    log(`Created PR for task #${displayNumber}: ${prUrl}`);
    return prUrl;
  } catch (e) {
    if (e.message?.includes('already exists')) {
      log(`PR already exists for branch ${branch}`);
    } else if (e.message?.includes('not found') || e.message?.includes('ENOENT')) {
      log('GitHub CLI (gh) not installed, skipping PR creation');
    } else {
      logError(`Failed to create PR: ${e.message}`);
    }
    return null;
  }
}

/**
 * Attempt to merge a PR. If merge conflicts, use Claude to resolve them.
 *
 * @returns {boolean} True if merge succeeded
 */
function mergePRForTask(displayNumber, prUrl, projectPath) {
  const gitCwd = projectPath || process.cwd();

  const prMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!prMatch) {
    logError(`Could not extract PR number from: ${prUrl}`);
    return false;
  }
  const prNumber = prMatch[1];

  // First attempt: direct merge
  const firstResult = attemptPRMerge(prNumber, displayNumber, gitCwd);
  if (firstResult === 'success') return true;
  if (firstResult !== 'conflict') return false;  // non-conflict failure

  // Conflict detected — try to resolve with Claude
  const branch = getBranchName(displayNumber);
  const resolved = resolveConflictsWithClaude(displayNumber, branch, gitCwd);
  if (!resolved) return false;

  // Second attempt after conflict resolution
  log(`Retrying merge for PR #${prNumber} after conflict resolution`);
  return attemptPRMerge(prNumber, displayNumber, gitCwd) === 'success';
}

/**
 * Try gh pr merge. Returns 'success', 'conflict', or 'error'.
 */
function attemptPRMerge(prNumber, displayNumber, gitCwd) {
  try {
    execFileSync('gh', ['pr', 'merge', prNumber, '--merge', '--delete-branch'], {
      cwd: gitCwd,
      timeout: 60000,
      stdio: 'pipe'
    });
    log(`Merged PR #${prNumber} for task #${displayNumber}`);

    // Pull main locally so next worktree is up to date
    try {
      execFileSync('git', ['pull', '--ff-only'], {
        cwd: gitCwd,
        timeout: 30000,
        stdio: 'pipe'
      });
      log('Updated local main branch');
    } catch {
      log('Could not pull main (may not be checked out), skipping local update');
    }

    return 'success';
  } catch (e) {
    const stderr = e.stderr?.toString() || e.message || '';
    if (stderr.includes('not found') || stderr.includes('ENOENT')) {
      log('GitHub CLI (gh) not installed, skipping merge');
      return 'error';
    }
    if (stderr.includes('merge conflict') || stderr.includes('conflict')) {
      log(`PR #${prNumber} has merge conflicts, will attempt resolution`);
      return 'conflict';
    }
    logError(`PR merge failed for #${displayNumber}: ${stderr.slice(0, 200)}`);
    return 'error';
  }
}

/**
 * Resolve merge conflicts by creating a worktree, merging main, using Claude
 * to fix conflicts, then committing and pushing the resolution.
 *
 * @returns {boolean} True if conflicts were resolved and pushed
 */
function resolveConflictsWithClaude(displayNumber, branch, projectPath) {
  log(`Attempting conflict resolution for task #${displayNumber}`);

  const worktreePath = getWorktreePath(displayNumber, projectPath);

  // Recreate worktree from the existing branch
  try {
    if (!existsSync(worktreePath)) {
      execFileSync('git', ['worktree', 'add', worktreePath, branch], {
        cwd: projectPath,
        timeout: 30000,
        stdio: 'pipe'
      });
    }
  } catch (e) {
    logError(`Could not create worktree for conflict resolution: ${e.message}`);
    return false;
  }

  try {
    // Fetch latest main
    execFileSync('git', ['fetch', 'origin'], {
      cwd: worktreePath,
      timeout: 30000,
      stdio: 'pipe'
    });

    // Attempt merge — this will create conflict markers if conflicts exist
    try {
      execFileSync('git', ['merge', 'origin/main', '--no-edit'], {
        cwd: worktreePath,
        timeout: 30000,
        stdio: 'pipe'
      });
      // No conflicts — merge succeeded cleanly
      log(`No actual conflicts for #${displayNumber}, merge succeeded locally`);
      execFileSync('git', ['push', 'origin', branch], {
        cwd: worktreePath,
        timeout: 30000,
        stdio: 'pipe'
      });
      cleanupWorktree(displayNumber, projectPath);
      return true;
    } catch {
      // Expected: merge conflicts exist, continue to resolution
      log(`Conflicts detected for #${displayNumber}, invoking Claude to resolve`);
    }

    // Use Claude to resolve the conflicts
    const prompt = [
      'There are merge conflicts in this repository from merging origin/main.',
      'Run `git diff` to see the conflict markers.',
      'Resolve ALL conflicts by choosing the correct code for each one.',
      'After resolving, stage the files with `git add` and commit with:',
      `git commit -m "Resolve merge conflicts for task #${displayNumber}"`,
      'Do NOT push. Just resolve and commit.'
    ].join(' ');

    execFileSync('claude', [
      '-p', prompt,
      '--allowedTools', 'Bash(git *),Read,Edit,Write,Glob,Grep',
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions'
    ], {
      cwd: worktreePath,
      timeout: 120000,  // 2 min for conflict resolution
      stdio: 'pipe'
    });

    // Verify the merge completed (no unmerged files remaining)
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        timeout: 10000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).toString();

      if (status.includes('UU ') || status.includes('AA ') || status.includes('DD ')) {
        logError(`Conflicts not fully resolved for #${displayNumber}`);
        try { execFileSync('git', ['merge', '--abort'], { cwd: worktreePath, stdio: 'pipe' }); } catch {}
        cleanupWorktree(displayNumber, projectPath);
        return false;
      }
    } catch {
      try { execFileSync('git', ['merge', '--abort'], { cwd: worktreePath, stdio: 'pipe' }); } catch {}
      cleanupWorktree(displayNumber, projectPath);
      return false;
    }

    // Push the resolved branch
    execFileSync('git', ['push', 'origin', branch], {
      cwd: worktreePath,
      timeout: 30000,
      stdio: 'pipe'
    });

    log(`Conflict resolution pushed for task #${displayNumber}`);
    cleanupWorktree(displayNumber, projectPath);
    return true;
  } catch (e) {
    logError(`Conflict resolution failed for #${displayNumber}: ${e.message}`);
    try { execFileSync('git', ['merge', '--abort'], { cwd: worktreePath, stdio: 'pipe' }); } catch {}
    cleanupWorktree(displayNumber, projectPath);
    return false;
  }
}

/**
 * Mark a task as completed via the todo-status endpoint.
 */
async function markTaskAsCompleted(displayNumber, taskId, comment) {
  try {
    const response = await apiRequest('todo-status', {
      method: 'PATCH',
      body: JSON.stringify({
        todoId: taskId,
        isCompleted: true,
        completedAt: new Date().toISOString(),
        completionComment: comment || `Completed by daemon on ${getMachineName()}`
      })
    });
    if (response.ok) {
      log(`Task #${displayNumber} marked as completed`);
      return true;
    }
    logError(`Failed to mark #${displayNumber} complete: HTTP ${response.status}`);
    return false;
  } catch (error) {
    logError(`Failed to mark #${displayNumber} complete: ${error.message}`);
    return false;
  }
}

async function hasApprovedConfirmation(displayNumber) {
  try {
    const response = await apiRequest(`synced-todos?display_number=${displayNumber}`);
    if (!response.ok) return false;
    const data = await response.json();
    const todos = data.todos || [];
    if (todos.length === 0) return false;
    const events = parseJsonField(todos[0].executionEventsJson);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'confirmation_approved') return true;
      if (events[i].type === 'confirmation_rejected') return false;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Auto-heal: detect if a previous execution already completed work for this task.
 * Checks for existing branch commits and PRs to avoid redundant re-execution.
 * Returns true if the task was healed (status updated, no re-execution needed).
 */
async function autoHealExistingWork(displayNumber, summary, projectPath, taskId) {
  const branch = getBranchName(displayNumber);
  const legacyBranch = `push-${displayNumber}-${getWorktreeSuffix()}`;
  const gitCwd = projectPath || process.cwd();

  try {
    // Check if branch has commits ahead of main (try new name, then legacy)
    let hasCommits = false;
    let activeBranch = branch;
    try {
      const logResult = execSync(
        `git log HEAD..origin/${branch} --oneline 2>/dev/null || git log HEAD..${branch} --oneline 2>/dev/null`,
        { cwd: gitCwd, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }
      ).toString().trim();
      hasCommits = logResult.length > 0;
    } catch {
      // New branch doesn't exist — try legacy branch from pre-migration daemon
      try {
        const legacyResult = execSync(
          `git log HEAD..origin/${legacyBranch} --oneline 2>/dev/null || git log HEAD..${legacyBranch} --oneline 2>/dev/null`,
          { cwd: gitCwd, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }
        ).toString().trim();
        if (legacyResult.length > 0) {
          hasCommits = true;
          activeBranch = legacyBranch;
          log(`Task #${displayNumber}: found work on legacy branch ${legacyBranch}`);
        }
      } catch {
        // Neither branch exists — no previous work
        return false;
      }
    }

    if (!hasCommits) {
      return false;
    }

    log(`Task #${displayNumber}: found existing commits on branch ${activeBranch}`);

    // Check for existing PR
    let prUrl = null;
    let prState = null;
    try {
      const prResult = execSync(
        `gh pr list --head ${activeBranch} --state all --json url,state --jq '.[0]' 2>/dev/null`,
        { cwd: gitCwd, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
      ).toString().trim();
      if (prResult) {
        const pr = JSON.parse(prResult);
        prUrl = pr.url;
        prState = pr.state; // OPEN or MERGED
      }
    } catch {
      // gh not available or no PR found
    }

    if (prUrl && prState === 'MERGED') {
      // PR already merged — task is fully done
      log(`Task #${displayNumber}: PR already merged (${prUrl}), updating status`);
      const executionSummary = `Auto-healed: previous execution completed and PR merged. PR: ${prUrl}`;
      await updateTaskStatus(displayNumber, 'session_finished', {
        summary: executionSummary
      });

      // Auto-complete since PR is already merged
      let status = 'session_finished';
      if (getAutoCompleteEnabled() && taskId) {
        const comment = `Auto-healed: PR already merged. ${prUrl}`;
        const completed = await markTaskAsCompleted(displayNumber, taskId, comment);
        if (completed) {
          log(`Task #${displayNumber}: auto-completed (PR was already merged)`);
          status = 'completed';
        }
      }

      trackCompleted({
        displayNumber, summary,
        completedAt: new Date().toISOString(),
        duration: 0, status, prUrl
      });
      return true;
    }

    if (prUrl && prState === 'OPEN') {
      log(`Task #${displayNumber}: PR already open (${prUrl}), attempting merge`);

      // Try to merge the existing PR
      let merged = false;
      if (getAutoMergeEnabled()) {
        // Clean up worktree first so gh pr merge --delete-branch can delete the local branch
        cleanupWorktree(displayNumber, projectPath);
        merged = mergePRForTask(displayNumber, prUrl, projectPath);
      }

      const executionSummary = merged
        ? `Auto-healed: previous PR merged. ${prUrl}`
        : `Auto-healed: previous execution completed. PR pending review: ${prUrl}`;
      await updateTaskStatus(displayNumber, 'session_finished', {
        summary: executionSummary
      });

      // Auto-complete if merge succeeded
      let status = 'session_finished';
      if (getAutoCompleteEnabled() && merged && taskId) {
        const comment = `Auto-healed and merged. ${prUrl}`;
        const completed = await markTaskAsCompleted(displayNumber, taskId, comment);
        if (completed) {
          log(`Task #${displayNumber}: auto-completed after auto-heal merge`);
          status = 'completed';
        }
      }

      trackCompleted({
        displayNumber, summary,
        completedAt: new Date().toISOString(),
        duration: 0, status, prUrl
      });
      return true;
    }

    if (!prUrl) {
      // Commits exist but no PR — create one and update status
      log(`Task #${displayNumber}: commits exist but no PR, creating PR`);
      const newPrUrl = createPRForTask(displayNumber, summary, projectPath);
      if (newPrUrl) {
        const executionSummary = `Auto-healed: previous execution had uncommitted PR. Created PR: ${newPrUrl}`;
        await updateTaskStatus(displayNumber, 'session_finished', {
          summary: executionSummary
        });
        trackCompleted({
          displayNumber, summary,
          completedAt: new Date().toISOString(),
          duration: 0, status: 'session_finished', prUrl: newPrUrl
        });
        return true;
      }
      // PR creation failed — fall through to re-execute
      log(`Task #${displayNumber}: PR creation failed, will re-execute`);
    }

    return false;
  } catch (error) {
    log(`Task #${displayNumber}: auto-heal check failed: ${error.message}`);
    return false;
  }
}

// ==================== Stuck Detection ====================

function checkStuckPatterns(displayNumber, line) {
  const lineLower = line.toLowerCase();

  for (const pattern of STUCK_PATTERNS) {
    if (lineLower.includes(pattern.toLowerCase())) {
      return `Detected: '${pattern}'`;
    }
  }

  return null;
}

// ==================== Stream-JSON Parsing (Phase 1) ====================

function parseStreamJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text)
    .join('\n');
}

function extractToolCallsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => block.type === 'tool_use')
    .map(block => ({ name: block.name, input: block.input || {} }));
}

function processStreamEvent(displayNumber, event) {
  if (!event || !event.type) return;

  const activity = taskActivityState.get(displayNumber) || {
    filesRead: new Set(),
    filesEdited: new Set(),
    currentTool: null,
    lastText: '',
    sessionId: null
  };

  // Extract session_id from system init or result messages
  if (event.type === 'system' && event.session_id) {
    activity.sessionId = event.session_id;
  }
  if (event.type === 'result' && event.session_id) {
    activity.sessionId = event.session_id;
  }

  // Extract activity from assistant messages
  if (event.type === 'assistant') {
    const content = event.message?.content;
    if (!content) { taskActivityState.set(displayNumber, activity); return; }

    const text = extractTextFromContent(content);
    if (text) {
      activity.lastText = text.slice(0, 200);

      // Run existing text-based checks on extracted content
      if (text.includes('[push-confirm] Waiting for')) {
        updateTaskDetail(displayNumber, {
          phase: 'awaiting_confirmation',
          detail: 'Waiting for user confirmation on iPhone'
        });
      }

      const stuckReason = checkStuckPatterns(displayNumber, text);
      if (stuckReason) {
        log(`Task #${displayNumber} may be stuck: ${stuckReason}`);
        updateTaskDetail(displayNumber, {
          phase: 'stuck',
          detail: `Waiting for input: ${stuckReason}`
        });
      }
    }

    const toolCalls = extractToolCallsFromContent(content);
    for (const tool of toolCalls) {
      activity.currentTool = tool.name;
      const filePath = tool.input?.file_path || tool.input?.path;
      if (filePath) {
        if (tool.name === 'Read') {
          activity.filesRead.add(filePath);
        } else if (tool.name === 'Edit' || tool.name === 'Write') {
          activity.filesEdited.add(filePath);
        }
      }
    }
  }

  taskActivityState.set(displayNumber, activity);

  // Throttled progress reporting to Supabase
  maybesSendStreamProgress(displayNumber, activity);
}

function maybesSendStreamProgress(displayNumber, activity) {
  const now = Date.now();
  const lastSent = taskLastStreamProgress.get(displayNumber) || 0;
  if (now - lastSent < STREAM_PROGRESS_THROTTLE_MS) return;
  taskLastStreamProgress.set(displayNumber, now);

  const info = taskDetails.get(displayNumber) || {};
  const taskId = info.taskId || null;
  const taskInfo = runningTasks.get(displayNumber);
  if (!taskInfo) return;

  const elapsedSec = Math.floor((now - taskInfo.startTime) / 1000);
  const elapsedMin = Math.floor(elapsedSec / 60);

  // Build a meaningful summary from stream activity
  const parts = [`Running for ${elapsedMin}m.`];
  if (activity.filesEdited.size > 0) {
    const editedList = [...activity.filesEdited].map(f => f.split('/').pop()).slice(-5);
    parts.push(`Edited: ${editedList.join(', ')}`);
  }
  if (activity.filesRead.size > 0) {
    parts.push(`Read ${activity.filesRead.size} files.`);
  }
  if (activity.currentTool) {
    parts.push(`Current: ${activity.currentTool}`);
  }
  if (activity.lastText && !activity.currentTool) {
    parts.push(activity.lastText.slice(0, 80));
  }

  const eventSummary = parts.join(' ');

  log(`Task #${displayNumber}: stream progress (${eventSummary})`);

  // Also update the existing heartbeat timestamp to prevent duplicate generic heartbeats
  taskLastHeartbeat.set(displayNumber, now);

  apiRequest('update-task-execution', {
    method: 'PATCH',
    body: JSON.stringify({
      todoId: taskId,
      displayNumber,
      event: {
        type: 'progress',
        timestamp: new Date().toISOString(),
        machineName: getMachineName() || undefined,
        summary: eventSummary,
        filesEdited: [...activity.filesEdited].slice(-10),
        filesRead: activity.filesRead.size
      }
    })
  }).then(async (response) => {
    // Check for cancellation signal in response
    const result = await response.json().catch(() => null);
    if (result?.status === 'cancelling') {
      handleCancellation(displayNumber, 'stream_progress');
    }
  }).catch(err => {
    log(`Task #${displayNumber}: stream progress failed (non-fatal): ${err.message}`);
  });
}

// ==================== Cancellation (Phase 2) ====================

function handleCancellation(displayNumber, source) {
  const taskInfo = runningTasks.get(displayNumber);
  if (!taskInfo) return;

  log(`Task #${displayNumber}: cancellation detected via ${source}, sending SIGTERM`);

  try {
    taskInfo.process.kill('SIGTERM');
  } catch (err) {
    log(`Task #${displayNumber}: SIGTERM failed: ${err.message}`);
  }

  // Mark as cancelled so handleTaskCompletion reports the right reason
  updateTaskDetail(displayNumber, {
    phase: 'cancelled',
    detail: 'Cancelled by user'
  });
}

// ==================== Message Injection (Phase 4) ====================

const MESSAGE_POLL_INTERVAL_MS = 30000; // Check for messages every 30s
let lastMessagePoll = 0;

/**
 * Poll for urgent messages directed to running tasks.
 * Called from checkTimeouts() on each poll cycle.
 *
 * Normal messages: agent picks up via push-todo --check-messages at natural pauses.
 * Urgent messages: daemon kills the session and respawns with --continue + injected message.
 */
async function checkUrgentMessages() {
  const now = Date.now();
  if (now - lastMessagePoll < MESSAGE_POLL_INTERVAL_MS) return;
  lastMessagePoll = now;

  if (runningTasks.size === 0) return;

  for (const [displayNumber, taskInfo] of runningTasks) {
    const info = taskDetails.get(displayNumber) || {};
    const taskId = info.taskId;
    if (!taskId) continue;

    // Skip tasks already being cancelled or injected
    if (info.phase === 'cancelled' || info.phase === 'injecting_message') continue;

    try {
      const params = new URLSearchParams({
        todo_id: taskId,
        direction: 'to_agent',
      });

      const response = await apiRequest(`task-messages?${params}`, {}, false);
      if (!response.ok) continue;

      const data = await response.json();
      const messages = data.messages || [];

      // Only process urgent messages via kill+continue
      const urgentMessages = messages.filter(m => m.is_urgent || m.type === 'urgent');
      if (urgentMessages.length === 0) continue;

      // Combine all urgent messages into one injection
      const combinedMessage = urgentMessages
        .map(m => m.message)
        .join('\n\n');

      log(`Task #${displayNumber}: ${urgentMessages.length} urgent message(s) detected, initiating kill+continue`);

      // Mark messages as read
      for (const msg of urgentMessages) {
        apiRequest('task-messages', {
          method: 'PATCH',
          body: JSON.stringify({ message_id: msg.id }),
        }).catch(() => {}); // fire-and-forget
      }

      // Kill the current session and respawn with injected message
      await injectMessageViaKillContinue(displayNumber, combinedMessage);
    } catch (err) {
      log(`Task #${displayNumber}: message poll failed (non-fatal): ${err.message}`);
    }
  }
}

/**
 * Kill the current Claude session and respawn with --continue, injecting a human message.
 *
 * Flow:
 * 1. SIGTERM the running process
 * 2. Wait for it to exit (handleTaskCompletion sees phase='injecting_message' and skips cleanup)
 * 3. Respawn with `claude --continue <sessionId> -p "Human sent: <message>"`
 *
 * The ~12s penalty is for Claude to reload context from the session transcript.
 */
async function injectMessageViaKillContinue(displayNumber, message) {
  const taskInfo = runningTasks.get(displayNumber);
  if (!taskInfo) return;

  const sessionId = taskInfo.sessionId;
  const projectPath = taskInfo.projectPath || taskProjectPaths.get(displayNumber);
  const info = taskDetails.get(displayNumber) || {};
  const taskId = info.taskId;

  // Mark phase so handleTaskCompletion knows to respawn instead of cleaning up
  updateTaskDetail(displayNumber, {
    phase: 'injecting_message',
    detail: `Injecting message: ${message.slice(0, 50)}...`
  });

  // Report the injection event to Supabase
  apiRequest('update-task-execution', {
    method: 'PATCH',
    body: JSON.stringify({
      todoId: taskId,
      displayNumber,
      event: {
        type: 'message_injected',
        timestamp: new Date().toISOString(),
        machineName: getMachineName() || undefined,
        summary: `Human message injected: ${message.slice(0, 100)}`,
      }
    })
  }).catch(() => {});

  // Store the message for respawn (handleTaskCompletion will read this)
  taskInfo.pendingInjection = { message, sessionId, projectPath, taskId };

  // Kill the current process
  try {
    taskInfo.process.kill('SIGTERM');
  } catch (err) {
    log(`Task #${displayNumber}: SIGTERM for injection failed: ${err.message}`);
    // Reset phase if kill failed
    updateTaskDetail(displayNumber, { phase: 'executing' });
    delete taskInfo.pendingInjection;
  }
}

/**
 * Respawn a Claude session after kill, with the human message injected.
 * Called from handleTaskCompletion when phase === 'injecting_message'.
 */
function respawnWithInjectedMessage(displayNumber) {
  const taskInfo = runningTasks.get(displayNumber);
  if (!taskInfo || !taskInfo.pendingInjection) {
    log(`Task #${displayNumber}: no pending injection found, cannot respawn`);
    return;
  }

  const { message, sessionId, projectPath, taskId } = taskInfo.pendingInjection;
  delete taskInfo.pendingInjection;

  const injectionPrompt = `IMPORTANT: The human sent you an urgent message while you were working:\n\n---\n${message}\n---\n\nPlease address this message and then continue with your task.`;

  const allowedTools = [
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Bash(git *)',
    'Bash(npm *)', 'Bash(npx *)', 'Bash(yarn *)',
    'Bash(python *)', 'Bash(python3 *)', 'Bash(pip *)', 'Bash(pip3 *)',
    'Bash(push-todo *)',
    'Task'
  ].join(',');

  // Generate new session ID for the respawned session
  const newSessionId = randomUUID();

  const claudeArgs = [
    '--continue', sessionId,
    '-p', injectionPrompt,
    '--allowedTools', allowedTools,
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--session-id', newSessionId,
  ];

  log(`Task #${displayNumber}: respawning with injected message (session: ${sessionId} -> ${newSessionId})`);

  try {
    const child = spawn('claude', claudeArgs, {
      cwd: projectPath || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => {
        const env = { ...process.env, PUSH_TASK_ID: taskId, PUSH_DISPLAY_NUMBER: String(displayNumber) };
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        return env;
      })()
    });

    // Replace the old process info
    taskInfo.process = child;
    taskInfo.sessionId = newSessionId;
    taskInfo.startTime = taskInfo.startTime; // Keep original start time

    // Re-initialize stream parsing state
    taskStreamLineBuffer.set(displayNumber, '');
    taskActivityState.set(displayNumber, {
      filesRead: new Set(), filesEdited: new Set(),
      currentTool: null, lastText: '', sessionId: null
    });
    taskLastStreamProgress.set(displayNumber, Date.now());
    taskLastOutput.set(displayNumber, Date.now());
    taskStdoutBuffer.set(displayNumber, []);
    taskStderrBuffer.set(displayNumber, []);
    taskLastHeartbeat.set(displayNumber, Date.now());

    // Re-attach stdout handler (same as executeTask)
    child.stdout.on('data', (data) => {
      taskLastOutput.set(displayNumber, Date.now());

      const pending = (taskStreamLineBuffer.get(displayNumber) || '') + data.toString();
      const lines = pending.split('\n');
      taskStreamLineBuffer.set(displayNumber, lines.pop() || '');

      for (const line of lines) {
        if (!line.trim()) continue;

        const buffer = taskStdoutBuffer.get(displayNumber) || [];
        buffer.push(line);
        if (buffer.length > 50) buffer.shift();
        taskStdoutBuffer.set(displayNumber, buffer);

        const event = parseStreamJsonLine(line);
        if (event) {
          processStreamEvent(displayNumber, event);
        } else {
          if (line.includes('[push-confirm] Waiting for')) {
            updateTaskDetail(displayNumber, {
              phase: 'awaiting_confirmation',
              detail: 'Waiting for user confirmation on iPhone'
            });
          }
          const stuckReason = checkStuckPatterns(displayNumber, line);
          if (stuckReason) {
            log(`Task #${displayNumber} may be stuck: ${stuckReason}`);
            updateTaskDetail(displayNumber, { phase: 'stuck', detail: `Waiting for input: ${stuckReason}` });
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          const buffer = taskStderrBuffer.get(displayNumber) || [];
          buffer.push(line);
          if (buffer.length > 20) buffer.shift();
          taskStderrBuffer.set(displayNumber, buffer);
        }
      }
    });

    child.on('close', (code) => {
      handleTaskCompletion(displayNumber, code);
    });

    child.on('error', async (error) => {
      logError(`Task #${displayNumber} respawn error: ${error.message}`);
      runningTasks.delete(displayNumber);
      await updateTaskStatus(displayNumber, 'failed', { error: `Respawn failed: ${error.message}` }, taskId);
      taskDetails.delete(displayNumber);
      taskLastHeartbeat.delete(displayNumber);
      taskStreamLineBuffer.delete(displayNumber);
      taskActivityState.delete(displayNumber);
      taskLastStreamProgress.delete(displayNumber);
      updateStatusFile();
    });

    updateTaskDetail(displayNumber, {
      phase: 'executing',
      detail: 'Resumed with injected message',
      claudePid: child.pid
    });

    // Update session ID in Supabase
    apiRequest('update-task-execution', {
      method: 'PATCH',
      body: JSON.stringify({
        todoId: taskId,
        displayNumber,
        sessionId: newSessionId,
        event: {
          type: 'progress',
          timestamp: new Date().toISOString(),
          machineName: getMachineName() || undefined,
          summary: `Respawned with injected human message (new session: ${newSessionId.slice(0, 8)})`,
        }
      })
    }).catch(() => {});

    log(`Task #${displayNumber}: respawned successfully (PID: ${child.pid})`);
  } catch (error) {
    logError(`Task #${displayNumber}: respawn failed: ${error.message}`);
    // Clean up — task is effectively dead
    runningTasks.delete(displayNumber);
    updateTaskStatus(displayNumber, 'failed', {
      error: `Message injection respawn failed: ${error.message}`
    }, taskId).catch(() => {});
    taskDetails.delete(displayNumber);
    taskStreamLineBuffer.delete(displayNumber);
    taskActivityState.delete(displayNumber);
    taskLastStreamProgress.delete(displayNumber);
    updateStatusFile();
  }
}

function monitorTaskStdout(displayNumber, proc) {
  if (!proc.stdout) return;

  // Initialize tracking
  if (!taskLastOutput.has(displayNumber)) {
    taskLastOutput.set(displayNumber, Date.now());
  }
  if (!taskStdoutBuffer.has(displayNumber)) {
    taskStdoutBuffer.set(displayNumber, []);
  }

  // Non-blocking check for available data
  proc.stdout.once('readable', () => {
    let chunk;
    while ((chunk = proc.stdout.read()) !== null) {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        taskLastOutput.set(displayNumber, Date.now());

        // Keep last 20 lines
        const buffer = taskStdoutBuffer.get(displayNumber);
        buffer.push(line);
        if (buffer.length > 20) buffer.shift();

        // Check for stuck patterns
        const stuckReason = checkStuckPatterns(displayNumber, line);
        if (stuckReason) {
          log(`Task #${displayNumber} may be stuck: ${stuckReason}`);
          log(`  Line: ${line.slice(0, 100)}...`);

          updateTaskDetail(displayNumber, {
            phase: 'stuck',
            detail: `Waiting for input: ${stuckReason}`
          });

          if (NOTIFY_ON_NEEDS_INPUT) {
            const info = taskDetails.get(displayNumber) || {};
            sendMacNotification(
              `Task #${displayNumber} needs input`,
              `${info.summary?.slice(0, 40) || 'Unknown'}... ${stuckReason}`,
              'Ping'
            );
          }
        }
      }
    }
  });
}

function checkTaskIdle(displayNumber) {
  // Skip idle check for tasks awaiting user confirmation
  const info = taskDetails.get(displayNumber) || {};
  if (info.phase === 'awaiting_confirmation') return false;

  const lastOutput = taskLastOutput.get(displayNumber);
  if (!lastOutput) return false;

  const elapsed = Date.now() - lastOutput;

  if (elapsed > STUCK_IDLE_THRESHOLD) {
    log(`Task #${displayNumber} has been idle for ${Math.floor(elapsed / 1000)}s`);
    return true;
  }

  if (elapsed > STUCK_WARNING_THRESHOLD) {
    log(`Task #${displayNumber} idle warning: ${Math.floor(elapsed / 1000)}s since last output`);
  }

  return false;
}

// ==================== Progress Heartbeat (Level A) ====================

async function sendProgressHeartbeats() {
  const now = Date.now();

  for (const [displayNumber, taskInfo] of runningTasks) {
    const info = taskDetails.get(displayNumber) || {};

    // Skip tasks awaiting user confirmation (not truly hanging)
    if (info.phase === 'awaiting_confirmation') continue;

    // Throttle: only send every HEARTBEAT_INTERVAL_MS
    const lastHeartbeat = taskLastHeartbeat.get(displayNumber) || taskInfo.startTime;
    if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) continue;

    // Compute metrics
    const elapsedSec = Math.floor((now - taskInfo.startTime) / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const lastOutputTs = taskLastOutput.get(displayNumber);
    const idleSec = lastOutputTs ? Math.floor((now - lastOutputTs) / 1000) : elapsedSec;
    const idleMin = Math.floor(idleSec / 60);

    const activityDesc = idleSec < 60 ? 'active' : `idle ${idleMin}m`;
    const phase = info.phase || 'executing';

    // Enrich heartbeat with stream activity data when available
    const activity = taskActivityState.get(displayNumber);
    const parts = [`Running for ${elapsedMin}m. Last activity: ${activityDesc}. Phase: ${phase}.`];
    const eventExtra = {};
    if (activity) {
      if (activity.filesEdited.size > 0) {
        const editedList = [...activity.filesEdited].map(f => f.split('/').pop()).slice(-5);
        parts.push(`Edited: ${editedList.join(', ')}`);
        eventExtra.filesEdited = [...activity.filesEdited].slice(-10);
      }
      if (activity.filesRead.size > 0) {
        parts.push(`Read ${activity.filesRead.size} files.`);
        eventExtra.filesRead = activity.filesRead.size;
      }
    }
    const eventSummary = parts.join(' ');

    log(`Task #${displayNumber}: sending progress heartbeat (${eventSummary})`);

    // Update throttle timestamp BEFORE the async call to prevent concurrent sends
    taskLastHeartbeat.set(displayNumber, now);

    // Send event-only update (no status field) — non-fatal if it fails
    const taskId = info.taskId || null;
    apiRequest('update-task-execution', {
      method: 'PATCH',
      body: JSON.stringify({
        todoId: taskId,
        displayNumber,
        event: {
          type: 'progress',
          timestamp: new Date().toISOString(),
          machineName: getMachineName() || undefined,
          summary: eventSummary,
          ...eventExtra
        }
        // No status field — event-only update, won't change execution_status
      })
    }).then(async (response) => {
      // Check for cancellation signal in heartbeat response
      const result = await response.json().catch(() => null);
      if (result?.status === 'cancelling') {
        handleCancellation(displayNumber, 'heartbeat');
      }
    }).catch(err => {
      log(`Task #${displayNumber}: heartbeat failed (non-fatal): ${err.message}`);
    });
    // NOTE: intentionally not awaited — heartbeats are fire-and-forget
    // to avoid blocking the poll loop when Supabase is slow
  }
}

// ==================== Idle Auto-Recovery (Level B) ====================

async function killIdleTasks() {
  const now = Date.now();
  const idleTimedOut = [];

  for (const [displayNumber, taskInfo] of runningTasks) {
    const info = taskDetails.get(displayNumber) || {};

    // Exempt: tasks awaiting user confirmation
    if (info.phase === 'awaiting_confirmation') continue;

    const lastOutput = taskLastOutput.get(displayNumber);
    if (!lastOutput) continue; // No output tracking yet — not idle, just starting

    const idleMs = now - lastOutput;
    if (idleMs > IDLE_TIMEOUT_MS) {
      log(`Task #${displayNumber} IDLE TIMEOUT: ${Math.floor(idleMs / 1000)}s since last output`);
      idleTimedOut.push(displayNumber);
    }
  }

  for (const displayNumber of idleTimedOut) {
    const taskInfo = runningTasks.get(displayNumber);
    if (!taskInfo) continue;

    const info = taskDetails.get(displayNumber) || {};
    const projectPath = taskProjectPaths.get(displayNumber);
    const elapsedSec = Math.floor((now - taskInfo.startTime) / 1000);
    const idleSec = Math.floor((now - (taskLastOutput.get(displayNumber) || taskInfo.startTime)) / 1000);
    const durationStr = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
    const machineName = getMachineName() || 'Mac';

    // Extract semantic summary WHILE session is still alive
    // (a live session produces a better "what have you done so far" answer)
    const sessionId = taskInfo.sessionId;
    const worktreePath = getWorktreePath(displayNumber, projectPath);
    const summaryPath = existsSync(worktreePath) ? worktreePath : (projectPath || process.cwd());
    log(`Task #${displayNumber}: extracting pre-kill summary...`);
    const idleSummary = extractSemanticSummary(summaryPath, sessionId);

    // Now kill the process
    log(`Task #${displayNumber}: killing idle process (PID: ${taskInfo.process.pid})`);
    try {
      taskInfo.process.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 5000));
      taskInfo.process.kill('SIGKILL');
    } catch {}

    runningTasks.delete(displayNumber);
    cleanupWorktree(displayNumber, projectPath);

    const idleError = idleSummary
      ? `${idleSummary}\nSession went idle for ${Math.floor(idleSec / 60)}m with no output. Killed after ${durationStr} on ${machineName}.`
      : `Session went idle for ${Math.floor(idleSec / 60)}m with no output (limit: ${IDLE_TIMEOUT_MS / 60000}m). Killed after ${durationStr} on ${machineName}.`;

    await updateTaskStatus(displayNumber, 'failed', {
      error: idleError,
      sessionId
    }, info.taskId);

    if (NOTIFY_ON_FAILURE) {
      sendMacNotification(
        `Task #${displayNumber} idle timeout`,
        `${(info.summary || 'Unknown').slice(0, 40)}... idle ${Math.floor(idleSec / 60)}m`,
        'Basso'
      );
    }

    trackCompleted({
      displayNumber,
      summary: info.summary || 'Unknown task',
      completedAt: new Date().toISOString(),
      duration: elapsedSec,
      status: 'idle_timeout'
    });

    // Full cleanup of all tracking Maps
    taskDetails.delete(displayNumber);
    taskLastOutput.delete(displayNumber);
    taskStdoutBuffer.delete(displayNumber);
    taskStderrBuffer.delete(displayNumber);
    taskProjectPaths.delete(displayNumber);
    taskLastHeartbeat.delete(displayNumber);
    taskStreamLineBuffer.delete(displayNumber);
    taskActivityState.delete(displayNumber);
    taskLastStreamProgress.delete(displayNumber);
  }

  if (idleTimedOut.length > 0) {
    updateStatusFile();
  }
}

// ==================== Session ID Extraction ====================

function extractSessionIdFromStdout(proc, buffer, displayNumber) {
  // First: check stream activity state (populated by stream-json parsing)
  if (displayNumber != null) {
    const activity = taskActivityState.get(displayNumber);
    if (activity?.sessionId) return activity.sessionId;
  }

  // Fallback: drain remaining stdout and scan for session_id in JSON lines
  let remaining = '';
  if (proc.stdout) {
    try {
      remaining = proc.stdout.read()?.toString() || '';
    } catch {}
  }

  const allOutput = buffer.join('\n') + '\n' + remaining;

  for (const line of allOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.includes('session_id')) {
      try {
        const data = JSON.parse(trimmed);
        if (data.session_id) return data.session_id;
      } catch {}
    }
  }

  // Try parsing whole output as JSON
  try {
    const data = JSON.parse(allOutput.trim());
    return data.session_id || null;
  } catch {}

  return null;
}

// ==================== Semantic Summary Extraction ====================

/**
 * Generate a semantic summary by resuming the Claude session in --print mode.
 * Claude already has full context of what it did — we just ask it to summarize.
 * Uses execFileSync (not execSync) to avoid shell injection.
 *
 * @param {string} worktreePath - Path to the git worktree where Claude ran
 * @param {string} sessionId - Claude session ID
 * @returns {string|null} A short semantic summary, or null if extraction fails
 */
function extractSemanticSummary(worktreePath, sessionId) {
  if (!worktreePath || !sessionId) return null;

  try {
    const result = execFileSync('claude', [
      '--resume', sessionId,
      '--print',
      'Summarize what you accomplished in 1-2 sentences. Be specific about outcomes (what was built, fixed, drafted), not process. If you failed or got stuck, explain what went wrong. If no code changes were made, say so. Do not use markdown.'
    ], {
      cwd: worktreePath,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const summary = result.toString().trim();
    if (summary && summary.length > 0) {
      // Cap at 300 chars to keep it concise
      return summary.length > 300 ? summary.slice(0, 297) + '...' : summary;
    }
    return null;
  } catch (error) {
    log(`Semantic summary extraction failed: ${error.message}`);
    return null;
  }
}

/**
 * Ask Claude to generate a Mermaid diagram of the key change it made.
 * Uses the same session-resume pattern as extractSemanticSummary.
 *
 * @param {string} worktreePath - Path to the git worktree where Claude ran
 * @param {string} sessionId - Claude session ID
 * @returns {string|null} Mermaid diagram source code, or null if extraction fails
 */
function extractVisualArtifact(worktreePath, sessionId) {
  if (!worktreePath || !sessionId) return null;

  try {
    const result = execFileSync('claude', [
      '--resume', sessionId,
      '--print',
      'Generate a Mermaid diagram showing the key architectural change or flow you implemented. ' +
      'Use graph LR for component relationships, sequenceDiagram for API/data flow, ' +
      'or gitGraph for branch operations. Keep it simple (5-10 nodes max). ' +
      'Output ONLY the raw Mermaid code. No markdown fences, no explanation, no comments.'
    ], {
      cwd: worktreePath,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const mermaid = result.toString().trim();
    if (!mermaid || mermaid.length === 0) return null;

    // Validate: must start with a known Mermaid diagram keyword
    const validStarts = ['graph ', 'graph\n', 'flowchart ', 'flowchart\n',
      'sequenceDiagram', 'gitGraph', 'classDiagram', 'stateDiagram',
      'erDiagram', 'gantt', 'pie'];
    if (!validStarts.some(s => mermaid.startsWith(s))) {
      log(`Visual artifact extraction returned non-Mermaid content, skipping`);
      return null;
    }

    // Cap at 2000 chars — diagrams beyond this are too complex to be useful
    return mermaid.length > 2000 ? mermaid.slice(0, 2000) : mermaid;
  } catch (error) {
    log(`Visual artifact extraction failed: ${error.message}`);
    return null;
  }
}

// ==================== Task Execution ====================

function updateTaskDetail(displayNumber, updates) {
  const current = taskDetails.get(displayNumber) || {};
  taskDetails.set(displayNumber, { ...current, ...updates });
  updateStatusFile();
}

async function executeTask(task) {
  // Decrypt E2EE fields
  task = decryptTaskFields(task);

  const displayNumber = task.displayNumber || task.display_number;
  const gitRemote = task.gitRemote || task.git_remote;
  const taskActionType = task.actionType || task.action_type || null;
  const summary = task.summary || 'No summary';
  const content = task.normalizedContent || task.normalized_content ||
    task.content || task.summary || 'Work on this task';

  if (!displayNumber) {
    log('Task has no display number, skipping');
    return null;
  }

  if (runningTasks.has(displayNumber)) {
    log(`Task #${displayNumber} already running, skipping`);
    return null;
  }

  if (runningTasks.size >= MAX_CONCURRENT_TASKS) {
    log(`Max concurrent tasks (${MAX_CONCURRENT_TASKS}) reached, skipping #${displayNumber}`);
    return null;
  }

  // Extract UUID early — needed for claim and all status updates
  const taskId = task.id || task.todo_id || '';

  // Get project path + metadata (use action_type for multi-agent routing)
  let projectPath = null;
  let actionName = null;
  if (gitRemote) {
    const projectInfo = getProjectInfo(gitRemote, taskActionType);
    if (!projectInfo || !projectInfo.path) {
      log(`Task #${displayNumber}: Project not registered: ${gitRemote}`);
      log("Run '/push-todo connect' in the project directory to register");
      return null;
    }
    projectPath = projectInfo.path;
    actionName = projectInfo.actionName;

    if (!existsSync(projectPath)) {
      logError(`Task #${displayNumber}: Project path does not exist: ${projectPath}`);
      await updateTaskStatus(displayNumber, 'failed', {
        error: `Project path not found: ${projectPath}`
      }, taskId);
      return null;
    }

    log(`Task #${displayNumber}: Project ${gitRemote} -> ${projectPath}`);
  }

  // Pre-assign session ID so we can store it at claim time (not rely on parsing stdout)
  const preAssignedSessionId = randomUUID();

  // Atomic task claiming - must await to actually check the result
  if (!(await claimTask(displayNumber, taskId, preAssignedSessionId))) {
    log(`Task #${displayNumber}: claim failed, skipping`);
    return null;
  }
  // Follow-up: skip auto-heal when follow_up_request is set — the existing
  // branch/PR is intentional context, not evidence of completion.
  const followUpRequest = task.followUpRequest || task.follow_up_request || null;
  const followUpIteration = task.followUpIteration || task.follow_up_iteration || 1;
  const previousSessionId = task.executionSessionId || task.execution_session_id || null;
  const previousSummary = task.executionSummary || task.execution_summary || null;

  if (!followUpRequest) {
    const healed = await autoHealExistingWork(displayNumber, summary, projectPath, taskId);
    if (healed) {
      log(`Task #${displayNumber}: auto-healed from previous execution, skipping re-execution`);
      return null;
    }
  } else {
    log(`Task #${displayNumber}: follow-up iteration #${followUpIteration}, skipping auto-heal`);
  }

  // Track task details
  updateTaskDetail(displayNumber, {
    taskId,
    summary,
    status: 'running',
    phase: 'starting',
    detail: 'Starting Claude...',
    startedAt: Date.now(),
    gitRemote
  });

  log(`Executing task #${displayNumber}: ${content.slice(0, 60)}...`);

  // Worktree path — Claude Code's --worktree flag handles creation
  const worktreeName = getWorktreeName(displayNumber);
  const worktreePath = getWorktreePath(displayNumber, projectPath);

  taskProjectPaths.set(displayNumber, projectPath);

  // Build attachment context for the prompt (screenshots, links)
  let attachmentContext = '';
  try {
    const links = parseJsonField(task.linkAttachmentsJson || task.linkAttachments || task.link_attachments);
    const screenshots = parseJsonField(task.screenshotAttachmentsJson || task.screenshotAttachments || task.screenshot_attachments);
    const contextApp = task.contextApp || task.context_app || null;

    const parts = [];
    if (contextApp) {
      parts.push(`Context app: ${contextApp}`);
    }
    if (links.length > 0) {
      parts.push('Links:\n' + links.map(l => `  - ${l.url}${l.title ? ` (${l.title})` : ''}`).join('\n'));
    }
    if (screenshots.length > 0) {
      parts.push('Screenshots:\n' + screenshots.map(s =>
        `  - ${s.imageFilename || s.image_filename}${s.sourceApp ? ` (from ${s.sourceApp})` : ''}`
      ).join('\n'));
    }

    if (parts.length > 0) {
      attachmentContext = '\n\nAttachments:\n' + parts.join('\n');
    }
  } catch {
    // Non-critical — continue without attachment context
  }

  // Build context-rich prompt (skill scanning, project state, confirmation flags)
  if (projectPath) invalidateCache(projectPath); // Fresh context for each task
  const projectContext = projectPath ? getProjectContext(projectPath) : { skills: [], state: {} };
  const contextApp = task.contextApp || task.context_app || null;
  const prompt = buildSmartPrompt(
    { displayNumber, content, attachmentContext, actionName, contextApp,
      followUpRequest, followUpIteration, previousSummary },
    projectContext
  );

  // Note: claimTask() already set status to 'running' with atomic: true
  // No duplicate status update needed here (was causing race conditions)

  // Build Claude command
  const allowedTools = [
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Bash(git *)',
    'Bash(npm *)', 'Bash(npx *)', 'Bash(yarn *)',
    'Bash(python *)', 'Bash(python3 *)', 'Bash(pip *)', 'Bash(pip3 *)',
    'Bash(push-todo *)',
    'Task'
  ].join(',');

  // For follow-ups: try --continue with previous session for full context.
  // Falls back to new session with prompt context if session is stale/unavailable.
  const useResume = followUpRequest && previousSessionId;
  const claudeArgs = useResume
    ? [
        '--continue', previousSessionId,
        '-p', prompt,
        '--allowedTools', allowedTools,
        '--output-format', 'stream-json',
        '--permission-mode', 'bypassPermissions',
        '--session-id', preAssignedSessionId
      ]
    : [
        '-p', prompt,
        '--allowedTools', allowedTools,
        '--output-format', 'stream-json',
        '--permission-mode', 'bypassPermissions',
        '--session-id', preAssignedSessionId
      ];

  if (useResume) {
    log(`Task #${displayNumber}: resuming session ${previousSessionId} for follow-up`);
  }

  try {
    const child = spawn('claude', claudeArgs, {
      cwd: projectPath || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => {
        const env = { ...process.env, PUSH_TASK_ID: task.id, PUSH_DISPLAY_NUMBER: String(displayNumber) };
        delete env.CLAUDECODE;  // Strip to avoid "nested session" guard in Claude Code
        delete env.CLAUDE_CODE_ENTRYPOINT;  // Strip to avoid any entrypoint-based guards
        return env;
      })()
    });

    const taskInfo = {
      process: child,
      task,
      displayNumber,
      startTime: Date.now(),
      projectPath,
      sessionId: preAssignedSessionId
    };

    runningTasks.set(displayNumber, taskInfo);
    taskLastOutput.set(displayNumber, Date.now());
    taskStdoutBuffer.set(displayNumber, []);
    taskStderrBuffer.set(displayNumber, []);
    taskLastHeartbeat.set(displayNumber, Date.now());

    // Monitor stderr (critical for diagnosing fast exits)
    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          const buffer = taskStderrBuffer.get(displayNumber) || [];
          buffer.push(line);
          if (buffer.length > 20) buffer.shift();
          taskStderrBuffer.set(displayNumber, buffer);
        }
      }
    });

    // Monitor stdout (stream-json NDJSON parsing)
    taskStreamLineBuffer.set(displayNumber, '');
    taskActivityState.set(displayNumber, {
      filesRead: new Set(), filesEdited: new Set(),
      currentTool: null, lastText: '', sessionId: null
    });
    taskLastStreamProgress.set(displayNumber, Date.now());

    child.stdout.on('data', (data) => {
      taskLastOutput.set(displayNumber, Date.now());

      // NDJSON line buffering: handle chunks that split across line boundaries
      const pending = (taskStreamLineBuffer.get(displayNumber) || '') + data.toString();
      const lines = pending.split('\n');
      // Last element is either empty (chunk ended with \n) or a partial line
      taskStreamLineBuffer.set(displayNumber, lines.pop() || '');

      for (const line of lines) {
        if (!line.trim()) continue;

        // Keep raw lines in circular buffer for debugging/fallback
        const buffer = taskStdoutBuffer.get(displayNumber) || [];
        buffer.push(line);
        if (buffer.length > 50) buffer.shift();
        taskStdoutBuffer.set(displayNumber, buffer);

        // Parse as NDJSON stream event
        const event = parseStreamJsonLine(line);
        if (event) {
          processStreamEvent(displayNumber, event);
        } else {
          // Fallback: line isn't valid JSON — run legacy text checks
          if (line.includes('[push-confirm] Waiting for')) {
            updateTaskDetail(displayNumber, {
              phase: 'awaiting_confirmation',
              detail: 'Waiting for user confirmation on iPhone'
            });
          }
          const stuckReason = checkStuckPatterns(displayNumber, line);
          if (stuckReason) {
            log(`Task #${displayNumber} may be stuck: ${stuckReason}`);
            updateTaskDetail(displayNumber, {
              phase: 'stuck',
              detail: `Waiting for input: ${stuckReason}`
            });
          }
        }
      }
    });

    // Handle completion
    child.on('close', (code) => {
      handleTaskCompletion(displayNumber, code);
    });

    child.on('error', async (error) => {
      logError(`Task #${displayNumber} error: ${error.message}`);
      runningTasks.delete(displayNumber);
      await updateTaskStatus(displayNumber, 'failed', { error: error.message }, taskId);
      taskDetails.delete(displayNumber);
      taskLastHeartbeat.delete(displayNumber);
      taskStreamLineBuffer.delete(displayNumber);
      taskActivityState.delete(displayNumber);
      taskLastStreamProgress.delete(displayNumber);
      updateStatusFile();
    });

    updateTaskDetail(displayNumber, {
      phase: 'executing',
      detail: 'Running Claude...',
      claudePid: child.pid
    });

    log(`Started Claude for task #${displayNumber} (PID: ${child.pid})`);

    return taskInfo;
  } catch (error) {
    logError(`Error starting Claude for task #${displayNumber}: ${error.message}`);
    await updateTaskStatus(displayNumber, 'failed', { error: error.message }, taskId);
    taskDetails.delete(displayNumber);
    taskStreamLineBuffer.delete(displayNumber);
    taskActivityState.delete(displayNumber);
    taskLastStreamProgress.delete(displayNumber);
    return null;
  }
}

async function handleTaskCompletion(displayNumber, exitCode) {
  const taskInfo = runningTasks.get(displayNumber);
  if (!taskInfo) return;

  const info = taskDetails.get(displayNumber) || {};

  // Message injection: process was killed to inject a human message.
  // Don't clean up — respawn with --continue instead.
  if (info.phase === 'injecting_message' && taskInfo.pendingInjection) {
    log(`Task #${displayNumber}: process exited for message injection (code ${exitCode}), respawning...`);
    respawnWithInjectedMessage(displayNumber);
    return;
  }

  runningTasks.delete(displayNumber);

  const duration = Math.floor((Date.now() - taskInfo.startTime) / 1000);
  const summary = info.summary || 'Unknown task';
  const projectPath = taskProjectPaths.get(displayNumber);

  const durationStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;
  const wasCancelled = info.phase === 'cancelled';
  log(`Task #${displayNumber} ${wasCancelled ? 'cancelled' : 'completed'} with code ${exitCode} (${duration}s)`);

  // Handle user cancellation — report as failed with clear reason, skip PR/merge/summary
  if (wasCancelled) {
    const cancelMsg = `Cancelled by user after ${durationStr}.`;
    await updateTaskStatus(displayNumber, 'failed', {
      error: cancelMsg,
      sessionId: taskInfo.sessionId
    }, info.taskId);

    cleanupWorktree(displayNumber, projectPath);

    trackCompleted({
      displayNumber,
      summary,
      completedAt: new Date().toISOString(),
      duration,
      status: 'cancelled'
    });

    // Cleanup internal tracking
    taskDetails.delete(displayNumber);
    taskLastOutput.delete(displayNumber);
    taskStdoutBuffer.delete(displayNumber);
    taskStderrBuffer.delete(displayNumber);
    taskProjectPaths.delete(displayNumber);
    taskLastHeartbeat.delete(displayNumber);
    taskStreamLineBuffer.delete(displayNumber);
    taskActivityState.delete(displayNumber);
    taskLastStreamProgress.delete(displayNumber);
    updateStatusFile();
    return;
  }

  // Session ID: prefer pre-assigned ID (reliable), fall back to stdout extraction
  const sessionId = taskInfo.sessionId || extractSessionIdFromStdout(taskInfo.process, taskStdoutBuffer.get(displayNumber) || [], displayNumber);
  const worktreePath = getWorktreePath(displayNumber, projectPath);
  const machineName = getMachineName() || 'Mac';

  if (sessionId) {
    log(`Task #${displayNumber} session_id: ${sessionId}${taskInfo.sessionId ? ' (pre-assigned)' : ' (from stdout)'}`);
  } else {
    log(`Task #${displayNumber} could not determine session_id`);
  }

  if (exitCode === 0) {
    // Auto-create PR first so we can include it in the summary
    const prUrl = createPRForTask(displayNumber, summary, projectPath);

    // Ask Claude to summarize what it accomplished.
    // If --worktree auto-removed (no code changes), fall back to project path.
    const summaryPath = existsSync(worktreePath) ? worktreePath : (projectPath || process.cwd());
    const semanticSummary = extractSemanticSummary(summaryPath, sessionId);
    const visualArtifact = extractVisualArtifact(summaryPath, sessionId);

    // Clean up worktree BEFORE merge — gh pr merge --delete-branch fails if
    // the local branch is still referenced by a worktree. The branch itself
    // is preserved (only the worktree checkout is removed).
    cleanupWorktree(displayNumber, projectPath);

    // Combine: semantic summary first (what), then machine metadata (how)
    let executionSummary = '';
    if (semanticSummary) {
      executionSummary = semanticSummary + '\n';
    }
    executionSummary += `Ran for ${durationStr} on ${machineName}.`;
    if (prUrl) {
      executionSummary += ` PR: ${prUrl}`;
    }

    const statusUpdated = await updateTaskStatus(displayNumber, 'session_finished', {
      duration,
      sessionId,
      summary: executionSummary
    }, info.taskId);
    if (!statusUpdated) {
      logError(`Task #${displayNumber}: Failed to update status to session_finished — will retry`);
      // Retry once
      await updateTaskStatus(displayNumber, 'session_finished', {
        duration, sessionId, summary: executionSummary
      }, info.taskId);
    }

    // Append visual artifact as a separate timeline event (non-blocking)
    if (visualArtifact) {
      log(`Task #${displayNumber}: Sending visual artifact (${visualArtifact.length} chars)`);
      await updateTaskStatus(displayNumber, 'session_finished', {
        event: {
          type: 'visual_artifact',
          timestamp: new Date().toISOString(),
          machineName: machineName || undefined,
          format: 'mermaid',
          content: visualArtifact
        }
      }, info.taskId).catch(err => {
        log(`Task #${displayNumber}: Visual artifact upload failed (non-fatal): ${err.message}`);
      });
    }

    if (NOTIFY_ON_COMPLETE) {
      const prNote = prUrl ? ' PR ready for review.' : '';
      sendMacNotification(
        `Task #${displayNumber} complete`,
        `${summary.slice(0, 50)}...${prNote}`,
        'Glass'
      );
    }

    // Auto-merge PR into main (configurable, default ON)
    let merged = false;
    if (getAutoMergeEnabled() && prUrl) {
      merged = mergePRForTask(displayNumber, prUrl, projectPath);
    }

    // Safety net: if no new PR was created (Claude found work already done),
    // check if a previous PR for this branch was already merged.
    // See: docs/20260211_auto_complete_failure_investigation.md (Fix D)
    if (!prUrl && !merged) {
      const branch = getBranchName(displayNumber);
      try {
        const prCheck = execFileSync('gh', [
          'pr', 'list', '--head', branch, '--state', 'merged',
          '--json', 'url', '--jq', '.[0].url'
        ], {
          cwd: projectPath || process.cwd(),
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'pipe']
        }).toString().trim();
        if (prCheck) {
          log(`Task #${displayNumber}: found previously merged PR: ${prCheck}`);
          merged = true;
        }
      } catch {
        // gh not available or no merged PR found
      }
    }

    // Auto-complete task (configurable, default ON)
    const taskId = info.taskId;
    let autoCompleted = false;

    if (getAutoCompleteEnabled() && taskId) {
      // Path 1: PR merge (code tasks)
      if (merged) {
        const comment = semanticSummary
          ? `${semanticSummary} (${durationStr} on ${machineName})`
          : `Completed in ${durationStr} on ${machineName}`;
        autoCompleted = await markTaskAsCompleted(displayNumber, taskId, comment);
        if (!autoCompleted) {
          logError(`Task #${displayNumber}: Failed to mark as completed after merge`);
        }
      }

      // Path 2: Confirmation approval (content tasks — tweets, emails, etc.)
      // If user approved a confirmation AND Claude exited cleanly, the task is done.
      if (!autoCompleted && !merged) {
        const approved = await hasApprovedConfirmation(displayNumber);
        if (approved) {
          log(`Task #${displayNumber}: user-approved confirmation detected, auto-completing`);
          const comment = semanticSummary
            ? `${semanticSummary} (${durationStr} on ${machineName})`
            : `Confirmed and completed in ${durationStr} on ${machineName}`;
          autoCompleted = await markTaskAsCompleted(displayNumber, taskId, comment);
          if (!autoCompleted) {
            logError(`Task #${displayNumber}: Failed to mark as completed after confirmation`);
          }
        }
      }
    }

    trackCompleted({
      displayNumber,
      summary,
      completedAt: new Date().toISOString(),
      duration,
      status: autoCompleted ? 'completed' : 'session_finished',
      prUrl,
      sessionId
    });
  } else {
    const stderrLines = taskStderrBuffer.get(displayNumber) || [];
    const stderr = stderrLines.join('\n');
    if (stderr) {
      log(`Task #${displayNumber} stderr: ${stderr.slice(0, 500)}`);
    }

    // Ask Claude to explain what went wrong.
    // If --worktree auto-removed, fall back to project path.
    const failSummaryPath = existsSync(worktreePath) ? worktreePath : (projectPath || process.cwd());
    const failureSummary = extractSemanticSummary(failSummaryPath, sessionId);

    // Clean up worktree after summary extraction
    cleanupWorktree(displayNumber, projectPath);

    const errorMsg = failureSummary
      ? `${failureSummary}\nExit code ${exitCode}. Ran for ${durationStr} on ${machineName}.`
      : `Exit code ${exitCode}: ${stderr.slice(0, 200)}`;

    await updateTaskStatus(displayNumber, 'failed', { error: errorMsg, sessionId }, info.taskId);

    if (NOTIFY_ON_FAILURE) {
      sendMacNotification(
        `Task #${displayNumber} failed`,
        `${summary.slice(0, 40)}... Exit code ${exitCode}`,
        'Basso'
      );
    }

    trackCompleted({
      displayNumber,
      summary,
      completedAt: new Date().toISOString(),
      duration,
      status: 'failed'
    });
  }

  // Cleanup internal tracking
  taskDetails.delete(displayNumber);
  taskLastOutput.delete(displayNumber);
  taskStdoutBuffer.delete(displayNumber);
  taskStderrBuffer.delete(displayNumber);
  taskProjectPaths.delete(displayNumber);
  taskLastHeartbeat.delete(displayNumber);
  updateStatusFile();
}

// ==================== Status File ====================

function updateStatusFile() {
  const now = new Date();

  const activeTasks = [];

  // Running tasks
  for (const [displayNum, taskInfo] of runningTasks) {
    const info = taskDetails.get(displayNum) || {};
    const elapsed = Math.floor((Date.now() - taskInfo.startTime) / 1000);

    activeTasks.push({
      displayNumber: displayNum,
      taskId: info.taskId || '',
      summary: info.summary || 'Unknown task',
      status: 'running',
      phase: info.phase || 'executing',
      detail: info.detail || 'Running Claude...',
      startedAt: new Date(taskInfo.startTime).toISOString(),
      elapsedSeconds: elapsed
    });
  }

  // Queued tasks
  for (const [displayNum, info] of taskDetails) {
    if (!runningTasks.has(displayNum) && info.status === 'queued') {
      activeTasks.push({
        displayNumber: displayNum,
        taskId: info.taskId || '',
        summary: info.summary || 'Unknown task',
        status: 'queued',
        queuedAt: info.queuedAt
      });
    }
  }

  // Sort: running first, then queued
  activeTasks.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    return a.displayNumber - b.displayNumber;
  });

  const status = {
    daemon: {
      pid: process.pid,
      version: getVersion(),
      startedAt: daemonStartTime,
      machineName: getMachineName(),
      machineId: getMachineId()?.slice(-8)
    },
    running: true,
    activeTasks,
    runningTasks: activeTasks.filter(t => t.status === 'running'),
    queuedTasks: activeTasks.filter(t => t.status === 'queued'),
    completedToday: completedToday.slice(-10),
    stats: {
      running: runningTasks.size,
      maxConcurrent: MAX_CONCURRENT_TASKS,
      completedToday: completedToday.length
    },
    updatedAt: now.toISOString()
  };

  try {
    const tempFile = `${STATUS_FILE}.tmp`;
    writeFileSync(tempFile, JSON.stringify(status, null, 2));
    renameSync(tempFile, STATUS_FILE);
  } catch {}
}

// ==================== Task Checking ====================

async function checkTimeouts() {
  // Level A: Send progress heartbeats for long-running tasks
  await sendProgressHeartbeats();

  // Phase 4: Check for urgent human messages to inject into running tasks
  try {
    await checkUrgentMessages();
  } catch (error) {
    logError(`Urgent message check failed (non-fatal): ${error.message}`);
  }

  // Level B: Kill tasks that have been idle too long (fires at 15 min, before 60 min absolute)
  await killIdleTasks();

  // Absolute timeout (safety net — 60 min wall clock)
  const now = Date.now();
  const timedOut = [];

  for (const [displayNumber, taskInfo] of runningTasks) {
    const info = taskDetails.get(displayNumber) || {};

    // Skip timeout checks for tasks awaiting user confirmation on iPhone
    if (info.phase === 'awaiting_confirmation') {
      continue;
    }

    const elapsed = now - taskInfo.startTime;

    if (elapsed > TASK_TIMEOUT_MS) {
      log(`Task #${displayNumber} TIMEOUT after ${Math.floor(elapsed / 1000)}s`);
      timedOut.push(displayNumber);
    }

    // Also check idle
    checkTaskIdle(displayNumber);
  }

  // Handle timeouts
  for (const displayNumber of timedOut) {
    const taskInfo = runningTasks.get(displayNumber);
    if (!taskInfo) continue;

    const info = taskDetails.get(displayNumber) || {};
    const duration = Math.floor((now - taskInfo.startTime) / 1000);

    // Terminate
    log(`Terminating stuck task #${displayNumber} (PID: ${taskInfo.process.pid})`);
    try {
      taskInfo.process.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 5000));
      taskInfo.process.kill('SIGKILL');
    } catch {}

    runningTasks.delete(displayNumber);

    const timeoutError = `Task timed out after ${duration}s (limit: ${TASK_TIMEOUT_MS / 1000}s)`;
    updateTaskStatus(displayNumber, 'failed', { error: timeoutError, sessionId: taskInfo.sessionId });

    if (NOTIFY_ON_FAILURE) {
      sendMacNotification(
        `Task #${displayNumber} timed out`,
        `${info.summary?.slice(0, 40) || 'Unknown'}... (${duration}s limit reached)`,
        'Basso'
      );
    }

    trackCompleted({
      displayNumber,
      summary: info.summary || 'Unknown task',
      completedAt: new Date().toISOString(),
      duration,
      status: 'timeout'
    });

    // Cleanup
    const projectPath = taskProjectPaths.get(displayNumber);
    taskDetails.delete(displayNumber);
    taskLastOutput.delete(displayNumber);
    taskStdoutBuffer.delete(displayNumber);
    taskStderrBuffer.delete(displayNumber);
    taskProjectPaths.delete(displayNumber);
    taskLastHeartbeat.delete(displayNumber);
    taskStreamLineBuffer.delete(displayNumber);
    taskActivityState.delete(displayNumber);
    taskLastStreamProgress.delete(displayNumber);
    cleanupWorktree(displayNumber, projectPath);
  }

  if (timedOut.length > 0) {
    updateStatusFile();
  }
}

// ==================== Self-Update ====================

let pendingUpdateVersion = null;

function checkAndApplyUpdate() {
  const currentVersion = getVersion();

  // Check for update (throttled internally to once per hour)
  if (!pendingUpdateVersion) {
    const result = checkForUpdate(currentVersion);
    if (result.available) {
      log(`Update available: v${currentVersion} -> v${result.version}`);
      pendingUpdateVersion = result.version;
    }
  }

  // Only apply when no tasks are running
  if (pendingUpdateVersion && runningTasks.size === 0) {
    log(`Applying update to v${pendingUpdateVersion}...`);
    sendMacNotification(
      'Push Daemon Updating',
      `v${currentVersion} → v${pendingUpdateVersion}`,
      'Glass'
    );

    const success = performUpdate(pendingUpdateVersion);
    if (success) {
      log(`Update to v${pendingUpdateVersion} successful. Restarting daemon...`);

      // If LaunchAgent is installed, refresh plist (paths may have changed)
      // and let launchd handle the restart instead of spawning manually
      const laStatus = getLaunchAgentStatus();
      if (laStatus.installed && laStatus.loaded) {
        refreshLaunchAgent(); // Update plist with current node/daemon paths
        log('LaunchAgent installed — letting launchd restart daemon.');
        process.exit(0);
      }

      // No LaunchAgent — spawn new daemon manually, then exit
      const daemonScript = join(__dirname, 'daemon.js');
      const selfUpdateEnv = { ...process.env, PUSH_DAEMON: '1' };
      delete selfUpdateEnv.CLAUDECODE;  // Strip to avoid leaking into Claude child processes
      delete selfUpdateEnv.CLAUDE_CODE_ENTRYPOINT;  // Strip to avoid any entrypoint-based guards
      const child = spawn(process.execPath, [daemonScript], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: selfUpdateEnv
      });
      writeFileSync(PID_FILE, String(child.pid));
      child.unref();

      log(`New daemon spawned (PID: ${child.pid}). Old daemon exiting.`);
      process.exit(0);
    } else {
      logError(`Update to v${pendingUpdateVersion} failed, will retry next hour`);
      pendingUpdateVersion = null;
    }
  }
}

// ==================== Agent Auto-Update ====================

let pendingAgentUpdates = null; // { agentType: targetVersion, ... }

function checkAndApplyAgentUpdates() {
  // Check for updates (throttled internally to once per hour)
  if (!pendingAgentUpdates) {
    const results = checkAllAgentUpdates();
    if (!results) return; // throttled

    const available = {};
    for (const [agentType, info] of Object.entries(results)) {
      if (info.available) {
        available[agentType] = info.latest;
        log(`Agent update available: ${agentType} v${info.current} -> v${info.latest}`);
      }
    }
    if (Object.keys(available).length > 0) {
      pendingAgentUpdates = available;
    }
  }

  // Only apply when no tasks are running
  if (pendingAgentUpdates && runningTasks.size === 0) {
    for (const [agentType, targetVersion] of Object.entries(pendingAgentUpdates)) {
      log(`Updating ${agentType} to v${targetVersion}...`);
      const success = performAgentUpdate(agentType, targetVersion);
      if (success) {
        log(`${agentType} updated to v${targetVersion}`);
        sendMacNotification(
          'Push: Agent Updated',
          `${agentType} updated to v${targetVersion}`,
          'Glass'
        );
      } else {
        logError(`${agentType} update to v${targetVersion} failed`);
      }
    }
    pendingAgentUpdates = null;
  }
}

function logVersionParityWarnings() {
  const warnings = checkVersionParity();
  for (const w of warnings) {
    log(`WARNING: ${w.agentType} v${w.installed} is below minimum v${w.required} — some features may not work`);
  }
}

// ==================== Health Check (Phase 5) ====================

/**
 * Spawn a health check Claude session for a project.
 * Called by the cron module when a health-check job fires.
 *
 * The session runs in the project directory with a special prompt that asks
 * Claude to review the codebase and suggest tasks. Results are created as
 * draft todos via the create-todo API.
 *
 * @param {Object} job - Cron job object
 * @param {Function} logFn - Log function
 */
async function spawnHealthCheck(job, logFn) {
  const projectPath = job.action.projectPath;
  if (!projectPath || !existsSync(projectPath)) {
    logFn(`Health check: project path not found: ${projectPath}`);
    return;
  }

  // Don't run if task slots are full
  if (runningTasks.size >= MAX_CONCURRENT_TASKS) {
    logFn(`Health check: all ${MAX_CONCURRENT_TASKS} slots in use, deferring`);
    return;
  }

  const scope = job.action.scope || 'general';
  const customPrompt = job.action.prompt || '';

  const healthPrompts = {
    general: `Review this codebase briefly. Check for:
1. Failing tests (run the test suite if one exists)
2. Obvious bugs or issues in recently modified files (last 7 days)
3. Outdated dependencies worth updating

For each issue found, create a todo using: push-todo create "<clear description of the issue>"
Only create todos for real, actionable issues — not style preferences or minor improvements.
If everything looks good, just say "No issues found" and don't create any todos.`,
    tests: `Run the test suite for this project. If any tests fail, create a todo for each failure:
push-todo create "Fix failing test: <test name> - <brief reason>"
If all tests pass, say "All tests pass" and don't create any todos.`,
    dependencies: `Check for outdated dependencies in this project. Only flag dependencies with:
- Known security vulnerabilities
- Major version bumps (not minor/patch)
For each, create a todo: push-todo create "Update <dep> from <old> to <new> (<reason>)"
If dependencies are current, say "All dependencies up to date."`,
  };

  const prompt = customPrompt || healthPrompts[scope] || healthPrompts.general;

  const allowedTools = [
    'Read', 'Glob', 'Grep',
    'Bash(git *)',
    'Bash(npm *)', 'Bash(npx *)',
    'Bash(python *)', 'Bash(python3 *)',
    'Bash(push-todo create *)',
  ].join(',');

  const claudeArgs = [
    '-p', prompt,
    '--allowedTools', allowedTools,
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
  ];

  logFn(`Health check "${job.name}": spawning Claude in ${projectPath} (scope: ${scope})`);

  try {
    const child = spawn('claude', claudeArgs, {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: (() => {
        const env = { ...process.env };
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        return env;
      })(),
      timeout: 300000, // 5 min max for health checks
    });

    // Simple output tracking — health checks are lightweight, no full task tracking
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      const errLine = data.toString().trim();
      if (errLine) logFn(`Health check "${job.name}" stderr: ${errLine}`);
    });

    await new Promise((resolve) => {
      child.on('close', (code) => {
        if (code === 0) {
          logFn(`Health check "${job.name}": completed successfully`);
        } else {
          logFn(`Health check "${job.name}": exited with code ${code}`);
        }
        resolve();
      });
      child.on('error', (err) => {
        logFn(`Health check "${job.name}": spawn error: ${err.message}`);
        resolve();
      });
    });

    // Extract any text summary from stream-json output
    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'result' && event.result) {
          logFn(`Health check "${job.name}" result: ${event.result.slice(0, 200)}`);
        }
      } catch { /* ignore non-JSON lines */ }
    }
  } catch (error) {
    logFn(`Health check "${job.name}": error: ${error.message}`);
  }
}

// ==================== Main Loop ====================

async function pollAndExecute() {
  // Check for available slots
  if (runningTasks.size >= MAX_CONCURRENT_TASKS) {
    log(`All ${MAX_CONCURRENT_TASKS} slots in use, skipping poll`);
    return;
  }

  const availableSlots = MAX_CONCURRENT_TASKS - runningTasks.size;

  // Fetch queued tasks
  const tasks = await fetchQueuedTasks();

  if (tasks.length === 0) {
    if (runningTasks.size > 0) {
      log(`No new tasks. ${runningTasks.size} task(s) running.`);
    }
    return;
  }

  log(`Found ${tasks.length} queued tasks, ${availableSlots} slots available`);

  // Execute tasks up to available slots
  for (const task of tasks.slice(0, availableSlots)) {
    const displayNumber = task.displayNumber || task.display_number;

    if (runningTasks.has(displayNumber)) {
      continue;
    }

    // Skip tasks already completed this daemon session (prevents re-execution loop)
    if (completedToday.some(c => c.displayNumber === displayNumber)) {
      log(`Task #${displayNumber} already completed this session, skipping`);
      continue;
    }

    await executeTask(task);
  }

  updateStatusFile();
}

/**
 * Recover tasks orphaned by a previous daemon instance.
 * When the daemon restarts, tasks claimed by this machine may be stuck in 'running'
 * with no process working on them. Reset them to 'queued' so the normal poll cycle
 * picks them up and autoHeal detects prior work.
 */
async function recoverOrphanedTasks() {
  const suffix = getWorktreeSuffix();
  if (!suffix) return;

  try {
    const params = new URLSearchParams();
    params.set('execution_status', 'running');

    const response = await apiRequest(`synced-todos?${params}`);
    if (!response.ok) return;

    const data = await response.json();
    const tasks = data.todos || [];

    // Filter to tasks owned by THIS machine (branch contains our suffix)
    const orphaned = tasks.filter(t => {
      const branch = t.executionBranch || t.execution_branch || '';
      return branch.endsWith(suffix);
    });

    if (orphaned.length === 0) return;

    log(`Recovering ${orphaned.length} orphaned task(s) from previous daemon instance`);

    for (const task of orphaned) {
      const dn = task.displayNumber || task.display_number;
      const tid = task.id || task.todo_id || null;
      log(`Task #${dn}: resetting from 'running' to 'queued' (orphaned by restart)`);
      await updateTaskStatus(dn, 'queued', {
        event: {
          type: 'requeued',
          timestamp: new Date().toISOString(),
          machineName: getMachineName() || undefined,
          summary: 'Daemon restarted — re-queuing for auto-heal'
        }
      }, tid);
    }
  } catch (error) {
    log(`Orphaned task recovery failed (non-fatal): ${error.message}`);
  }
}

async function mainLoop() {
  daemonStartTime = new Date().toISOString();

  log('=' .repeat(60));
  log('Push task execution daemon started');
  log(`Machine: ${getMachineName()} (${getMachineId() || 'no ID'})`);
  log(`PID: ${process.pid}`);
  log(`Polling interval: ${POLL_INTERVAL / 1000}s`);
  log(`Max concurrent tasks: ${MAX_CONCURRENT_TASKS}`);
  log(`E2EE: ${e2eeAvailable ? 'Available' : 'Not available'}`);
  log(`Auto-update: ${getAutoUpdateEnabled() ? 'Enabled' : 'Disabled'}`);
  log(`Auto-update-agents: ${getAutoUpdateAgentsEnabled() ? 'Enabled' : 'Disabled'}`);
  const caps = getCapabilities();
  log(`Capabilities: gh=${caps.gh_cli}, auto-merge=${caps.auto_merge}, auto-complete=${caps.auto_complete}`);
  const agentVersions = getAgentVersions({ force: true });
  log(`Agent versions: ${formatAgentVersionSummary(agentVersions)}`);
  logVersionParityWarnings();
  log(`Log file: ${LOG_FILE}`);

  // Show registered projects
  const projects = getListedProjects();
  const projectCount = Object.keys(projects).length;
  if (projectCount > 0) {
    log(`Registered projects (${projectCount}):`);
    for (const [remote, path] of Object.entries(projects)) {
      log(`  - ${remote}`);
      log(`    -> ${path}`);
    }
  } else {
    log('No projects registered yet');
    log("Run '/push-todo connect' in your project directories");
  }
  log('=' .repeat(60));

  // Check API key
  if (!getApiKey()) {
    log("WARNING: No API key configured. Run '/push-todo connect' first.");
  }

  // Write version file
  try {
    writeFileSync(VERSION_FILE, getVersion());
  } catch {}

  // Recover orphaned tasks from previous daemon instance
  // When the daemon restarts (self-update, crash, reboot), tasks may be stuck
  // in 'running' with no process actually working on them. Reset them to 'queued'
  // so the normal poll cycle picks them up and autoHeal handles the rest.
  // See: docs/20260211_auto_complete_failure_investigation.md
  await recoverOrphanedTasks();

  // Initial status
  updateStatusFile();

  // Main poll loop
  const poll = async () => {
    try {
      await checkTimeouts();

      // Schedule bridge: auto-queue todos whose reminder time has arrived
      try {
        await checkAndQueueScheduledTodos();
      } catch (error) {
        logError(`Scheduled todo check error: ${error.message}`);
      }

      await pollAndExecute();

      // Cron jobs (check every poll cycle, execution throttled by nextRunAt)
      try {
        await checkAndRunDueJobs(log, { apiRequest, spawnHealthCheck });
      } catch (error) {
        logError(`Cron check error: ${error.message}`);
      }

      // Heartbeat checks (internally throttled: 10min fast, 1hr slow)
      try {
        const projects = getListedProjects();
        await runHeartbeatChecks({
          projectPaths: Object.values(projects),
          apiRequest,
          log,
        });
      } catch (error) {
        logError(`Heartbeat error: ${error.message}`);
      }

      // Project freshness check (internally throttled to once per hour)
      try {
        const projects = getListedProjects();
        const busyPaths = new Set();
        for (const [, info] of runningTasks) {
          if (info.projectPath) busyPaths.add(info.projectPath);
        }
        checkAllProjectsFreshness({
          projects,
          autoRebase: getAutoUpdateEnabled(),
          busyPaths,
          log,
        });
      } catch (error) {
        logError(`Freshness check error: ${error.message}`);
      }

      // Agent version check (internally throttled to once per hour)
      try {
        getAgentVersions();
      } catch (error) {
        logError(`Agent version check error: ${error.message}`);
      }

      // Self-update check (throttled to once per hour, only applies when idle)
      if (getAutoUpdateEnabled()) {
        checkAndApplyUpdate();
      }

      // Agent CLI auto-update (throttled to once per hour, only applies when idle)
      if (getAutoUpdateAgentsEnabled()) {
        try {
          checkAndApplyAgentUpdates();
        } catch (error) {
          logError(`Agent auto-update error: ${error.message}`);
        }
      }
    } catch (error) {
      logError(`Poll error: ${error.message}`);
    }
  };

  // Initial poll
  await poll();

  // Set up interval
  setInterval(poll, POLL_INTERVAL);

  log(`Daemon running (PID: ${process.pid}, poll interval: ${POLL_INTERVAL / 1000}s)`);
}

// ==================== Signal Handling ====================

async function cleanup() {
  log('Daemon shutting down...');

  // Kill running tasks and collect status update promises
  const statusPromises = [];
  for (const [displayNumber, taskInfo] of runningTasks) {
    log(`Killing task #${displayNumber}`);
    try {
      taskInfo.process.kill('SIGTERM');
    } catch {}
    // Mark as failed so the task doesn't stay as 'running' forever
    const duration = Math.floor((Date.now() - taskInfo.startTime) / 1000);
    statusPromises.push(
      updateTaskStatus(displayNumber, 'failed', {
        error: `Daemon shutdown after ${duration}s`,
        event: {
          type: 'daemon_shutdown',
          timestamp: new Date().toISOString(),
          machineName: getMachineName() || undefined,
          summary: `Daemon restarted after ${duration}s`,
        }
      })
    );
    const projectPath = taskProjectPaths.get(displayNumber);
    cleanupWorktree(displayNumber, projectPath);
  }

  // Wait for all status updates to land (max 5s timeout)
  if (statusPromises.length > 0) {
    log(`Waiting for ${statusPromises.length} status update(s) to complete...`);
    await Promise.race([
      Promise.allSettled(statusPromises),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }

  // Clean up files
  releaseLock();
  try { unlinkSync(PID_FILE); } catch {}

  // Update status
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({
      running: false,
      stoppedAt: new Date().toISOString()
    }));
  } catch {}

  process.exit(0);
}

process.on('SIGTERM', () => cleanup().catch(() => process.exit(1)));
process.on('SIGINT', () => cleanup().catch(() => process.exit(1)));
process.on('uncaughtException', (error) => {
  logError(`Uncaught exception: ${error.message}`);
  cleanup().catch(() => process.exit(1));
});

// ==================== Entry Point ====================

// Ensure directories exist
mkdirSync(PUSH_DIR, { recursive: true });
mkdirSync(CONFIG_DIR, { recursive: true });

// Rotate logs
rotateLogs();

// Acquire lock (prevents zombie daemons from racing)
if (!acquireLock()) {
  const holderPid = parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  // Log to file directly since log() may not work yet
  const msg = `[${new Date().toISOString()}] [PID:${process.pid}] [INFO] Another daemon (PID ${holderPid}) holds the lock. Exiting.\n`;
  try { appendFileSync(LOG_FILE, msg); } catch {}
  process.exit(0);
}

// Write PID file
writeFileSync(PID_FILE, String(process.pid));

// Start main loop
mainLoop().catch((error) => {
  logError(`Fatal error: ${error.message}`);
  cleanup();
});
