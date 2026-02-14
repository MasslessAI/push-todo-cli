/**
 * Mac notification utility for Push daemon.
 * Shared by daemon.js, cron.js, and heartbeat.js.
 */

import { execFileSync } from 'child_process';
import { platform } from 'os';

/**
 * Send a macOS notification via osascript.
 *
 * @param {string} title - Notification title
 * @param {string} message - Notification body
 * @param {string} [sound='default'] - Sound name ('default', 'Basso', 'Glass', etc.)
 */
export function sendMacNotification(title, message, sound = 'default') {
  if (platform() !== 'darwin') return;

  try {
    const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    let script = `display notification "${escapedMessage}" with title "${escapedTitle}"`;
    if (sound && sound !== 'default') {
      script += ` sound name "${sound}"`;
    }

    execFileSync('osascript', ['-e', script], { timeout: 5000, stdio: 'pipe' });
  } catch {
    // Non-critical
  }
}
