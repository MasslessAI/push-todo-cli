/**
 * Daily journal cron via LaunchAgent.
 *
 * Installs a user-level LaunchAgent that fires claude with /journal today
 * at a configurable daily time. More reliable than Supabase remote schedules:
 * - System-level: survives daemon restarts and Supabase outages
 * - StartCalendarInterval: native macOS daily scheduling (no polling)
 * - Writes to ~/journal/ in the user's home directory
 *
 * Usage:
 *   push-todo journal setup          Install at 9pm (default)
 *   push-todo journal setup --time 21:30   Install at 9:30pm
 *   push-todo journal status         Show status
 *   push-todo journal remove         Uninstall
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const LABEL = 'ai.massless.push.journal';
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const PUSH_DIR = join(homedir(), '.push');
const LOG_FILE = join(PUSH_DIR, 'journal.log');

// Default: 9pm daily
const DEFAULT_HOUR = 21;
const DEFAULT_MINUTE = 0;

/**
 * Find the claude binary (real binary, not shell function).
 * Tries ~/.local/bin/claude first, then PATH.
 */
function findClaudeBinary() {
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: search PATH via which
  try {
    const found = execFileSync('which', ['claude'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (found && existsSync(found)) return found;
  } catch {}
  return 'claude'; // last resort
}

/**
 * Parse "HH:MM" string into { hour, minute }.
 * Throws if format is invalid.
 */
export function parseTime(timeStr) {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time format: "${timeStr}". Use HH:MM (e.g., "21:00", "09:30")`);
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23) throw new Error(`Hour must be 0-23, got ${hour}`);
  if (minute < 0 || minute > 59) throw new Error(`Minute must be 0-59, got ${minute}`);
  return { hour, minute };
}

/**
 * Generate the plist XML for the daily journal LaunchAgent.
 */
function generatePlist(hour, minute) {
  const claudeBin = findClaudeBinary();
  const nodePath = join(homedir(), '.nvm', 'versions', 'node', 'v24.9.0', 'bin');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${claudeBin}</string>
        <string>-p</string>
        <string>Run /journal today - generate today's journal entry summarizing the day's work, experiments, and learnings. Use the journal skill to write the entry to ~/journal/ with today's date.</string>
        <string>--dangerously-skip-permissions</string>
        <string>--allowedTools</string>
        <string>Read,Write,Glob,Grep</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${nodePath}:${join(homedir(), '.local', 'bin')}</string>
        <key>HOME</key>
        <string>${homedir()}</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${homedir()}</string>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>

    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
</dict>
</plist>
`;
}

/**
 * Read the hour/minute from an installed plist.
 * Returns null if not installed or can't parse.
 */
function readInstalledTime() {
  if (!existsSync(PLIST_PATH)) return null;
  try {
    const content = readFileSync(PLIST_PATH, 'utf8');
    const hourMatch = content.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
    const minMatch = content.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
    if (hourMatch && minMatch) {
      return { hour: parseInt(hourMatch[1], 10), minute: parseInt(minMatch[1], 10) };
    }
  } catch {}
  return null;
}

/**
 * Format hour/minute as "HH:MM am/pm".
 */
function formatTime(hour, minute) {
  const suffix = hour >= 12 ? 'pm' : 'am';
  const displayHour = hour % 12 || 12;
  const displayMin = String(minute).padStart(2, '0');
  return `${displayHour}:${displayMin}${suffix}`;
}

/**
 * Check installation status.
 * @returns {{ installed: boolean, loaded: boolean, hour?: number, minute?: number }}
 */
export function getStatus() {
  const installed = existsSync(PLIST_PATH);
  let loaded = false;

  if (installed) {
    try {
      execFileSync('launchctl', ['list', LABEL], {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      loaded = true;
    } catch {}
  }

  const time = readInstalledTime();
  return { installed, loaded, ...time };
}

/**
 * Install (or update) the daily journal LaunchAgent.
 *
 * @param {{ hour?: number, minute?: number }} options
 * @returns {{ success: boolean, message: string }}
 */
export function install({ hour = DEFAULT_HOUR, minute = DEFAULT_MINUTE } = {}) {
  try {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    mkdirSync(PUSH_DIR, { recursive: true });

    const newContent = generatePlist(hour, minute);

    // Unload existing if present (to apply time changes)
    if (existsSync(PLIST_PATH)) {
      try {
        execFileSync('launchctl', ['unload', PLIST_PATH], {
          timeout: 5000,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {}
    }

    writeFileSync(PLIST_PATH, newContent);

    execFileSync('launchctl', ['load', '-w', PLIST_PATH], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const timeStr = formatTime(hour, minute);
    return {
      success: true,
      message: `Journal cron installed — runs daily at ${timeStr}`,
      hour,
      minute,
    };
  } catch (error) {
    return { success: false, message: `Failed to install journal cron: ${error.message}` };
  }
}

/**
 * Uninstall the journal LaunchAgent.
 *
 * @returns {{ success: boolean, message: string }}
 */
export function uninstall() {
  try {
    if (!existsSync(PLIST_PATH)) {
      return { success: true, message: 'Journal cron not installed (nothing to remove)' };
    }

    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], {
        timeout: 5000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {}

    unlinkSync(PLIST_PATH);
    return { success: true, message: 'Journal cron removed' };
  } catch (error) {
    return { success: false, message: `Failed to remove journal cron: ${error.message}` };
  }
}

export { PLIST_PATH, LABEL, LOG_FILE, DEFAULT_HOUR, DEFAULT_MINUTE, formatTime };
