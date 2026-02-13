/**
 * Output formatting utilities for Push CLI.
 *
 * Formats tasks and other data for display.
 */

import { bold, dim, green, yellow, red, cyan, muted, symbols } from './colors.js';

/**
 * Parse a JSON string field into an array. Handles strings, arrays, null/undefined.
 */
function parseJsonField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

/**
 * Format a duration in seconds to human-readable string.
 *
 * @param {number} seconds
 * @returns {string} e.g., "2h 30m", "5m", "45s"
 */
export function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs ? `${mins}m ${secs}s` : `${mins}m`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
  }
}

/**
 * Format a date for display.
 *
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string}
 */
export function formatDate(date) {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString();
}

/**
 * Format a task for human-readable display.
 *
 * @param {Object} task - Task object
 * @returns {string} Formatted task string
 */
export function formatTaskForDisplay(task) {
  const lines = [];

  // Build task header with display number and status indicator
  const displayNum = task.displayNumber || task.display_number;

  // Determine status prefix
  const execStatus = task.executionStatus || task.execution_status;
  let statusPrefix = '';
  if (task.isCompleted || task.is_completed) {
    statusPrefix = '✅ '; // Completed
  } else if (execStatus === 'running') {
    statusPrefix = '🔄 '; // Running on Mac
  } else if (execStatus === 'queued') {
    statusPrefix = '⚡ '; // Queued for Mac
  } else if (execStatus === 'session_finished') {
    statusPrefix = '🏁 '; // Session finished on Mac
  } else if (execStatus === 'failed') {
    statusPrefix = '❌ '; // Failed
  } else if (execStatus === 'needs_clarification') {
    statusPrefix = '❓ '; // Needs clarification
  } else if (task.isBacklog || task.is_backlog) {
    statusPrefix = '📦 '; // Backlog
  }

  const numPrefix = displayNum ? `#${displayNum} ` : '';
  const summary = task.summary || 'No summary';

  lines.push(`## Task: ${numPrefix}${statusPrefix}${summary}`);
  lines.push('');

  // Project hint
  if (task.projectHint || task.project_hint) {
    lines.push(`**Project:** ${task.projectHint || task.project_hint}`);
    lines.push('');
  }

  // Content
  lines.push('### Content');
  lines.push(task.content || task.normalizedContent || 'No content');
  lines.push('');

  // Attachments — API returns JSON strings (screenshotAttachmentsJson, linkAttachmentsJson)
  const screenshots = parseJsonField(task.screenshotAttachmentsJson || task.screenshotAttachments || task.screenshot_attachments);
  const links = parseJsonField(task.linkAttachmentsJson || task.linkAttachments || task.link_attachments);

  if (screenshots.length > 0 || links.length > 0) {
    lines.push('### Attachments');
    lines.push('');

    if (screenshots.length > 0) {
      lines.push(`#### Screenshots (${screenshots.length})`);
      screenshots.forEach((screenshot, idx) => {
        const filename = screenshot.imageFilename || 'unknown';
        const width = screenshot.width;
        const height = screenshot.height;
        const dimensions = width && height ? `(${width}x${height})` : '';
        lines.push(`${idx + 1}. ${filename} ${dimensions}`);
      });
      lines.push('');
    }

    if (links.length > 0) {
      lines.push(`#### Links (${links.length})`);
      links.forEach(link => {
        const url = link.url || '';
        const title = link.title || url;
        lines.push(`🔗 [${title}](${url})`);
      });
      lines.push('');
    }
  }

  // Transcript
  const transcript = task.transcript || task.originalTranscript;
  if (transcript) {
    lines.push('### Original Voice Transcript');
    lines.push(`> ${transcript}`);
    lines.push('');
  }

  // Metadata
  lines.push(`**Task ID:** \`${task.id || 'unknown'}\``);
  if (displayNum) {
    lines.push(`**Display Number:** #${displayNum}`);
  }

  // Status
  if (task.isCompleted || task.is_completed) {
    lines.push('**Status:** ✅ Completed');
  } else if (execStatus === 'running') {
    lines.push('**Status:** 🔄 Running');
  } else if (execStatus === 'queued') {
    lines.push('**Status:** ⚡ Queued for Mac execution');
  } else if (execStatus === 'session_finished') {
    lines.push('**Status:** 🏁 Session finished');
  } else if (execStatus === 'failed') {
    const error = task.executionError || task.execution_error || 'Unknown error';
    lines.push(`**Status:** ❌ Failed: ${error}`);
  } else if (task.isBacklog || task.is_backlog) {
    lines.push('**Status:** 📦 Backlog');
  } else {
    lines.push('**Status:** Active');
  }

  // Show execution summary (semantic + machine metadata)
  const execSummary = task.executionSummary || task.execution_summary;
  if (execSummary) {
    lines.push('');
    lines.push('### What was done');
    for (const line of execSummary.split('\n').filter(Boolean)) {
      lines.push(`> ${line}`);
    }
  }

  // Show session resume hint for any task with a session ID
  const sessionId = task.executionSessionId || task.execution_session_id;
  if (sessionId && displayNum) {
    lines.push(`**Session:** Resumable (\`push-todo resume ${displayNum}\`) - continues the exact Claude Code conversation`);
  }

  // Context app — which app the user was in when creating the task
  const contextApp = task.contextApp || task.context_app;
  if (contextApp) {
    lines.push(`**Context App:** ${contextApp}`);
  }

  const createdAt = task.createdAt || task.created_at;
  lines.push(`**Created:** ${createdAt || 'unknown'}`);

  return lines.join('\n');
}

/**
 * Format a search result for display.
 *
 * @param {Object} result - Search result object
 * @returns {string}
 */
export function formatSearchResult(result) {
  const lines = [];

  const displayNum = result.displayNumber;
  const isCompleted = result.isCompleted;
  const isBacklog = result.isBacklog;

  // Status indicators
  let status = '';
  if (isCompleted) {
    status = ' [COMPLETED]';
  } else if (isBacklog) {
    status = ' [BACKLOG]';
  }

  const numPrefix = displayNum ? `#${displayNum}` : '??';
  const title = result.summary || result.title || 'No summary';

  lines.push(`**${numPrefix}**${status} ${title}`);

  // Show match context if available
  const matchContext = result.matchContext;
  if (matchContext) {
    lines.push(`  > ${matchContext}`);
  }

  return lines.join('\n');
}

/**
 * Format a task list as a table.
 *
 * @param {Object[]} tasks - Array of tasks
 * @returns {string}
 */
export function formatTaskTable(tasks) {
  if (tasks.length === 0) {
    return 'No tasks found.';
  }

  const lines = [];
  lines.push('| #   | Task                          | Status    |');
  lines.push('|-----|-------------------------------|-----------|');

  for (const task of tasks) {
    const num = String(task.displayNumber || task.display_number || '?').padEnd(3);
    let summary = (task.summary || 'No summary').slice(0, 28);
    if (summary.length < 28) {
      summary = summary.padEnd(28);
    } else {
      summary = summary.slice(0, 27) + '…';
    }

    const taskExecStatus = task.executionStatus || task.execution_status;
    let status = 'Active';
    if (task.isCompleted || task.is_completed) {
      status = '✅ Done';
    } else if (taskExecStatus === 'running') {
      status = '🔄 Running';
    } else if (taskExecStatus === 'queued') {
      status = '⚡ Queued';
    } else if (taskExecStatus === 'session_finished') {
      status = '🏁 Finished';
    } else if (taskExecStatus === 'failed') {
      status = '❌ Failed';
    } else if (task.isBacklog || task.is_backlog) {
      status = '📦 Later';
    }
    status = status.padEnd(9);

    lines.push(`| ${num} | ${summary} | ${status} |`);
  }

  return lines.join('\n');
}

/**
 * Format batch offer for display.
 *
 * @param {Object[]} tasks - Tasks to offer
 * @returns {string}
 */
export function formatBatchOffer(tasks) {
  const count = tasks.length;
  const numbers = tasks.map(t => t.displayNumber || t.display_number).join(',');

  const lines = [];
  lines.push('='.repeat(50));
  lines.push(`BATCH_OFFER: ${count}`);
  lines.push(`BATCH_TASKS: ${numbers}`);

  for (const task of tasks) {
    const num = task.displayNumber || task.display_number;
    const summary = (task.summary || 'No summary').slice(0, 50);
    lines.push(`  #${num} - ${summary}`);
  }

  lines.push('='.repeat(50));

  return lines.join('\n');
}

/**
 * Truncate a string to a maximum length.
 *
 * @param {string} str
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(str, maxLength) {
  if (!str || str.length <= maxLength) {
    return str || '';
  }
  return str.slice(0, maxLength - 1) + '…';
}
