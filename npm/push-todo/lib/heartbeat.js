/**
 * Heartbeat health checks for Push daemon.
 *
 * Tier 1 checks: deterministic, no LLM, fast, no cost.
 * Runs on configurable intervals from the daemon poll loop.
 *
 * Architecture: docs/20260214_push_daemon_evolution_complete_architecture.md §23
 * Pattern: Follow self-update.js — pure functions, non-fatal.
 */

import { execFileSync } from 'child_process';
import { sendMacNotification } from './utils/notify.js';

// ==================== Throttle Configuration ====================

const FAST_CHECK_INTERVAL = 600000;  // 10 minutes
const SLOW_CHECK_INTERVAL = 3600000; // 1 hour

// ==================== Thresholds ====================

const CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const QUEUED_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const STALE_PR_HOURS = 48;

// ==================== Internal State ====================

let lastFastCheck = 0;
let lastSlowCheck = 0;

// Track already-notified items to avoid repeat alerts
const notifiedItems = new Map(); // key -> timestamp (auto-expire after 24h)
const NOTIFICATION_COOLDOWN = 24 * 60 * 60 * 1000; // 24 hours

function shouldNotify(key) {
  const last = notifiedItems.get(key);
  if (last && (Date.now() - last) < NOTIFICATION_COOLDOWN) {
    return false;
  }
  notifiedItems.set(key, Date.now());

  // Prune old entries
  if (notifiedItems.size > 200) {
    const cutoff = Date.now() - NOTIFICATION_COOLDOWN;
    for (const [k, t] of notifiedItems) {
      if (t < cutoff) notifiedItems.delete(k);
    }
  }

  return true;
}

// ==================== Fast Checks (every 10 min) ====================

/**
 * Check for tasks stuck in awaiting_confirmation.
 *
 * @param {Function} apiRequest - Daemon's authenticated API request function
 * @param {Function} log - Log function
 */
async function checkConfirmationTimeouts(apiRequest, log) {
  try {
    const params = new URLSearchParams();
    params.set('execution_status', 'awaiting_confirmation');
    const response = await apiRequest(`synced-todos?${params}`);
    if (!response.ok) return;

    const data = await response.json();
    const tasks = data.todos || [];
    const now = Date.now();

    for (const task of tasks) {
      const events = task.executionEvents || task.execution_events || [];
      const confirmEvent = events.find(e =>
        e.type === 'confirmation_needed' || e.type === 'awaiting_confirmation'
      );
      if (!confirmEvent?.timestamp) continue;

      const elapsed = now - new Date(confirmEvent.timestamp).getTime();
      if (elapsed > CONFIRMATION_TIMEOUT_MS) {
        const dn = task.displayNumber || task.display_number;
        const minutes = Math.round(elapsed / 60000);
        const key = `confirm-timeout-${dn}`;

        if (shouldNotify(key)) {
          sendMacNotification(
            'Push: Confirmation Waiting',
            `Task #${dn} has been awaiting confirmation for ${minutes} minutes`,
            'Basso'
          );
          log(`Heartbeat: Task #${dn} confirmation timeout (${minutes}min)`);
        }
      }
    }
  } catch (error) {
    log(`Heartbeat: confirmation timeout check failed: ${error.message}`);
  }
}

/**
 * Check for tasks queued for too long.
 *
 * @param {Function} apiRequest - Daemon's authenticated API request function
 * @param {Function} log - Log function
 */
async function checkQueuedTaskAge(apiRequest, log) {
  try {
    const params = new URLSearchParams();
    params.set('execution_status', 'queued');
    const response = await apiRequest(`synced-todos?${params}`);
    if (!response.ok) return;

    const data = await response.json();
    const tasks = data.todos || [];
    const now = Date.now();

    for (const task of tasks) {
      // Use the first "queued" event timestamp, or fall back to modified_at
      const events = task.executionEvents || task.execution_events || [];
      const queuedEvent = events.find(e => e.type === 'queued' || e.type === 'requeued');
      const queuedAt = queuedEvent?.timestamp || task.modified_at || task.modifiedAt;
      if (!queuedAt) continue;

      const elapsed = now - new Date(queuedAt).getTime();
      if (elapsed > QUEUED_TASK_TIMEOUT_MS) {
        const dn = task.displayNumber || task.display_number;
        const hours = Math.round(elapsed / 3600000);
        const key = `queued-age-${dn}`;

        if (shouldNotify(key)) {
          sendMacNotification(
            'Push: Stale Queued Task',
            `Task #${dn} has been queued for ${hours} hours`,
            'Basso'
          );
          log(`Heartbeat: Task #${dn} queued for ${hours}h`);
        }
      }
    }
  } catch (error) {
    log(`Heartbeat: queued task age check failed: ${error.message}`);
  }
}

// ==================== Slow Checks (every 1 hour) ====================

/**
 * Check for stale PRs across registered projects.
 *
 * @param {string[]} projectPaths - Registered project local paths
 * @param {Function} log - Log function
 */
function checkStalePRs(projectPaths, log) {
  for (const projectPath of projectPaths) {
    try {
      const output = execFileSync('gh', [
        'pr', 'list',
        '--json', 'number,title,updatedAt',
        '--limit', '10',
      ], {
        cwd: projectPath,
        timeout: 15000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

      if (!output) continue;

      const prs = JSON.parse(output);
      const now = Date.now();
      const threshold = STALE_PR_HOURS * 3600000;

      for (const pr of prs) {
        if (!pr.updatedAt) continue;
        const age = now - new Date(pr.updatedAt).getTime();

        if (age > threshold) {
          const hours = Math.round(age / 3600000);
          const key = `stale-pr-${pr.number}`;

          if (shouldNotify(key)) {
            sendMacNotification(
              'Push: Stale PR',
              `PR #${pr.number} "${pr.title}" has been open ${hours}h with no activity`
            );
            log(`Heartbeat: Stale PR #${pr.number} (${hours}h)`);
          }
        }
      }
    } catch {
      // gh not available or not authenticated for this project — skip
    }
  }
}

/**
 * Check for CI failures on recent PRs.
 *
 * @param {string[]} projectPaths - Registered project local paths
 * @param {Function} log - Log function
 */
function checkCIFailures(projectPaths, log) {
  for (const projectPath of projectPaths) {
    try {
      // Get recent PRs
      const prOutput = execFileSync('gh', [
        'pr', 'list',
        '--json', 'number,headRefName',
        '--limit', '3',
      ], {
        cwd: projectPath,
        timeout: 10000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

      if (!prOutput) continue;
      const prs = JSON.parse(prOutput);

      for (const pr of prs) {
        try {
          const checksOutput = execFileSync('gh', [
            'pr', 'checks', String(pr.number),
            '--json', 'name,state',
          ], {
            cwd: projectPath,
            timeout: 10000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();

          if (!checksOutput) continue;
          const checks = JSON.parse(checksOutput);
          const failures = checks.filter(c => c.state === 'FAILURE');

          if (failures.length > 0) {
            const key = `ci-fail-${pr.number}`;
            if (shouldNotify(key)) {
              const names = failures.map(f => f.name).join(', ');
              sendMacNotification(
                'Push: CI Failure',
                `PR #${pr.number}: ${names} failed`,
                'Glass'
              );
              log(`Heartbeat: CI failure on PR #${pr.number}: ${names}`);
            }
          }
        } catch {
          // Individual PR check failed — skip
        }
      }
    } catch {
      // gh not available — skip
    }
  }
}

// ==================== Main Entry ====================

/**
 * Run heartbeat checks (internally throttled).
 *
 * @param {Object} config
 * @param {string[]} config.projectPaths - Registered project local paths
 * @param {Function} config.apiRequest - Daemon's authenticated API request function
 * @param {Function} config.log - Daemon's log function
 */
export async function runHeartbeatChecks(config) {
  const { projectPaths, apiRequest, log } = config;
  const now = Date.now();

  // Fast checks (every 10 min)
  if (now - lastFastCheck >= FAST_CHECK_INTERVAL) {
    lastFastCheck = now;

    await checkConfirmationTimeouts(apiRequest, log);
    await checkQueuedTaskAge(apiRequest, log);
  }

  // Slow checks (every 1 hour)
  if (now - lastSlowCheck >= SLOW_CHECK_INTERVAL) {
    lastSlowCheck = now;

    checkStalePRs(projectPaths, log);
    checkCIFailures(projectPaths, log);
  }
}
