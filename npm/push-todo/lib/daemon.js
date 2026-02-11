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

import { spawn, execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, statSync, renameSync } from 'fs';
import { homedir, hostname, platform } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { checkForUpdate, performUpdate } from './self-update.js';

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
const taskLastOutput = new Map(); // displayNumber -> timestamp
const taskStdoutBuffer = new Map(); // displayNumber -> lines[]
const taskProjectPaths = new Map(); // displayNumber -> projectPath
let daemonStartTime = null;

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
  const line = `[${timestamp}] [${level}] ${message}\n`;

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

// ==================== Mac Notifications ====================

function sendMacNotification(title, message, sound = 'default') {
  if (platform() !== 'darwin') return;

  try {
    const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    let script = `display notification "${escapedMessage}" with title "${escapedTitle}"`;
    if (sound && sound !== 'default') {
      script += ` sound name "${sound}"`;
    }

    execSync(`osascript -e '${script}'`, { timeout: 5000, stdio: 'pipe' });
  } catch {
    // Non-critical
  }
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

// ==================== Capabilities Detection ====================

let cachedCapabilities = null;
let lastCapabilityCheck = 0;
const CAPABILITY_CHECK_INTERVAL = 3600000; // 1 hour

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

    // Add machine registry headers for daemon status tracking
    // See: /docs/20260204_daemon_heartbeat_status_indicator_implementation_plan.md (machine_registry table)
    const heartbeatHeaders = {};
    if (machineId && gitRemotes.length > 0) {
      heartbeatHeaders['X-Machine-Id'] = machineId;
      heartbeatHeaders['X-Machine-Name'] = machineName || 'Unknown Mac';
      heartbeatHeaders['X-Git-Remotes'] = gitRemotes.join(',');
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

async function updateTaskStatus(displayNumber, status, extra = {}) {
  try {
    const payload = {
      displayNumber,
      status,
      ...extra
    };

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
    return response.ok && result?.success !== false;
  } catch (error) {
    logError(`Failed to update task status: ${error.message}`);
    return false;
  }
}

async function claimTask(displayNumber) {
  const machineId = getMachineId();
  const machineName = getMachineName();

  if (!machineId) {
    // No machine ID - skip atomic claiming
    return true;
  }

  const suffix = getWorktreeSuffix();
  const branch = `push-${displayNumber}-${suffix}`;

  const payload = {
    displayNumber,
    status: 'running',
    machineId,
    machineName,
    branch,
    atomic: true
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

function getProjectPath(gitRemote) {
  if (!existsSync(REGISTRY_FILE)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    return data.projects?.[gitRemote]?.localPath || data.projects?.[gitRemote]?.local_path || null;
  } catch {
    return null;
  }
}

function getListedProjects() {
  if (!existsSync(REGISTRY_FILE)) {
    return {};
  }

  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
    const result = {};
    for (const [remote, info] of Object.entries(data.projects || {})) {
      result[remote] = info.localPath || info.local_path;
    }
    return result;
  } catch {
    return {};
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

function getWorktreePath(displayNumber, projectPath) {
  const suffix = getWorktreeSuffix();
  const worktreeName = `push-${displayNumber}-${suffix}`;

  if (projectPath) {
    return join(dirname(projectPath), worktreeName);
  }
  return join(process.cwd(), '..', worktreeName);
}

function createWorktree(displayNumber, projectPath) {
  const suffix = getWorktreeSuffix();
  const branch = `push-${displayNumber}-${suffix}`;
  const worktreePath = getWorktreePath(displayNumber, projectPath);

  if (existsSync(worktreePath)) {
    log(`Worktree already exists: ${worktreePath}`);
    return worktreePath;
  }

  const gitCwd = projectPath || process.cwd();

  try {
    // Try to create with new branch
    execSync(`git worktree add "${worktreePath}" -b ${branch}`, {
      cwd: gitCwd,
      timeout: 30000,
      stdio: 'pipe'
    });
    log(`Created worktree: ${worktreePath}`);
    return worktreePath;
  } catch {
    // Branch might already exist, try without -b
    try {
      execSync(`git worktree add "${worktreePath}" ${branch}`, {
        cwd: gitCwd,
        timeout: 30000,
        stdio: 'pipe'
      });
      log(`Created worktree (existing branch): ${worktreePath}`);
      return worktreePath;
    } catch (e) {
      logError(`Failed to create worktree: ${e.message}`);
      return null;
    }
  }
}

function cleanupWorktree(displayNumber, projectPath) {
  const worktreePath = getWorktreePath(displayNumber, projectPath);

  if (!existsSync(worktreePath)) return;

  const gitCwd = projectPath || process.cwd();
  const suffix = getWorktreeSuffix();
  const branch = `push-${displayNumber}-${suffix}`;

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
  const suffix = getWorktreeSuffix();
  const branch = `push-${displayNumber}-${suffix}`;
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
 * Merge a PR into main and update local main branch.
 * Uses `gh pr merge` for clean remote merge, then pulls locally.
 *
 * @returns {boolean} True if merge succeeded
 */
function mergePRForTask(displayNumber, prUrl, projectPath) {
  const gitCwd = projectPath || process.cwd();

  // Extract PR number from URL (e.g., https://github.com/user/repo/pull/42)
  const prMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!prMatch) {
    logError(`Could not extract PR number from: ${prUrl}`);
    return false;
  }
  const prNumber = prMatch[1];

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

    return true;
  } catch (e) {
    const stderr = e.stderr?.toString() || e.message || '';
    if (stderr.includes('merge conflict') || stderr.includes('conflict')) {
      logError(`PR #${prNumber} has merge conflicts, skipping auto-merge`);
    } else if (stderr.includes('not found') || stderr.includes('ENOENT')) {
      log('GitHub CLI (gh) not installed, skipping merge');
    } else {
      logError(`Failed to merge PR #${prNumber}: ${stderr.slice(0, 200)}`);
    }
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

// ==================== Session ID Extraction ====================

function extractSessionIdFromStdout(proc, buffer) {
  let remaining = '';
  if (proc.stdout) {
    try {
      remaining = proc.stdout.read()?.toString() || '';
    } catch {}
  }

  const allOutput = buffer.join('\n') + '\n' + remaining;

  // Try to parse JSON output
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

// ==================== Task Execution ====================

function updateTaskDetail(displayNumber, updates) {
  const current = taskDetails.get(displayNumber) || {};
  taskDetails.set(displayNumber, { ...current, ...updates });
  updateStatusFile();
}

function executeTask(task) {
  // Decrypt E2EE fields
  task = decryptTaskFields(task);

  const displayNumber = task.displayNumber || task.display_number;
  const gitRemote = task.gitRemote || task.git_remote;
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

  // Get project path
  let projectPath = null;
  if (gitRemote) {
    projectPath = getProjectPath(gitRemote);
    if (!projectPath) {
      log(`Task #${displayNumber}: Project not registered: ${gitRemote}`);
      log("Run '/push-todo connect' in the project directory to register");
      return null;
    }

    if (!existsSync(projectPath)) {
      logError(`Task #${displayNumber}: Project path does not exist: ${projectPath}`);
      updateTaskStatus(displayNumber, 'failed', {
        error: `Project path not found: ${projectPath}`
      });
      return null;
    }

    log(`Task #${displayNumber}: Project ${gitRemote} -> ${projectPath}`);
  }

  // Atomic task claiming
  if (!claimTask(displayNumber)) {
    return null;
  }

  // Track task details
  updateTaskDetail(displayNumber, {
    taskId: task.id || task.todo_id || '',
    summary,
    status: 'running',
    phase: 'starting',
    detail: 'Starting Claude...',
    startedAt: Date.now(),
    gitRemote
  });

  log(`Executing task #${displayNumber}: ${content.slice(0, 60)}...`);

  // Create worktree
  const worktreePath = createWorktree(displayNumber, projectPath);
  if (!worktreePath) {
    updateTaskStatus(displayNumber, 'failed', { error: 'Failed to create git worktree' });
    taskDetails.delete(displayNumber);
    return null;
  }

  taskProjectPaths.set(displayNumber, projectPath);

  // Build prompt
  const prompt = `Work on Push task #${displayNumber}:

${content}

IMPORTANT:
1. If you need to understand the codebase, start by reading the CLAUDE.md file if it exists.
2. ALWAYS commit your changes before finishing. Use a descriptive commit message summarizing what you did. This is critical — uncommitted changes will be lost when the worktree is cleaned up.
3. When you're done, the SessionEnd hook will automatically report completion to Supabase.`;

  // Update status to running (auto-generates 'started' event)
  updateTaskStatus(displayNumber, 'running', {
    event: {
      type: 'started',
      timestamp: new Date().toISOString(),
      machineName: getMachineName() || undefined,
      summary: summary.slice(0, 100),
    }
  });

  // Build Claude command
  const allowedTools = [
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Bash(git *)',
    'Bash(npm *)', 'Bash(npx *)', 'Bash(yarn *)',
    'Bash(python *)', 'Bash(python3 *)', 'Bash(pip *)', 'Bash(pip3 *)',
    'Task'
  ].join(',');

  const claudeArgs = [
    '-p', prompt,
    '--allowedTools', allowedTools,
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions'
  ];

  try {
    const child = spawn('claude', claudeArgs, {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PUSH_TASK_ID: task.id,
        PUSH_DISPLAY_NUMBER: String(displayNumber)
      }
    });

    const taskInfo = {
      process: child,
      task,
      displayNumber,
      startTime: Date.now(),
      projectPath
    };

    runningTasks.set(displayNumber, taskInfo);
    taskLastOutput.set(displayNumber, Date.now());
    taskStdoutBuffer.set(displayNumber, []);

    // Monitor stdout
    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          taskLastOutput.set(displayNumber, Date.now());
          const buffer = taskStdoutBuffer.get(displayNumber) || [];
          buffer.push(line);
          if (buffer.length > 20) buffer.shift();
          taskStdoutBuffer.set(displayNumber, buffer);

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

    child.on('error', (error) => {
      logError(`Task #${displayNumber} error: ${error.message}`);
      runningTasks.delete(displayNumber);
      updateTaskStatus(displayNumber, 'failed', { error: error.message });
      taskDetails.delete(displayNumber);
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
    updateTaskStatus(displayNumber, 'failed', { error: error.message });
    taskDetails.delete(displayNumber);
    return null;
  }
}

function handleTaskCompletion(displayNumber, exitCode) {
  const taskInfo = runningTasks.get(displayNumber);
  if (!taskInfo) return;

  runningTasks.delete(displayNumber);

  const duration = Math.floor((Date.now() - taskInfo.startTime) / 1000);
  const info = taskDetails.get(displayNumber) || {};
  const summary = info.summary || 'Unknown task';
  const projectPath = taskProjectPaths.get(displayNumber);

  log(`Task #${displayNumber} completed with code ${exitCode} (${duration}s)`);

  // Extract session ID for both success and failure (needed for AI summary)
  const buffer = taskStdoutBuffer.get(displayNumber) || [];
  const sessionId = extractSessionIdFromStdout(taskInfo.process, buffer);
  const worktreePath = getWorktreePath(displayNumber, projectPath);
  const durationStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;
  const machineName = getMachineName() || 'Mac';

  if (sessionId) {
    log(`Task #${displayNumber} session_id: ${sessionId}`);
  } else {
    log(`Task #${displayNumber} could not extract session_id`);
  }

  if (exitCode === 0) {
    // Auto-create PR first so we can include it in the summary
    const prUrl = createPRForTask(displayNumber, summary, projectPath);

    // Ask Claude to summarize what it accomplished
    const semanticSummary = extractSemanticSummary(worktreePath, sessionId);

    // Combine: semantic summary first (what), then machine metadata (how)
    let executionSummary = '';
    if (semanticSummary) {
      executionSummary = semanticSummary + '\n';
    }
    executionSummary += `Ran for ${durationStr} on ${machineName}.`;
    if (prUrl) {
      executionSummary += ` PR: ${prUrl}`;
    }

    updateTaskStatus(displayNumber, 'session_finished', {
      duration,
      sessionId,
      summary: executionSummary
    });

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

    // Auto-complete task after successful merge (configurable, default ON)
    const taskId = info.taskId;
    if (getAutoCompleteEnabled() && merged && taskId) {
      const comment = semanticSummary
        ? `${semanticSummary} (${durationStr} on ${machineName})`
        : `Completed in ${durationStr} on ${machineName}`;
      markTaskAsCompleted(displayNumber, taskId, comment);
    }

    completedToday.push({
      displayNumber,
      summary,
      completedAt: new Date().toISOString(),
      duration,
      status: merged ? 'completed' : 'session_finished',
      prUrl,
      sessionId
    });
  } else {
    const stderr = taskInfo.process.stderr?.read()?.toString() || '';

    // Ask Claude to explain what went wrong (if session exists)
    const failureSummary = extractSemanticSummary(worktreePath, sessionId);
    const errorMsg = failureSummary
      ? `${failureSummary}\nExit code ${exitCode}. Ran for ${durationStr} on ${machineName}.`
      : `Exit code ${exitCode}: ${stderr.slice(0, 200)}`;

    updateTaskStatus(displayNumber, 'failed', { error: errorMsg });

    if (NOTIFY_ON_FAILURE) {
      sendMacNotification(
        `Task #${displayNumber} failed`,
        `${summary.slice(0, 40)}... Exit code ${exitCode}`,
        'Basso'
      );
    }

    completedToday.push({
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
  taskProjectPaths.delete(displayNumber);

  // Always clean up worktree — the branch preserves all committed work.
  // On re-run, createWorktree() recreates from the existing branch.
  cleanupWorktree(displayNumber, projectPath);
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
  const now = Date.now();
  const timedOut = [];

  for (const [displayNumber, taskInfo] of runningTasks) {
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
    updateTaskStatus(displayNumber, 'failed', { error: timeoutError });

    if (NOTIFY_ON_FAILURE) {
      sendMacNotification(
        `Task #${displayNumber} timed out`,
        `${info.summary?.slice(0, 40) || 'Unknown'}... (${duration}s limit reached)`,
        'Basso'
      );
    }

    completedToday.push({
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
    taskProjectPaths.delete(displayNumber);
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

      // Spawn new daemon from updated code, then exit
      const daemonScript = join(__dirname, 'daemon.js');
      const child = spawn(process.execPath, [daemonScript], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, PUSH_DAEMON: '1' }
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

    executeTask(task);
  }

  updateStatusFile();
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
  const caps = getCapabilities();
  log(`Capabilities: gh=${caps.gh_cli}, auto-merge=${caps.auto_merge}, auto-complete=${caps.auto_complete}`);
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

  // Initial status
  updateStatusFile();

  // Main poll loop
  const poll = async () => {
    try {
      await checkTimeouts();
      await pollAndExecute();

      // Self-update check (throttled to once per hour, only applies when idle)
      if (getAutoUpdateEnabled()) {
        checkAndApplyUpdate();
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

function cleanup() {
  log('Daemon shutting down...');

  // Kill running tasks and mark them as failed in Supabase
  for (const [displayNumber, taskInfo] of runningTasks) {
    log(`Killing task #${displayNumber}`);
    try {
      taskInfo.process.kill('SIGTERM');
    } catch {}
    // Mark as failed so the task doesn't stay as 'running' forever
    const duration = Math.floor((Date.now() - taskInfo.startTime) / 1000);
    updateTaskStatus(displayNumber, 'failed', {
      error: `Daemon shutdown after ${duration}s`,
      event: {
        type: 'daemon_shutdown',
        timestamp: new Date().toISOString(),
        machineName: getMachineName() || undefined,
        summary: `Daemon restarted after ${duration}s`,
      }
    });
    const projectPath = taskProjectPaths.get(displayNumber);
    cleanupWorktree(displayNumber, projectPath);
  }

  // Clean up files
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

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('uncaughtException', (error) => {
  logError(`Uncaught exception: ${error.message}`);
  cleanup();
});

// ==================== Entry Point ====================

// Ensure directories exist
mkdirSync(PUSH_DIR, { recursive: true });
mkdirSync(CONFIG_DIR, { recursive: true });

// Rotate logs
rotateLogs();

// Write PID file
writeFileSync(PID_FILE, String(process.pid));

// Start main loop
mainLoop().catch((error) => {
  logError(`Fatal error: ${error.message}`);
  cleanup();
});
