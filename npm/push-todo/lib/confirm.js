/**
 * Remote confirmation command for Push CLI.
 *
 * Requests user confirmation before irreversible external actions.
 * Claude calls `push-todo confirm --type X --title Y --content Z`
 * which blocks until the user approves or rejects from the iOS app.
 *
 * See: docs/20260212_remote_confirmation_protocol_architecture.md
 */

import { getApiKey } from './config.js';
import { getMachineName } from './machine-id.js';
import { bold, red, cyan, dim, green, yellow } from './utils/colors.js';

const API_BASE = 'https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1';

const POLL_INTERVAL_MS = 3000;

/**
 * Make an authenticated API request to the Push backend.
 */
async function apiRequest(endpoint, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No API key configured. Run "push-todo connect" first.');
  }

  const url = `${API_BASE}/${endpoint}`;
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

/**
 * Request confirmation and poll until user responds.
 *
 * @param {Object} values - Parsed CLI values
 * @param {string[]} positionals - Positional arguments
 */
export async function requestConfirmation(values, positionals) {
  const type = values.type;
  const title = values.title;
  const content = values.content;
  const metadataStr = values.metadata;
  const taskArg = values.task;

  // Validate required fields
  if (!type || !title || !content) {
    console.error(red('Error: --type, --title, and --content are required.'));
    console.error('');
    console.error('Usage:');
    console.error('  push-todo confirm --type "social_post" --title "Reply to @user" --content "Your reply text..."');
    console.error('');
    console.error('Options:');
    console.error('  --type      Confirmation category (social_post, email, publish, etc.)');
    console.error('  --title     Short description of the action');
    console.error('  --content   The actual content to be confirmed');
    console.error('  --metadata  Optional JSON metadata for rich rendering');
    console.error('  --task      Display number (auto-detected from PUSH_DISPLAY_NUMBER)');
    process.exit(1);
  }

  // Resolve display number: explicit --task > PUSH_DISPLAY_NUMBER env
  let displayNumber = taskArg ? parseInt(taskArg, 10) : null;
  let todoId = null;

  if (!displayNumber) {
    const envDisplayNumber = process.env.PUSH_DISPLAY_NUMBER;
    if (envDisplayNumber) {
      displayNumber = parseInt(envDisplayNumber, 10);
    }
  }

  if (!displayNumber) {
    todoId = process.env.PUSH_TASK_ID || null;
  }

  if (!displayNumber && !todoId) {
    console.error(red('Error: Cannot determine task. Use --task <number> or set PUSH_DISPLAY_NUMBER env.'));
    process.exit(1);
  }

  // Parse metadata if provided
  let metadata = null;
  if (metadataStr) {
    try {
      metadata = JSON.parse(metadataStr);
    } catch {
      console.error(red('Error: --metadata must be valid JSON.'));
      process.exit(1);
    }
  }

  const machineName = getMachineName() || null;

  // Build request payload
  const payload = {
    type,
    title,
    body: content,
  };
  if (displayNumber) payload.displayNumber = displayNumber;
  if (todoId) payload.todoId = todoId;
  if (metadata) payload.metadata = metadata;
  if (machineName) payload.machineName = machineName;

  // Send confirmation request
  console.error(`[push-confirm] Requesting confirmation for task #${displayNumber || '?'}...`);
  console.error(`[push-confirm] Type: ${type}`);
  console.error(`[push-confirm] Title: ${title}`);
  console.error(`[push-confirm] Content: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`);

  let confirmationId;
  try {
    const response = await apiRequest('request-confirmation', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(red(`[push-confirm] Failed to request confirmation: ${text}`));
      // Output JSON for Claude to parse
      console.log(JSON.stringify({ approved: false, error: `Request failed: ${text}` }));
      process.exit(1);
    }

    const data = await response.json();
    confirmationId = data.confirmationId;
    console.error(`[push-confirm] Confirmation ID: ${confirmationId}`);
    console.error(`[push-confirm] Waiting for user response on iPhone...`);
  } catch (err) {
    console.error(red(`[push-confirm] Error: ${err.message}`));
    console.log(JSON.stringify({ approved: false, error: err.message }));
    process.exit(1);
  }

  // Poll for response
  const taskFilter = displayNumber
    ? `display_number=${displayNumber}`
    : `todo_id=${todoId}`;

  while (true) {
    try {
      const response = await apiRequest(`synced-todos?${taskFilter}`);

      if (!response.ok) {
        console.error(dim(`[push-confirm] Poll error (${response.status}), retrying...`));
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const data = await response.json();
      const todos = data.todos || [];

      if (todos.length === 0) {
        console.error(dim(`[push-confirm] Task not found, retrying...`));
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const todo = todos[0];

      // Check if confirmation was responded to
      if (todo.executionStatus !== 'awaiting_confirmation') {
        // Confirmation was responded to — check events for the result
        const approved = wasApproved(todo, confirmationId);

        if (approved) {
          console.error(green(`[push-confirm] Approved by user.`));
          console.log(JSON.stringify({ approved: true, message: 'Confirmed by user' }));
          process.exit(0);
        } else {
          console.error(yellow(`[push-confirm] Rejected by user.`));
          console.log(JSON.stringify({ approved: false, message: 'Rejected by user' }));
          process.exit(1);
        }
      }

      // Still waiting
      await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      console.error(dim(`[push-confirm] Poll error: ${err.message}, retrying...`));
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

/**
 * Check execution events to determine if confirmation was approved.
 */
function wasApproved(todo, confirmationId) {
  try {
    const events = todo.executionEventsJson
      ? (typeof todo.executionEventsJson === 'string'
        ? JSON.parse(todo.executionEventsJson)
        : todo.executionEventsJson)
      : [];

    // Find the most recent confirmation response event
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'confirmation_approved') {
        return true;
      }
      if (event.type === 'confirmation_rejected') {
        return false;
      }
    }
  } catch {
    // Parse error — fall through
  }

  // If no event found but status changed from awaiting_confirmation,
  // check if pendingConfirmation was cleared (approved is more likely)
  return !todo.pendingConfirmation;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
