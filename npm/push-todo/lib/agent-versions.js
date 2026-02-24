/**
 * Agent version detection and tracking for Push daemon.
 *
 * Detects installed versions of Claude Code, OpenAI Codex, and OpenClaw CLIs.
 * Reports version parity with the push-todo CLI and flags outdated agents.
 *
 * Pattern: follows heartbeat.js — pure functions, internally throttled, non-fatal.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PUSH_DIR = join(homedir(), '.push');
const VERSIONS_CACHE_FILE = join(PUSH_DIR, 'agent_versions.json');
const CHECK_INTERVAL = 3600000; // 1 hour

// ==================== Agent Definitions ====================

/**
 * Agent CLI definitions: command name, version flag, and how to parse output.
 *
 * Each agent has:
 * - cmd: the CLI binary name
 * - versionArgs: args to get version string
 * - parseVersion: extracts semver from command output
 */
const AGENTS = {
  'claude-code': {
    cmd: 'claude',
    versionArgs: ['--version'],
    parseVersion(output) {
      // "claude v2.1.41" or just "2.1.41"
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
  },
  'openai-codex': {
    cmd: 'codex',
    versionArgs: ['--version'],
    parseVersion(output) {
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    },
  },
  'openclaw': {
    cmd: 'openclaw',
    versionArgs: ['--version'],
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
