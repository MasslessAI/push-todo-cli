/**
 * LaunchAgent management for Push daemon.
 *
 * Installs/uninstalls a user-level LaunchAgent plist that keeps the
 * Push daemon running across reboots and logins. User-level LaunchAgents
 * do NOT require sudo — they live in ~/Library/LaunchAgents/.
 *
 * This supplements (not replaces) the self-healing ensureDaemonRunning()
 * pattern. LaunchAgent ensures startup; self-healing handles edge cases.
 *
 * Historical context:
 * - Happy Engineering rejected LaunchAgent citing sudo friction (wrong —
 *   user-level LaunchAgents don't need sudo)
 * - OpenClaw proved zero-friction adoption with LaunchAgent at scale
 * - See: docs/20260127_parallel_task_execution_research.md §9.9
 *
 * Architecture: docs/20260224_openclaw_autonomous_layer_research_and_push_integration_plan.md §Phase 6
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LABEL = 'ai.massless.push.daemon';
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const PUSH_DIR = join(homedir(), '.push');
const LOG_FILE = join(PUSH_DIR, 'daemon.log');

/**
 * Find the node binary used by push-todo.
 */
function findNodeBinary() {
  try {
    const path = execFileSync('which', ['node'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (path && existsSync(path)) return path;
  } catch {}
  return process.execPath;
}

/**
 * Generate the plist XML content.
 */
function generatePlist() {
  const nodeBin = findNodeBinary();
  const daemonScript = join(__dirname, 'daemon.js');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${daemonScript}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PUSH_DAEMON</key>
        <string>1</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${dirname(nodeBin)}:${join(homedir(), '.local', 'bin')}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>

    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>

    <key>WorkingDirectory</key>
    <string>${homedir()}</string>
</dict>
</plist>
`;
}

/**
 * Check if the LaunchAgent is installed.
 * @returns {{ installed: boolean, loaded: boolean, plistPath: string }}
 */
export function getStatus() {
  const installed = existsSync(PLIST_PATH);
  let loaded = false;

  if (installed) {
    try {
      execFileSync('launchctl', ['list', LABEL], {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'], // capture stdout, suppress stderr
      });
      loaded = true; // If no error thrown, service exists
    } catch {
      loaded = false; // launchctl exits non-zero if service not found
    }
  }

  return { installed, loaded, plistPath: PLIST_PATH };
}

/**
 * Install the LaunchAgent plist and load it.
 *
 * Safe to call multiple times — updates existing plist if daemon script
 * path has changed (e.g., after npm update).
 *
 * @returns {{ success: boolean, message: string, alreadyInstalled?: boolean }}
 */
export function install() {
  try {
    // Ensure directories exist
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    mkdirSync(PUSH_DIR, { recursive: true });

    // Check if already installed with same content
    const newContent = generatePlist();
    if (existsSync(PLIST_PATH)) {
      const existing = readFileSync(PLIST_PATH, 'utf8');
      if (existing === newContent) {
        // Ensure loaded (suppress stderr — already-loaded plist emits noise)
        try {
          execFileSync('launchctl', ['load', '-w', PLIST_PATH], {
            timeout: 5000,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
        } catch {}
        return { success: true, message: 'LaunchAgent already installed', alreadyInstalled: true };
      }

      // Content changed (e.g., node path updated) — unload old, write new
      try {
        execFileSync('launchctl', ['unload', PLIST_PATH], {
          timeout: 5000,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {}
    }

    // Write plist
    writeFileSync(PLIST_PATH, newContent);

    // Load it
    execFileSync('launchctl', ['load', '-w', PLIST_PATH], {
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    return { success: true, message: 'LaunchAgent installed and loaded' };
  } catch (error) {
    return { success: false, message: `Failed to install LaunchAgent: ${error.message}` };
  }
}

/**
 * Uninstall the LaunchAgent — unload and remove plist.
 *
 * @returns {{ success: boolean, message: string }}
 */
export function uninstall() {
  try {
    if (!existsSync(PLIST_PATH)) {
      return { success: true, message: 'LaunchAgent not installed (nothing to remove)' };
    }

    // Unload
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], {
        timeout: 5000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {}

    // Remove plist
    unlinkSync(PLIST_PATH);

    return { success: true, message: 'LaunchAgent uninstalled' };
  } catch (error) {
    return { success: false, message: `Failed to uninstall LaunchAgent: ${error.message}` };
  }
}

export { PLIST_PATH, LABEL };
