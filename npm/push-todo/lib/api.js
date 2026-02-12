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

export { API_BASE };
