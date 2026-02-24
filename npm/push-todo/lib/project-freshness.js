/**
 * Project freshness checker for Push daemon.
 *
 * Checks if registered projects are behind their remote and optionally
 * pulls updates via rebase. Only updates when the working tree is clean
 * and no daemon tasks are running for that project.
 *
 * Pattern: follows heartbeat.js — pure functions, internally throttled, non-fatal.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

// ==================== Configuration ====================

const FRESHNESS_CHECK_INTERVAL = 3600000; // 1 hour

// ==================== Internal State ====================

let lastFreshnessCheck = 0;

// ==================== Git Helpers ====================

/**
 * Get the default branch for a repository (main or master).
 *
 * @param {string} projectPath
 * @returns {string|null}
 */
function getDefaultBranch(projectPath) {
  try {
    // Try symbolic-ref to origin/HEAD first
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectPath,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // "refs/remotes/origin/main" → "main"
    return ref.split('/').pop();
  } catch {
    // Fallback: check if main or master exists
    for (const branch of ['main', 'master']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
          cwd: projectPath,
          timeout: 5000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return branch;
      } catch {}
    }
    return null;
  }
}

/**
 * Get the currently checked-out branch.
 *
 * @param {string} projectPath
 * @returns {string|null}
 */
function getCurrentBranch(projectPath) {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd: projectPath,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if the working tree is clean (no uncommitted changes).
 *
 * @param {string} projectPath
 * @returns {boolean}
 */
function isWorkingTreeClean(projectPath) {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectPath,
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return status === '';
  } catch {
    return false;
  }
}

/**
 * Fetch from remote (quiet, non-interactive).
 *
 * @param {string} projectPath
 * @returns {boolean} true if fetch succeeded
 */
function gitFetch(projectPath) {
  try {
    execFileSync('git', ['fetch', '--quiet'], {
      cwd: projectPath,
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Count how many commits the local branch is behind the remote.
 *
 * @param {string} projectPath
 * @param {string} branch
 * @returns {number} commits behind, or -1 on error
 */
function commitsBehind(projectPath, branch) {
  try {
    const output = execFileSync('git', [
      'rev-list', '--count', `${branch}..origin/${branch}`
    ], {
      cwd: projectPath,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return parseInt(output, 10) || 0;
  } catch {
    return -1;
  }
}

// ==================== Freshness Check ====================

/**
 * Check and optionally update a single project.
 *
 * @param {string} projectPath - Absolute path to the project
 * @param {Object} options
 * @param {boolean} options.autoRebase - If true, pull --rebase when behind
 * @param {Set<string>} options.busyPaths - Paths with running tasks (skip these)
 * @param {Function} options.log - Logging function
 * @returns {{ status: string, behind?: number, updated?: boolean, error?: string }}
 */
export function checkProjectFreshness(projectPath, { autoRebase = false, busyPaths = new Set(), log = () => {} } = {}) {
  if (!existsSync(join(projectPath, '.git'))) {
    return { status: 'not_a_repo' };
  }

  const defaultBranch = getDefaultBranch(projectPath);
  if (!defaultBranch) {
    return { status: 'no_default_branch' };
  }

  const currentBranch = getCurrentBranch(projectPath);

  // Fetch latest from remote
  if (!gitFetch(projectPath)) {
    return { status: 'fetch_failed' };
  }

  // Check how far behind the default branch is
  const behind = commitsBehind(projectPath, defaultBranch);
  if (behind < 0) {
    return { status: 'compare_failed' };
  }

  if (behind === 0) {
    return { status: 'up_to_date', behind: 0 };
  }

  // Project is behind — decide whether to auto-update
  if (!autoRebase) {
    return { status: 'behind', behind };
  }

  // Skip if tasks are running in this project
  if (busyPaths.has(projectPath)) {
    log(`Freshness: ${projectPath} is ${behind} commit(s) behind but has running tasks — skipping rebase`);
    return { status: 'behind_busy', behind };
  }

  // Skip if not on default branch (user is on a feature branch)
  if (currentBranch !== defaultBranch) {
    log(`Freshness: ${projectPath} is ${behind} commit(s) behind but on branch '${currentBranch}' — skipping rebase`);
    return { status: 'behind_wrong_branch', behind, currentBranch };
  }

  // Skip if working tree is dirty
  if (!isWorkingTreeClean(projectPath)) {
    log(`Freshness: ${projectPath} is ${behind} commit(s) behind but working tree is dirty — skipping rebase`);
    return { status: 'behind_dirty', behind };
  }

  // Safe to rebase
  try {
    execFileSync('git', ['pull', '--rebase', '--quiet'], {
      cwd: projectPath,
      timeout: 60000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log(`Freshness: ${projectPath} updated (${behind} commit(s) rebased)`);
    return { status: 'updated', behind, updated: true };
  } catch (err) {
    // Abort failed rebase to leave tree clean
    try {
      execFileSync('git', ['rebase', '--abort'], {
        cwd: projectPath,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {}
    log(`Freshness: ${projectPath} rebase failed — aborted. Error: ${err.message}`);
    return { status: 'rebase_failed', behind, error: err.message };
  }
}

/**
 * Check freshness of all registered projects (internally throttled).
 *
 * @param {Object} config
 * @param {Object.<string, string>} config.projects - gitRemote → localPath mapping
 * @param {boolean} config.autoRebase - Whether to auto-pull when behind
 * @param {Set<string>} config.busyPaths - Paths with running tasks
 * @param {Function} config.log - Logging function
 * @param {boolean} [config.force] - Skip throttle
 * @returns {Object.<string, Object>|null} Results per project path, or null if throttled
 */
export function checkAllProjectsFreshness(config) {
  const { projects, autoRebase = false, busyPaths = new Set(), log = () => {}, force = false } = config;
  const now = Date.now();

  if (!force && (now - lastFreshnessCheck < FRESHNESS_CHECK_INTERVAL)) {
    return null; // throttled
  }
  lastFreshnessCheck = now;

  const results = {};
  const paths = Object.values(projects);

  for (const projectPath of paths) {
    results[projectPath] = checkProjectFreshness(projectPath, {
      autoRebase,
      busyPaths,
      log,
    });
  }

  // Log summary
  const behindCount = Object.values(results).filter(r =>
    r.status === 'behind' || r.status === 'behind_busy' ||
    r.status === 'behind_dirty' || r.status === 'behind_wrong_branch'
  ).length;
  const updatedCount = Object.values(results).filter(r => r.status === 'updated').length;

  if (behindCount > 0 || updatedCount > 0) {
    log(`Freshness: ${updatedCount} project(s) updated, ${behindCount} behind`);
  }

  return results;
}
