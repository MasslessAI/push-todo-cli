/**
 * Cron job scheduler for Push daemon.
 *
 * Stores recurring/one-shot jobs in ~/.push/cron/jobs.json.
 * Called from daemon main loop on each poll cycle.
 *
 * No npm dependencies — includes minimal cron expression parser.
 * Architecture: docs/20260214_push_daemon_evolution_complete_architecture.md §23
 * Pattern: Follow self-update.js — pure functions, called from daemon.js.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { sendMacNotification } from './utils/notify.js';

const CRON_DIR = join(homedir(), '.push', 'cron');
const JOBS_FILE = join(CRON_DIR, 'jobs.json');

// ==================== Storage ====================

function ensureCronDir() {
  mkdirSync(CRON_DIR, { recursive: true });
}

/**
 * Load all cron jobs from disk.
 * @returns {Array} Job objects
 */
export function loadJobs() {
  if (!existsSync(JOBS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Save all cron jobs to disk.
 * @param {Array} jobs
 */
export function saveJobs(jobs) {
  ensureCronDir();
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2) + '\n');
}

// ==================== Interval Parsing ====================

/**
 * Parse an interval string into milliseconds.
 * Supports: "30m", "1h", "24h", "7d"
 *
 * @param {string} value - Interval string
 * @returns {number} Milliseconds
 */
export function parseInterval(value) {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid interval format: "${value}". Use Nm, Nh, or Nd (e.g., "30m", "1h", "7d")`);
  }

  const num = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers = { m: 60000, h: 3600000, d: 86400000 };
  return num * multipliers[unit];
}

// ==================== Cron Expression Parser ====================

// Parse a single cron field into an array of valid values.
// Supports: *, N, N-M, N,M, and step expressions.
function parseCronField(field, min, max) {
  const values = new Set();

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    // */N — every N
    if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid cron step: ${trimmed}`);
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }

    // * — all values
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // N-M — range
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid cron range: ${trimmed}`);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    // N — specific value
    const num = parseInt(trimmed, 10);
    if (isNaN(num)) throw new Error(`Invalid cron value: ${trimmed}`);
    values.add(num);
  }

  return [...values].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression and compute the next matching time.
 *
 * @param {string} expression - Cron expression (e.g., "0 9 * * 1")
 * @param {Date} [fromDate] - Start searching from this date (default: now)
 * @returns {Date|null} Next matching time, or null if none within 366 days
 */
export function getNextCronMatch(expression, fromDate = new Date()) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${fields.length}: "${expression}"`);
  }

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const daysOfWeek = parseCronField(fields[4], 0, 6); // 0=Sun

  // Start from the next minute
  const candidate = new Date(fromDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Cap search at 366 days
  const maxDate = new Date(fromDate.getTime() + 366 * 86400000);

  while (candidate <= maxDate) {
    const month = candidate.getMonth() + 1; // 1-indexed
    const dayOfMonth = candidate.getDate();
    const dayOfWeek = candidate.getDay(); // 0=Sun
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    // Check month
    if (!months.includes(month)) {
      // Skip to first day of next valid month
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day of month AND day of week
    // Standard cron: if both are restricted (not *), either can match (OR logic).
    // If only one is restricted, it must match.
    const domRestricted = fields[2] !== '*';
    const dowRestricted = fields[4] !== '*';

    let dayMatch;
    if (domRestricted && dowRestricted) {
      dayMatch = daysOfMonth.includes(dayOfMonth) || daysOfWeek.includes(dayOfWeek);
    } else if (domRestricted) {
      dayMatch = daysOfMonth.includes(dayOfMonth);
    } else if (dowRestricted) {
      dayMatch = daysOfWeek.includes(dayOfWeek);
    } else {
      dayMatch = true;
    }

    if (!dayMatch) {
      // Skip to next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    if (!hours.includes(hour)) {
      // Skip to next hour
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Check minute
    if (!minutes.includes(minute)) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }

    // All fields match
    return candidate;
  }

  return null; // No match within 366 days
}

// ==================== Next Run Computation ====================

/**
 * Compute the next run time for a schedule.
 *
 * @param {{ type: string, value: string }} schedule
 * @param {Date} [fromDate] - Compute relative to this date (default: now)
 * @returns {string|null} ISO string of next run, or null if expired
 */
export function computeNextRun(schedule, fromDate = new Date()) {
  switch (schedule.type) {
    case 'at': {
      const target = new Date(schedule.value);
      return target > fromDate ? target.toISOString() : null;
    }
    case 'every': {
      const ms = parseInterval(schedule.value);
      return new Date(fromDate.getTime() + ms).toISOString();
    }
    case 'cron': {
      const next = getNextCronMatch(schedule.value, fromDate);
      return next ? next.toISOString() : null;
    }
    default:
      throw new Error(`Unknown schedule type: ${schedule.type}`);
  }
}

// ==================== Job Management ====================

/**
 * Add a new cron job.
 *
 * @param {Object} config
 * @param {string} config.name - Job name
 * @param {{ type: string, value: string }} config.schedule - Schedule definition
 * @param {{ type: string, content: string }} config.action - Action to perform
 * @returns {Object} Created job
 */
export function addJob(config) {
  const { name, schedule, action } = config;

  if (!name) throw new Error('Job name is required');
  if (!schedule || !schedule.type || !schedule.value) throw new Error('Schedule is required');
  if (!action || !action.type) throw new Error('Action is required');

  // Validate schedule by computing next run
  const nextRunAt = computeNextRun(schedule);
  if (!nextRunAt) {
    throw new Error(`Schedule "${schedule.type}: ${schedule.value}" has no future run time`);
  }

  const job = {
    id: randomUUID(),
    name,
    schedule,
    action,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    nextRunAt,
  };

  const jobs = loadJobs();
  jobs.push(job);
  saveJobs(jobs);

  return job;
}

/**
 * Remove a cron job by ID or ID prefix.
 *
 * @param {string} idOrPrefix - Full UUID or prefix (min 4 chars)
 * @returns {boolean} True if found and removed
 */
export function removeJob(idOrPrefix) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j =>
    j.id === idOrPrefix || j.id.startsWith(idOrPrefix)
  );

  if (idx === -1) return false;

  jobs.splice(idx, 1);
  saveJobs(jobs);
  return true;
}

/**
 * List all cron jobs.
 * @returns {Array} Job objects
 */
export function listJobs() {
  return loadJobs();
}

// ==================== Execution ====================

/**
 * Execute a cron job action.
 *
 * @param {Object} job - Job object
 * @param {Function} [logFn] - Optional log function
 * @param {Object} [context] - Injected dependencies from daemon
 * @param {Function} [context.apiRequest] - API request function
 * @param {Function} [context.spawnHealthCheck] - Spawn a health check Claude session
 */
async function executeAction(job, logFn, context = {}) {
  const log = logFn || (() => {});

  switch (job.action.type) {
    case 'notify':
      sendMacNotification('Push Cron', job.action.content || job.name);
      log(`Cron "${job.name}": notification sent`);
      break;

    case 'create-todo':
      if (context.apiRequest) {
        try {
          const payload = {
            title: job.action.content || job.name,
            normalizedContent: job.action.detail || null,
            isBacklog: job.action.backlog || false,
            createdByClient: 'daemon-cron',
          };
          // Route to a specific project so the daemon can pick it up
          if (job.action.gitRemote) payload.gitRemote = job.action.gitRemote;
          if (job.action.actionType) payload.actionType = job.action.actionType;

          const response = await context.apiRequest('create-todo', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          if (response.ok) {
            const data = await response.json();
            log(`Cron "${job.name}": created todo #${data.todo?.displayNumber || '?'}`);
          } else {
            log(`Cron "${job.name}": create-todo failed (HTTP ${response.status})`);
            // Fall back to notification
            sendMacNotification('Push: Scheduled Todo', job.action.content || job.name);
          }
        } catch (error) {
          log(`Cron "${job.name}": create-todo error: ${error.message}`);
          sendMacNotification('Push: Scheduled Todo', job.action.content || job.name);
        }
      } else {
        sendMacNotification('Push: Scheduled Todo', job.action.content || job.name);
        log(`Cron "${job.name}": todo reminder sent (notification, no API context)`);
      }
      break;

    case 'queue-execution':
      if (!job.action.todoId) {
        log(`Cron "${job.name}": queue-execution requires todoId, skipping`);
      } else if (context.apiRequest) {
        try {
          const response = await context.apiRequest('update-task-execution', {
            method: 'PATCH',
            body: JSON.stringify({
              todoId: job.action.todoId,
              status: 'queued',
            }),
          });
          if (response.ok) {
            log(`Cron "${job.name}": queued todo ${job.action.todoId} for execution`);
          } else {
            log(`Cron "${job.name}": queue-execution failed (HTTP ${response.status})`);
          }
        } catch (error) {
          log(`Cron "${job.name}": queue-execution error: ${error.message}`);
        }
      } else {
        log(`Cron "${job.name}": queue-execution not available (no API context)`);
      }
      break;

    case 'health-check':
      if (context.spawnHealthCheck) {
        try {
          await context.spawnHealthCheck(job, log);
        } catch (error) {
          log(`Cron "${job.name}": health-check error: ${error.message}`);
        }
      } else {
        log(`Cron "${job.name}": health-check not available (no daemon context)`);
      }
      break;

    default:
      log(`Cron "${job.name}": unknown action type "${job.action.type}"`);
  }
}

/**
 * Check for and run any due cron jobs.
 * Called from daemon poll loop on every cycle.
 *
 * @param {Function} [logFn] - Optional log function
 * @param {Object} [context] - Injected dependencies (apiRequest, spawnHealthCheck)
 */
export async function checkAndRunDueJobs(logFn, context = {}) {
  const jobs = loadJobs();
  if (jobs.length === 0) return;

  const now = new Date();
  let modified = false;

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!job.nextRunAt) continue;

    const nextRun = new Date(job.nextRunAt);
    if (nextRun > now) continue;

    // Job is due — execute
    try {
      await executeAction(job, logFn, context);
    } catch (error) {
      if (logFn) logFn(`Cron "${job.name}" execution failed: ${error.message}`);
    }

    // Update timing
    job.lastRunAt = now.toISOString();

    if (job.schedule.type === 'at') {
      // One-shot: disable after run
      job.enabled = false;
      job.nextRunAt = null;
    } else {
      // Recurring: compute next run
      job.nextRunAt = computeNextRun(job.schedule, now);
      if (!job.nextRunAt) {
        job.enabled = false; // No more future runs
      }
    }

    modified = true;
  }

  if (modified) {
    saveJobs(jobs);
  }
}
