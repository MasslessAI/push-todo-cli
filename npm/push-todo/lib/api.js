/**
 * Supabase API client for Push CLI.
 *
 * Handles all HTTP requests to the Push backend.
 */

import { getApiKey } from './config.js';

const API_BASE = 'https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1';

/**
 * Make an authenticated API request.
 *
 * @param {string} endpoint - API endpoint (without base URL)
 * @param {Object} options - Fetch options
 * @returns {Promise<Response>}
 */
async function apiRequest(endpoint, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No API key configured. Run "push-todo connect" first.');
  }

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}/${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  return response;
}

/**
 * Fetch tasks from the API.
 *
 * @param {string|null} gitRemote - Git remote to filter by (null for all projects)
 * @param {Object} options - Query options
 * @param {boolean} options.backlogOnly - Only return backlog items
 * @param {boolean} options.includeBacklog - Include backlog items
 * @param {boolean} options.completedOnly - Only return completed items
 * @param {boolean} options.includeCompleted - Include completed items
 * @returns {Promise<Object[]>} Array of todo objects
 */
export async function fetchTasks(gitRemote, options = {}) {
  const params = new URLSearchParams();

  if (options.actionId) {
    params.set('action_id', options.actionId);
  } else if (gitRemote) {
    params.set('git_remote', gitRemote);
  }
  if (options.actionType) {
    params.set('action_type', options.actionType);
  }
  if (options.backlogOnly) {
    params.set('later_only', 'true');
  }
  if (options.includeBacklog) {
    params.set('include_later', 'true');
  }
  if (options.completedOnly) {
    params.set('completed_only', 'true');
  }
  if (options.includeCompleted) {
    params.set('include_completed', 'true');
  }

  const queryString = params.toString();
  const endpoint = queryString ? `synced-todos?${queryString}` : 'synced-todos';

  const response = await apiRequest(endpoint);

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid API key. Run "push-todo connect" to re-authenticate.');
    }
    if (response.status === 404) {
      return [];
    }
    const text = await response.text();
    throw new Error(`API error (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.todos || [];
}

/**
 * Fetch a specific task by display number.
 *
 * @param {number} displayNumber - The task's display number
 * @returns {Promise<Object|null>} Task object or null if not found
 */
export async function fetchTaskByNumber(displayNumber) {
  const response = await apiRequest(`synced-todos?display_number=${displayNumber}`);

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid API key. Run "push-todo connect" to re-authenticate.');
    }
    if (response.status === 404) {
      return null;
    }
    const text = await response.text();
    throw new Error(`API error (${response.status}): ${text}`);
  }

  const data = await response.json();
  const todos = data.todos || [];
  return todos.length > 0 ? todos[0] : null;
}

/**
 * Mark a task as completed.
 *
 * @param {string} taskId - UUID of the task
 * @param {string} comment - Completion comment
 * @returns {Promise<boolean>} True if successful
 */
export async function markTaskCompleted(taskId, comment = '') {
  const payload = {
    todoId: taskId,
    isCompleted: true,
    completedAt: new Date().toISOString()
  };

  // Add completion comment if provided (appears in Push app timeline)
  if (comment) {
    payload.completionComment = comment;
  }

  const response = await apiRequest('todo-status', {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to mark task completed: ${text}`);
  }

  return true;
}

/**
 * Create a new todo.
 *
 * @param {Object} options - Todo creation options
 * @param {string} options.title - Todo title (required)
 * @param {string|null} options.content - Detailed content (optional)
 * @param {boolean} options.backlog - Whether to create as backlog item
 * @returns {Promise<Object>} Created todo with { id, displayNumber, title, createdAt }
 */
export async function createTodo({ title, content = null, backlog = false }) {
  const response = await apiRequest('create-todo', {
    method: 'POST',
    body: JSON.stringify({
      title,
      normalizedContent: content || null,
      isBacklog: backlog,
      createdByClient: 'cli',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create todo: ${text}`);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || 'Unknown error creating todo');
  }

  return data.todo;
}

/**
 * Queue a task for daemon execution.
 *
 * Sets execution_status to 'queued' via the update-task-execution endpoint.
 * The daemon will pick it up on next poll.
 *
 * @param {number} displayNumber - The task's display number
 * @returns {Promise<boolean>} True if successful
 */
export async function queueTask(displayNumber) {
  const response = await apiRequest('update-task-execution', {
    method: 'PATCH',
    body: JSON.stringify({
      displayNumber: displayNumber,
      status: 'queued'
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to queue task: ${text}`);
  }

  const data = await response.json();
  return data.success || false;
}

/**
 * Queue multiple tasks for daemon execution.
 *
 * @param {number[]} displayNumbers - Array of display numbers
 * @returns {Promise<Object>} Result with success/failure counts
 */
export async function queueTasks(displayNumbers) {
  const results = {
    success: [],
    failed: []
  };

  for (const num of displayNumbers) {
    try {
      await queueTask(num);
      results.success.push(num);
    } catch (error) {
      results.failed.push({ num, error: error.message });
    }
  }

  return results;
}

/**
 * Search tasks by query.
 *
 * @param {string} query - Search query
 * @param {string|null} gitRemote - Git remote to filter by
 * @returns {Promise<Object[]>} Array of matching tasks
 */
export async function searchTasks(query, gitRemote = null) {
  const params = new URLSearchParams();
  params.set('q', query);  // Edge function expects 'q', not 'query'
  if (gitRemote) {
    params.set('git_remote', gitRemote);
  }

  const response = await apiRequest(`search-todos?${params}`);

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid API key. Run "push-todo connect" to re-authenticate.');
    }
    const text = await response.text();
    throw new Error(`Search failed: ${text}`);
  }

  const data = await response.json();
  return data.results || [];
}

/**
 * Update task execution status.
 *
 * @param {Object} payload - Execution update payload
 * @returns {Promise<boolean>} True if successful
 */
export async function updateTaskExecution(payload) {
  const response = await apiRequest('update-task-execution', {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update execution: ${text}`);
  }

  return true;
}

/**
 * Validate API key.
 *
 * Uses synced-todos with limit=0 as a lightweight validation check.
 * This matches the Python implementation approach.
 *
 * @returns {Promise<Object>} Validation result with user info
 */
export async function validateApiKey() {
  try {
    // Use synced-todos with limit=0 as lightweight validation
    // (no validate-api-key endpoint exists)
    const response = await apiRequest('synced-todos?limit=0');

    if (!response.ok) {
      if (response.status === 401) {
        return { valid: false, reason: 'invalid_key' };
      }
      return { valid: false, reason: 'api_error' };
    }

    // Key is valid if request succeeds
    // Note: synced-todos doesn't return user info, so we mark as valid without email
    return {
      valid: true
    };
  } catch (error) {
    return { valid: false, reason: 'network_error', error: error.message };
  }
}

/**
 * Register a project with the backend.
 *
 * @param {string} gitRemote - Normalized git remote
 * @param {string[]} keywords - Project keywords
 * @param {string} description - Project description
 * @returns {Promise<boolean>} True if successful
 */
export async function registerProject(gitRemote, keywords = [], description = '') {
  const response = await apiRequest('register-project', {
    method: 'POST',
    body: JSON.stringify({
      git_remote: gitRemote,
      keywords,
      description
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to register project: ${text}`);
  }

  return true;
}


/**
 * Get the current CLI version from the server.
 *
 * @returns {Promise<string>} Latest version string
 */
export async function getLatestVersion() {
  try {
    const response = await fetch('https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main/npm/push-todo/package.json');
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data.version;
  } catch {
    return null;
  }
}

/**
 * Learn vocabulary terms for a task.
 *
 * The LLM determines WHAT keywords to send; this function handles HOW.
 *
 * @param {string} todoId - UUID of the task
 * @param {string[]} keywords - List of vocabulary terms
 * @returns {Promise<Object>} Result with keywords_added, keywords_duplicate, etc.
 */
export async function learnVocabulary(todoId, keywords) {
  const response = await apiRequest('learn-keywords', {
    method: 'POST',
    body: JSON.stringify({
      todo_id: todoId,
      keywords
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to learn vocabulary: ${text}`);
  }

  return response.json();
}

// ==================== Phase 3: Extended Skill CLI ====================

/**
 * Report structured progress for a running task.
 * Called by the agent during execution to push activity updates to Supabase.
 *
 * @param {string} todoId - UUID of the task
 * @param {Object} options - Progress details
 * @param {string} options.phase - Current phase (e.g., "testing", "implementing")
 * @param {string} [options.detail] - Human-readable detail
 * @returns {Promise<Object>}
 */
export async function reportProgress(todoId, { phase, detail }) {
  const response = await apiRequest('update-task-execution', {
    method: 'PATCH',
    body: JSON.stringify({
      todoId,
      event: {
        type: 'progress',
        timestamp: new Date().toISOString(),
        summary: detail ? `${phase}: ${detail}` : phase,
        phase
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to report progress: ${text}`);
  }

  return response.json();
}

/**
 * Update execution status/phase for a running task.
 *
 * @param {string} todoId - UUID of the task
 * @param {string} status - New phase label (e.g., "implementing", "testing", "reviewing")
 * @returns {Promise<Object>}
 */
export async function updateStatus(todoId, status) {
  const response = await apiRequest('update-task-execution', {
    method: 'PATCH',
    body: JSON.stringify({
      todoId,
      event: {
        type: 'progress',
        timestamp: new Date().toISOString(),
        summary: `Phase: ${status}`
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update status: ${text}`);
  }

  return response.json();
}

/**
 * Check for messages from the human for a running task.
 * Returns pending messages or empty array.
 *
 * @param {string} todoId - UUID of the task
 * @returns {Promise<Object[]>} Array of pending messages
 */
export async function checkMessages(todoId) {
  const params = new URLSearchParams({ todo_id: todoId, direction: 'to_agent' });
  const response = await apiRequest(`task-messages?${params}`, {
    method: 'GET'
  });

  if (!response.ok) {
    // 404 = no task_messages table/function yet — return empty gracefully
    if (response.status === 404) return [];
    const text = await response.text();
    throw new Error(`Failed to check messages: ${text}`);
  }

  const result = await response.json();
  return result.messages || [];
}

/**
 * Request input from the human for a running task.
 * Posts a question and polls until the human responds or timeout.
 *
 * @param {string} todoId - UUID of the task
 * @param {string} question - Question to ask the human
 * @param {number} [timeoutMs=300000] - Timeout in ms (default 5 min)
 * @returns {Promise<string|null>} Human's response or null if timeout
 */
export async function requestInput(todoId, question, timeoutMs = 300000) {
  // Post the question
  const postResponse = await apiRequest('task-messages', {
    method: 'POST',
    body: JSON.stringify({
      todo_id: todoId,
      direction: 'to_human',
      message: question,
      type: 'input_request'
    })
  });

  if (!postResponse.ok) {
    // 404 = task-messages endpoint not deployed yet
    if (postResponse.status === 404) {
      console.error('Message system not available yet. Use [push-confirm] pattern instead.');
      return null;
    }
    const text = await postResponse.text();
    throw new Error(`Failed to request input: ${text}`);
  }

  const { message_id } = await postResponse.json();

  // Poll for response
  const startTime = Date.now();
  const pollInterval = 5000; // 5s

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const checkResponse = await apiRequest(`task-messages?message_id=${message_id}&direction=to_agent`, {
      method: 'GET'
    });

    if (checkResponse.ok) {
      const result = await checkResponse.json();
      const reply = (result.messages || []).find(m => m.in_reply_to === message_id);
      if (reply) return reply.message;
    }
  }

  return null; // Timeout
}

export { API_BASE };
