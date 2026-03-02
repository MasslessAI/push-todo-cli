/**
 * Schedule engine for Push daemon.
 *
 * Pure scheduling logic (interval parsing, cron expressions, next-run computation)
 * plus the remote schedule checker that polls Supabase.
 *
 * No npm dependencies — includes minimal cron expression parser.
 * Architecture: docs/20260301_system_architecture_complete_reference.md
 */

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

// ==================== Remote Schedules (Supabase) ====================

/**
 * Check for and run any due remote schedules from Supabase.
 * Called from daemon poll loop on every cycle.
 *
 * @param {Function} [logFn] - Optional log function
 * @param {Object} [context] - Injected dependencies from daemon
 * @param {Function} [context.apiRequest] - API request function
 * @param {string} [context.machineId] - This machine's ID for targeted schedule filtering
 */
export async function checkAndRunRemoteSchedules(logFn, context = {}) {
  const log = logFn || (() => {});

  if (!context.apiRequest) return;

  // 1. Fetch due schedules (filtered by machine if available)
  let schedules;
  try {
    let endpoint = 'manage-schedules?due=true';
    if (context.machineId) {
      endpoint += `&machine_id=${encodeURIComponent(context.machineId)}`;
    }
    const response = await context.apiRequest(endpoint, {
      method: 'GET',
    });
    if (!response.ok) {
      log(`Remote schedules: fetch failed (HTTP ${response.status})`);
      return;
    }
    const data = await response.json();
    schedules = data.schedules || [];
  } catch (error) {
    log(`Remote schedules: fetch error: ${error.message}`);
    return;
  }

  if (schedules.length === 0) return;

  log(`Remote schedules: ${schedules.length} due`);

  // 2. Fire each due schedule
  for (const schedule of schedules) {
    const expectedNextRunAt = schedule.next_run_at;
    let actionSucceeded = false;

    try {
      if (schedule.action_type === 'create-todo') {
        // Create a new todo
        const payload = {
          title: schedule.action_title || schedule.name,
          normalizedContent: schedule.action_content || null,
          isBacklog: false,
          createdByClient: 'daemon-schedule',
        };
        if (schedule.git_remote) {
          payload.gitRemote = schedule.git_remote;
          // Use schedule's agent_type instead of hardcoding claude-code
          payload.actionType = schedule.agent_type || 'claude-code';
        }

        const todoResponse = await context.apiRequest('create-todo', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (todoResponse.ok) {
          const todoData = await todoResponse.json();
          log(`Schedule "${schedule.name}": created todo #${todoData.todo?.displayNumber || '?'}`);
          actionSucceeded = true;
        } else {
          log(`Schedule "${schedule.name}": create-todo failed (HTTP ${todoResponse.status})`);
        }

      } else if (schedule.action_type === 'queue-todo') {
        // Re-queue an existing todo
        if (!schedule.todo_id) {
          log(`Schedule "${schedule.name}": queue-todo has no todo_id, disabling`);
          await context.apiRequest('manage-schedules', {
            method: 'PATCH',
            body: JSON.stringify({
              id: schedule.id,
              enabled: false,
              lastRunAt: new Date().toISOString(),
              nextRunAt: null,
            }),
          });
          continue;
        }

        const queueResponse = await context.apiRequest('update-task-execution', {
          method: 'PATCH',
          body: JSON.stringify({
            todoId: schedule.todo_id,
            status: 'queued',
          }),
        });
        if (queueResponse.ok) {
          log(`Schedule "${schedule.name}": queued todo ${schedule.todo_id}`);
          actionSucceeded = true;
        } else {
          log(`Schedule "${schedule.name}": queue-todo failed (HTTP ${queueResponse.status})`);
        }
      }
    } catch (error) {
      log(`Schedule "${schedule.name}": execution error: ${error.message}`);
    }

    // 3. Advance next_run_at only if action succeeded (prevents silent lost fires)
    if (!actionSucceeded) {
      log(`Schedule "${schedule.name}": action failed, will retry next cycle`);
      continue;
    }

    const now = new Date();
    const scheduleConfig = { type: schedule.schedule_type, value: schedule.schedule_value };

    let nextRunAt = null;
    let enabled = true;

    if (schedule.schedule_type === 'at') {
      // One-shot: disable after run
      enabled = false;
    } else {
      // Recurring: compute next run
      nextRunAt = computeNextRun(scheduleConfig, now);
      if (!nextRunAt) {
        enabled = false;
      }
    }

    try {
      await context.apiRequest('manage-schedules', {
        method: 'PATCH',
        body: JSON.stringify({
          id: schedule.id,
          enabled,
          lastRunAt: now.toISOString(),
          nextRunAt,
          expectedNextRunAt,
        }),
      });
    } catch (error) {
      log(`Schedule "${schedule.name}": failed to advance next_run_at: ${error.message}`);
    }
  }
}
