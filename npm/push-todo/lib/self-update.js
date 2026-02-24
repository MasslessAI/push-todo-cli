/**
 * Self-update module for Push daemon.
 *
 * Checks npm registry for newer versions and auto-updates.
 * Safety: Only updates to versions published >1 hour ago.
 * Throttle: Checks at most once per hour.
 * Config: PUSH_AUTO_UPDATE (default true)
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PUSH_DIR = join(homedir(), '.push');
const LAST_UPDATE_CHECK_FILE = join(PUSH_DIR, 'last_update_check');
const UPDATE_CHECK_INTERVAL = 3600000; // 1 hour

/**
 * Compare semver strings (strips pre-release/build metadata before comparing).
 * Handles formats like "2.1.41", "2026.2.22-2", "1.0.0+build.123".
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareSemver(a, b) {
  // Strip pre-release (-beta.1) and build metadata (+build.123)
  const cleanA = a.split('-')[0].split('+')[0];
  const cleanB = b.split('-')[0].split('+')[0];
  const pa = cleanA.split('.').map(Number);
  const pb = cleanB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

/**
 * Fetch latest version info from npm registry.
 * @returns {{ version: string, publishedAt: string | null }} or null on failure
 */
function fetchLatestVersionInfo() {
  try {
    const result = execFileSync('npm', ['view', '@masslessai/push-todo', '--json'], {
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const data = JSON.parse(result);
    const latest = data['dist-tags']?.latest || data.version;
    return {
      version: latest,
      publishedAt: data.time?.[latest] || null
    };
  } catch {
    return null;
  }
}

/**
 * Check if an update is available and safe to install.
 * Throttled to once per hour. Enforces 1-hour age gate on new versions.
 *
 * @param {string} currentVersion
 * @returns {{ available: boolean, version?: string, reason?: string }}
 */
export function checkForUpdate(currentVersion) {
  // Throttle: check at most once per hour
  if (existsSync(LAST_UPDATE_CHECK_FILE)) {
    try {
      const lastCheck = parseInt(readFileSync(LAST_UPDATE_CHECK_FILE, 'utf8').trim(), 10);
      if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL) {
        return { available: false, reason: 'throttled' };
      }
    } catch {}
  }

  // Record check time
  try {
    mkdirSync(PUSH_DIR, { recursive: true });
    writeFileSync(LAST_UPDATE_CHECK_FILE, String(Date.now()));
  } catch {}

  const info = fetchLatestVersionInfo();
  if (!info) {
    return { available: false, reason: 'registry_unreachable' };
  }

  // Already up to date
  if (compareSemver(currentVersion, info.version) >= 0) {
    return { available: false, reason: 'up_to_date' };
  }

  // Safety: only update to versions published >1 hour ago
  if (info.publishedAt) {
    const publishedAge = Date.now() - new Date(info.publishedAt).getTime();
    if (publishedAge < UPDATE_CHECK_INTERVAL) {
      return { available: false, reason: 'too_recent', version: info.version };
    }
  }

  return { available: true, version: info.version };
}

/**
 * Install a specific version globally.
 * @param {string} targetVersion
 * @returns {boolean} true if update succeeded
 */
export function performUpdate(targetVersion) {
  try {
    execFileSync('npm', ['install', '-g', `@masslessai/push-todo@${targetVersion}`], {
      timeout: 120000,
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}
