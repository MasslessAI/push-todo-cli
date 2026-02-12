/**
 * Project Registry for Push CLI.
 *
 * Maps git_remote to local paths for global daemon routing.
 * Enables the daemon to route tasks to the correct project directory.
 *
 * File location: ~/.config/push/projects.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const REGISTRY_FILE = join(homedir(), '.config', 'push', 'projects.json');
const REGISTRY_VERSION = 2;

/**
 * Project Registry class.
 * Manages the local project registry for global daemon routing.
 */
class ProjectRegistry {
  constructor() {
    this._ensureConfigDir();
    this._data = this._load();
  }

  _ensureConfigDir() {
    const dir = join(homedir(), '.config', 'push');
    mkdirSync(dir, { recursive: true });
  }

  _load() {
    if (!existsSync(REGISTRY_FILE)) {
      return {
        version: REGISTRY_VERSION,
        projects: {},
        defaultProject: null
      };
    }

    try {
      const content = readFileSync(REGISTRY_FILE, 'utf8');
      const data = JSON.parse(content);

      // Migration: handle older versions if needed
      if ((data.version || 0) < REGISTRY_VERSION) {
        return this._migrate(data);
      }

      return data;
    } catch {
      return {
        version: REGISTRY_VERSION,
        projects: {},
        defaultProject: null
      };
    }
  }

  _save() {
    writeFileSync(REGISTRY_FILE, JSON.stringify(this._data, null, 2));
  }

  _migrate(data) {
    const oldVersion = data.version || 0;

    // V1 → V2: Add actionType to project keys
    // V1 keys: "github.com/user/repo" → V2 keys: "github.com/user/repo::claude-code"
    // All V1 projects were Claude Code (the only agent type that existed)
    if (oldVersion < 2 && data.projects) {
      const newProjects = {};
      for (const [key, info] of Object.entries(data.projects)) {
        // Skip if already in V2 format (contains ::)
        if (key.includes('::')) {
          newProjects[key] = { ...info, gitRemote: info.gitRemote || key.split('::')[0] };
          continue;
        }
        const v2Key = `${key}::claude-code`;
        newProjects[v2Key] = {
          ...info,
          gitRemote: key,
          actionType: 'claude-code',
          actionId: null,
          actionName: null,
        };
      }
      data.projects = newProjects;

      // Migrate defaultProject key too
      if (data.defaultProject && !data.defaultProject.includes('::')) {
        data.defaultProject = `${data.defaultProject}::claude-code`;
      }
    }

    data.version = REGISTRY_VERSION;
    // Persist the migrated data immediately
    writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
    return data;
  }

  /**
   * Build the composite key for a project entry.
   * Format: "gitRemote::actionType" (e.g., "github.com/user/repo::claude-code")
   *
   * @param {string} gitRemote - Normalized git remote
   * @param {string} actionType - Action type (e.g., "claude-code", "openclaw")
   * @returns {string}
   */
  _makeKey(gitRemote, actionType) {
    return `${gitRemote}::${actionType || 'claude-code'}`;
  }

  /**
   * Register a project.
   *
   * @param {string} gitRemote - Normalized git remote (e.g., "github.com/user/repo")
   * @param {string} localPath - Absolute local path
   * @param {Object} [actionMeta] - Action metadata from register-project response
   * @param {string} [actionMeta.actionType] - Action type (e.g., "claude-code", "openclaw")
   * @param {string} [actionMeta.actionId] - Action UUID
   * @param {string} [actionMeta.actionName] - Action display name
   * @returns {boolean} True if newly registered, false if updated existing
   */
  register(gitRemote, localPath, actionMeta = {}) {
    const actionType = actionMeta.actionType || 'claude-code';
    const key = this._makeKey(gitRemote, actionType);
    const isNew = !(key in this._data.projects);
    const now = new Date().toISOString();

    if (isNew) {
      this._data.projects[key] = {
        gitRemote,
        localPath,
        actionType,
        actionId: actionMeta.actionId || null,
        actionName: actionMeta.actionName || null,
        registeredAt: now,
        lastUsed: now
      };
    } else {
      this._data.projects[key].localPath = localPath;
      this._data.projects[key].lastUsed = now;
      if (actionMeta.actionId) this._data.projects[key].actionId = actionMeta.actionId;
      if (actionMeta.actionName) this._data.projects[key].actionName = actionMeta.actionName;
    }

    // Set as default if first project
    if (this._data.defaultProject === null) {
      this._data.defaultProject = key;
    }

    this._save();
    return isNew;
  }

  /**
   * Get local path for a git remote (and optional action type).
   * Updates lastUsed timestamp.
   *
   * Supports both:
   * - getPath("github.com/user/repo", "claude-code") → exact match
   * - getPath("github.com/user/repo") → first match for that repo (backward compat)
   *
   * @param {string} gitRemote - Normalized git remote
   * @param {string} [actionType] - Optional action type for exact match
   * @returns {string|null} Local path or null if not registered
   */
  getPath(gitRemote, actionType) {
    const project = this._findProject(gitRemote, actionType);
    if (project) {
      project.lastUsed = new Date().toISOString();
      this._save();
      return project.localPath;
    }
    return null;
  }

  /**
   * Get local path without updating lastUsed.
   * Useful for status checks and listing operations.
   *
   * @param {string} gitRemote - Normalized git remote
   * @param {string} [actionType] - Optional action type
   * @returns {string|null} Local path or null if not registered
   */
  getPathWithoutUpdate(gitRemote, actionType) {
    const project = this._findProject(gitRemote, actionType);
    return project ? project.localPath : null;
  }

  /**
   * Find a project entry by gitRemote and optional actionType.
   * If actionType provided, tries exact composite key first.
   * Falls back to scanning all entries for matching gitRemote.
   *
   * @param {string} gitRemote
   * @param {string} [actionType]
   * @returns {Object|null}
   */
  _findProject(gitRemote, actionType) {
    // Try exact composite key first
    if (actionType) {
      const key = this._makeKey(gitRemote, actionType);
      if (key in this._data.projects) {
        return this._data.projects[key];
      }
    }

    // Fall back to scanning for matching gitRemote (backward compat + no actionType case)
    for (const [key, info] of Object.entries(this._data.projects)) {
      // V2 format: check the stored gitRemote field
      if (info.gitRemote === gitRemote) {
        return info;
      }
      // V1 format fallback: key IS the gitRemote (pre-migration)
      if (key === gitRemote) {
        return info;
      }
    }
    return null;
  }

  /**
   * List all registered projects (backward-compatible format).
   * Returns unique gitRemote -> localPath mapping (first entry per remote wins).
   *
   * @returns {Object} Dict of gitRemote -> localPath
   */
  listProjects() {
    const result = {};
    for (const [_key, info] of Object.entries(this._data.projects)) {
      const remote = info.gitRemote || _key;
      // First entry per gitRemote wins (backward compat)
      if (!(remote in result)) {
        result[remote] = info.localPath;
      }
    }
    return result;
  }

  /**
   * List all registered projects with full metadata.
   * V2 format: includes actionType, actionId, gitRemote per entry.
   *
   * @returns {Object} Dict of compositeKey -> {gitRemote, localPath, actionType, ...}
   */
  listProjectsWithMetadata() {
    return { ...this._data.projects };
  }

  /**
   * List all registered projects with action type info.
   * Returns array of {gitRemote, localPath, actionType} for daemon routing.
   *
   * @returns {Array<{gitRemote: string, localPath: string, actionType: string}>}
   */
  listProjectsWithActionType() {
    const result = [];
    for (const [_key, info] of Object.entries(this._data.projects)) {
      result.push({
        gitRemote: info.gitRemote || _key,
        localPath: info.localPath,
        actionType: info.actionType || 'claude-code',
      });
    }
    return result;
  }

  /**
   * Unregister a project.
   * Accepts either composite key ("remote::type") or plain gitRemote (removes all entries for that remote).
   *
   * @param {string} keyOrRemote - Composite key or plain git remote
   * @returns {boolean} True if was registered, false if not found
   */
  unregister(keyOrRemote) {
    let found = false;

    // Try as exact key first
    if (keyOrRemote in this._data.projects) {
      delete this._data.projects[keyOrRemote];
      found = true;
    } else {
      // Remove all entries matching this gitRemote
      for (const [key, info] of Object.entries(this._data.projects)) {
        if ((info.gitRemote || key) === keyOrRemote) {
          delete this._data.projects[key];
          found = true;
        }
      }
    }

    if (found) {
      // Fix default if needed
      if (this._data.defaultProject && !(this._data.defaultProject in this._data.projects)) {
        const remaining = Object.keys(this._data.projects);
        this._data.defaultProject = remaining.length > 0 ? remaining[0] : null;
      }
      this._save();
    }

    return found;
  }

  /**
   * Get the default project's git remote.
   *
   * @returns {string|null}
   */
  getDefaultProject() {
    return this._data.defaultProject;
  }

  /**
   * Set a project as the default.
   * Accepts composite key or plain gitRemote (finds first match).
   *
   * @param {string} keyOrRemote
   * @returns {boolean} True if successful
   */
  setDefaultProject(keyOrRemote) {
    // Exact key match
    if (keyOrRemote in this._data.projects) {
      this._data.defaultProject = keyOrRemote;
      this._save();
      return true;
    }
    // Find by gitRemote
    for (const [key, info] of Object.entries(this._data.projects)) {
      if ((info.gitRemote || key) === keyOrRemote) {
        this._data.defaultProject = key;
        this._save();
        return true;
      }
    }
    return false;
  }

  /**
   * Return the number of registered projects.
   *
   * @returns {number}
   */
  projectCount() {
    return Object.keys(this._data.projects).length;
  }

  /**
   * Find a project entry by gitRemote and optional actionType.
   * Public wrapper for _findProject.
   *
   * @param {string} gitRemote
   * @param {string} [actionType]
   * @returns {Object|null} Project entry with {gitRemote, localPath, actionType, ...}
   */
  findProject(gitRemote, actionType) {
    return this._findProject(gitRemote, actionType);
  }

  /**
   * Check if a project is registered.
   * Checks both composite keys and plain gitRemote.
   *
   * @param {string} gitRemote
   * @param {string} [actionType] - Optional action type for exact match
   * @returns {boolean}
   */
  isRegistered(gitRemote, actionType) {
    return this._findProject(gitRemote, actionType) !== null;
  }

  /**
   * Validate that all registered paths still exist.
   *
   * @returns {Array} List of invalid entries
   */
  validatePaths() {
    const invalid = [];

    for (const [key, info] of Object.entries(this._data.projects)) {
      const path = info.localPath;
      const gitRemote = info.gitRemote || key;

      try {
        const stats = statSync(path);
        if (!stats.isDirectory()) {
          invalid.push({
            key,
            gitRemote,
            localPath: path,
            reason: 'not_a_directory'
          });
        } else if (!existsSync(join(path, '.git'))) {
          invalid.push({
            key,
            gitRemote,
            localPath: path,
            reason: 'not_a_git_repo'
          });
        }
      } catch {
        invalid.push({
          key,
          gitRemote,
          localPath: path,
          reason: 'path_not_found'
        });
      }
    }

    return invalid;
  }
}

// Singleton instance
let _registry = null;

/**
 * Get the singleton registry instance.
 *
 * @returns {ProjectRegistry}
 */
export function getRegistry() {
  if (_registry === null) {
    _registry = new ProjectRegistry();
  }
  return _registry;
}

/**
 * Reset the singleton (for testing).
 */
export function resetRegistry() {
  _registry = null;
}

export { ProjectRegistry, REGISTRY_FILE };
