/**
 * Agent version detection, tracking, and auto-update for Push daemon.
 *
 * Detects installed versions of Claude Code, OpenAI Codex, and OpenClaw CLIs.
 * Reports version parity with the push-todo CLI and flags outdated agents.
 * Can auto-update agents via npm when enabled.
 *
 * Pattern: follows heartbeat.js — pure functions, internally throttled, non-fatal.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { compareSemver } from './self-update.js';

const PUSH_DIR = join(homedir(), '.push');
const VERSIONS_CACHE_FILE = join(PUSH_DIR, 'agent_versions.json');
const LAST_AGENT_UPDATE_FILE = join(PUSH_DIR, 'last_agent_update_check');
const CHECK_INTERVAL = 3600000; // 1 hour
const AGENT_UPDATE_CHECK_INTERVAL = 3600000; // 1 hour
const AGENT_VERSION_AGE_GATE = 3600000; // 1 hour — only install versions >1hr old

// ==================== Agent Definitions ====================

/**
 * Agent CLI definitions: command name, version flag, npm package, and how to parse output.
 *
 * Each agent has:
 * - cmd: the CLI binary name
 * - versionArgs: args to get version string
 * - npmPackage: the npm package name for install/update
 * - parseVersion: extracts semver from command output
 * - minVersion: minimum version required for push-todo compatibility (null = no minimum)
 */
const AGENTS = {
  'claude-code': {
    cmd: 'claude',
    versionArgs: ['--version'],
    npmPackage: '@anthropic-ai/claude-code',
    minVersion: '2.0.0', // --worktree support
    parseVersion(output) {
      // "claude v2.1.41" or just "2.1.41"
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
  },
  'openai-codex': {
    cmd: 'codex',
    versionArgs: ['--version'],
    npmPackage: '@openai/codex',
    minVersion: null,
    parseVersion(output) {
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
  },
  'openclaw': {
    cmd: 'openclaw',
    versionArgs: ['--version'],
    npmPackage: 'openclaw',
    minVersion: null,
    parseVersion(output) {
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
  },
};

// ==================== Version Detection ====================

/**
 * Detect the installed version of a single agent CLI.
 *
 * @param {string} agentType - One of 'claude-code', 'openai-codex', 'openclaw'
 * @returns {{ installed: boolean, version: string|null, error: string|null }}
 */
export function detectAgentVersion(agentType) {
  const agent = AGENTS[agentType];
  if (!agent) {
    return { installed: false, version: null, error: `Unknown agent type: ${agentType}` };
  }

  try {
    const output = execFileSync(agent.cmd, agent.versionArgs, {
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    const version = agent.parseVersion(output);
    if (version) {
      return { installed: true, version, error: null };
    }
    return { installed: true, version: null, error: `Could not parse version from: ${output}` };
  } catch (err) {
    // ENOENT = not installed; other errors = installed but broken
    if (err.code === 'ENOENT') {
      return { installed: false, version: null, error: null };
    }
    return { installed: false, version: null, error: err.message };
  }
}

/**
 * Detect versions of all known agent CLIs.
 *
 * @returns {Object.<string, { installed: boolean, version: string|null, error: string|null }>}
 */
export function detectAllAgentVersions() {
  const results = {};
  for (const agentType of Object.keys(AGENTS)) {
    results[agentType] = detectAgentVersion(agentType);
  }
  return results;
}

// ==================== Cache ====================

/**
 * Load cached agent version data.
 *
 * @returns {{ versions: Object, checkedAt: string|null }|null}
 */
function loadCache() {
  try {
    if (existsSync(VERSIONS_CACHE_FILE)) {
      return JSON.parse(readFileSync(VERSIONS_CACHE_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

/**
 * Save agent version data to cache.
 *
 * @param {Object} versions - Agent version results
 */
function saveCache(versions) {
  try {
    mkdirSync(PUSH_DIR, { recursive: true });
    writeFileSync(VERSIONS_CACHE_FILE, JSON.stringify({
      versions,
      checkedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

// ==================== Throttled Check ====================

let lastCheckTime = 0;
let cachedResults = null;

/**
 * Get agent versions (throttled to once per hour).
 * Returns cached results if within the check interval.
 *
 * @param {{ force?: boolean }} options
 * @returns {Object.<string, { installed: boolean, version: string|null, error: string|null }>}
 */
export function getAgentVersions({ force = false } = {}) {
  const now = Date.now();

  // Return in-memory cache if fresh
  if (!force && cachedResults && (now - lastCheckTime < CHECK_INTERVAL)) {
    return cachedResults;
  }

  // Try disk cache if no in-memory cache
  if (!force && !cachedResults) {
    const diskCache = loadCache();
    if (diskCache?.checkedAt) {
      const cacheAge = now - new Date(diskCache.checkedAt).getTime();
      if (cacheAge < CHECK_INTERVAL) {
        cachedResults = diskCache.versions;
        lastCheckTime = now - (CHECK_INTERVAL - cacheAge); // preserve remaining TTL
        return cachedResults;
      }
    }
  }

  // Fresh detection
  cachedResults = detectAllAgentVersions();
  lastCheckTime = now;
  saveCache(cachedResults);
  return cachedResults;
}

/**
 * Get a human-readable summary of agent versions for logging.
 *
 * @param {Object} versions - From getAgentVersions()
 * @returns {string}
 */
export function formatAgentVersionSummary(versions) {
  const parts = [];
  for (const [type, info] of Object.entries(versions)) {
    const label = type.replace(/-/g, ' ');
    if (info.installed && info.version) {
      parts.push(`${label}=v${info.version}`);
    } else if (info.installed) {
      parts.push(`${label}=installed (unknown version)`);
    } else {
      parts.push(`${label}=not found`);
    }
  }
  return parts.join(', ');
}

/**
 * Get the list of known agent types.
 *
 * @returns {string[]}
 */
export function getKnownAgentTypes() {
  return Object.keys(AGENTS);
}

// ==================== Agent Update ====================

/**
 * Fetch latest version info for an agent from npm.
 *
 * @param {string} agentType
 * @returns {{ version: string, publishedAt: string|null }|null}
 */
function fetchLatestAgentVersion(agentType) {
  const agent = AGENTS[agentType];
  if (!agent?.npmPackage) return null;

  try {
    const result = execFileSync('npm', ['view', agent.npmPackage, '--json'], {
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const data = JSON.parse(result);
    const latest = data['dist-tags']?.latest || data.version;
    return {
      version: latest,
      publishedAt: data.time?.[latest] || null,
    };
  } catch {
    return null;
  }
}

/**
 * Check if an agent has an update available.
 *
 * @param {string} agentType
 * @returns {{ available: boolean, current: string|null, latest: string|null, reason: string }}
 */
export function checkForAgentUpdate(agentType) {
  const currentInfo = detectAgentVersion(agentType);
  if (!currentInfo.installed || !currentInfo.version) {
    return { available: false, current: null, latest: null, reason: 'not_installed' };
  }

  const latestInfo = fetchLatestAgentVersion(agentType);
  if (!latestInfo) {
    return { available: false, current: currentInfo.version, latest: null, reason: 'registry_unreachable' };
  }

  if (compareSemver(currentInfo.version, latestInfo.version) >= 0) {
    return { available: false, current: currentInfo.version, latest: latestInfo.version, reason: 'up_to_date' };
  }

  // Safety: only update to versions published >1 hour ago
  if (latestInfo.publishedAt) {
    const publishedAge = Date.now() - new Date(latestInfo.publishedAt).getTime();
    if (publishedAge < AGENT_VERSION_AGE_GATE) {
      return { available: false, current: currentInfo.version, latest: latestInfo.version, reason: 'too_recent' };
    }
  }

  return { available: true, current: currentInfo.version, latest: latestInfo.version, reason: 'update_available' };
}

/**
 * Install a specific version of an agent CLI globally.
 * For claude-code: tries npm first, falls back to `claude update` which
 * handles non-npm installations (brew, app installer, happy-coder wrapper).
 *
 * @param {string} agentType
 * @param {string} targetVersion
 * @returns {boolean} true if update succeeded
 */
export function performAgentUpdate(agentType, targetVersion) {
  const agent = AGENTS[agentType];
  if (!agent?.npmPackage) return false;

  // Try npm install first (works for standard npm global installs)
  try {
    execFileSync('npm', ['install', '-g', `${agent.npmPackage}@${targetVersion}`], {
      timeout: 120000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    // npm failed — fall through to agent-specific fallbacks
  }

  // Fallback: use the agent's own update command (handles non-npm installs)
  if (agentType === 'claude-code') {
    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      execFileSync('claude', ['update'], {
        timeout: 120000,
        stdio: 'pipe',
        env,
      });
      // Verify the update actually worked
      const after = detectAgentVersion('claude-code');
      return after.installed && after.version != null;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Check all installed agents for updates (throttled).
 * Returns update results or null if throttled.
 *
 * @param {{ force?: boolean }} options
 * @returns {Object.<string, { available: boolean, current: string|null, latest: string|null, reason: string }>|null}
 */
export function checkAllAgentUpdates({ force = false } = {}) {
  // Throttle check
  if (!force && existsSync(LAST_AGENT_UPDATE_FILE)) {
    try {
      const lastCheck = parseInt(readFileSync(LAST_AGENT_UPDATE_FILE, 'utf8').trim(), 10);
      if (Date.now() - lastCheck < AGENT_UPDATE_CHECK_INTERVAL) {
        return null;
      }
    } catch {}
  }

  // Record check time
  try {
    mkdirSync(PUSH_DIR, { recursive: true });
    writeFileSync(LAST_AGENT_UPDATE_FILE, String(Date.now()));
  } catch {}

  const results = {};
  for (const agentType of Object.keys(AGENTS)) {
    const info = detectAgentVersion(agentType);
    if (info.installed) {
      results[agentType] = checkForAgentUpdate(agentType);
    }
  }
  return results;
}

/**
 * Pre-flight check: verify an agent meets minimum version before task execution.
 * If below minimum, attempts an immediate update and rechecks.
 *
 * @param {string} agentType
 * @returns {{ ok: boolean, version: string|null, error: string|null }}
 */
export function ensureAgentReady(agentType) {
  const agent = AGENTS[agentType];
  if (!agent) {
    return { ok: false, version: null, error: `Unknown agent type: ${agentType}` };
  }

  const info = detectAgentVersion(agentType);
  if (!info.installed) {
    return { ok: false, version: null, error: `${agentType} CLI not found` };
  }
  if (!info.version) {
    return { ok: false, version: null, error: `${agentType} installed but version unknown` };
  }

  // Check minimum version
  if (agent.minVersion && compareSemver(info.version, agent.minVersion) < 0) {
    // Attempt immediate update
    const latest = fetchLatestAgentVersion(agentType);
    if (latest?.version) {
      const updated = performAgentUpdate(agentType, latest.version);
      if (updated) {
        // Recheck after update
        const after = detectAgentVersion(agentType);
        if (after.version && compareSemver(after.version, agent.minVersion) >= 0) {
          return { ok: true, version: after.version, error: null };
        }
      }
    }
    return {
      ok: false,
      version: info.version,
      error: `${agentType} v${info.version} is below minimum v${agent.minVersion} (needs --worktree support). Update with: claude update`,
    };
  }

  return { ok: true, version: info.version, error: null };
}

// ==================== Version Parity ====================

/**
 * Check version parity between installed agents and push-todo requirements.
 * Returns warnings for agents that are below minimum required versions.
 *
 * @returns {{ agentType: string, installed: string, required: string }[]}
 */
export function checkVersionParity() {
  const warnings = [];
  for (const [agentType, agent] of Object.entries(AGENTS)) {
    if (!agent.minVersion) continue;

    const info = detectAgentVersion(agentType);
    if (info.installed && info.version) {
      if (compareSemver(info.version, agent.minVersion) < 0) {
        warnings.push({
          agentType,
          installed: info.version,
          required: agent.minVersion,
        });
      }
    }
  }
  return warnings;
}
