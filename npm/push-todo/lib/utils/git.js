/**
 * Git utilities for Push CLI.
 *
 * Provides helpers for git operations like getting remote URLs.
 */

import { execSync, execFileSync } from 'child_process';

/**
 * Get the normalized git remote URL for the current directory.
 *
 * Normalizes URLs to a consistent format:
 * - git@github.com:user/repo.git → github.com/user/repo
 * - https://github.com/user/repo.git → github.com/user/repo
 *
 * @returns {string|null} Normalized git remote or null if not a git repo
 */
export function getGitRemote() {
  try {
    const result = execSync('git remote get-url origin', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let url = result.trim();
    if (!url) {
      return null;
    }

    // Normalize: remove protocol, convert : to /, remove .git
    // git@github.com:user/repo.git → github.com/user/repo
    // https://github.com/user/repo.git → github.com/user/repo

    // Remove protocol prefixes
    const prefixes = ['https://', 'http://', 'git@', 'ssh://git@'];
    for (const prefix of prefixes) {
      if (url.startsWith(prefix)) {
        url = url.slice(prefix.length);
        break;
      }
    }

    // Convert : to / (for git@ style)
    if (url.includes(':') && !url.includes('://')) {
      url = url.replace(':', '/');
    }

    // Remove .git suffix
    if (url.endsWith('.git')) {
      url = url.slice(0, -4);
    }

    return url;
  } catch {
    return null;
  }
}

/**
 * Check if the current directory is a git repository.
 *
 * @returns {boolean}
 */
export function isGitRepo() {
  try {
    execSync('git rev-parse --git-dir', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current git branch name.
 *
 * @returns {string|null}
 */
export function getCurrentBranch() {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the root directory of the git repository.
 *
 * @returns {string|null}
 */
export function getGitRoot() {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get recent commit messages for context.
 *
 * @param {number} count - Number of commits to fetch
 * @returns {string[]} Array of commit messages
 */
export function getRecentCommits(count = 5) {
  try {
    const result = execSync(`git log --oneline -${count}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if there are uncommitted changes.
 *
 * @returns {boolean}
 */
export function hasUncommittedChanges() {
  try {
    const result = execSync('git status --porcelain', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the normalized git remote URL for a specific directory path.
 *
 * Uses execFileSync (no shell) for safe execution with untrusted paths.
 *
 * @param {string} projectPath - Absolute path to the project directory
 * @returns {string|null} Normalized git remote or null if not a git repo / no remote
 */
export function getGitRemoteForPath(projectPath) {
  try {
    const result = execFileSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const url = result.trim();
    if (!url) return null;

    return normalizeGitRemote(url);
  } catch {
    return null;
  }
}

/**
 * Normalize a git remote URL to a consistent format.
 *
 * Converts various URL formats to: host/owner/repo
 * - git@github.com:user/repo.git → github.com/user/repo
 * - https://github.com/user/repo.git → github.com/user/repo
 * - ssh://git@github.com/user/repo → github.com/user/repo
 *
 * @param {string} url - The git remote URL to normalize
 * @returns {string} Normalized URL
 */
export function normalizeGitRemote(url) {
  if (!url) return url;

  let normalized = url.trim();

  // Remove protocol prefixes
  const prefixes = ['https://', 'http://', 'git@', 'ssh://git@', 'ssh://'];
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length);
      break;
    }
  }

  // Convert : to / (for git@ style URLs like git@github.com:user/repo)
  if (normalized.includes(':') && !normalized.includes('://')) {
    normalized = normalized.replace(':', '/');
  }

  // Remove .git suffix
  if (normalized.endsWith('.git')) {
    normalized = normalized.slice(0, -4);
  }

  // Remove trailing slash
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}
