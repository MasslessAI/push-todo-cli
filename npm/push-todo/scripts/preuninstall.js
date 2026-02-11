#!/usr/bin/env node
/**
 * Pre-uninstall script for Push CLI.
 *
 * Removes skill symlinks for all detected AI coding clients:
 * 1. Claude Code - ~/.claude/skills/push-todo
 * 2. OpenAI Codex - ~/.codex/skills/push-todo
 * 3. OpenClaw - ~/.openclaw/skills/push-todo (and legacy ~/.clawdbot/)
 * 4. Legacy plugin - ~/.claude/plugins/push-todo
 */

import { existsSync, unlinkSync, lstatSync, readlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Package root (one level up from scripts/)
const PACKAGE_ROOT = join(__dirname, '..');

// All symlink locations to clean up
const SYMLINKS = [
  { path: join(homedir(), '.claude', 'skills', 'push-todo'), label: 'Claude Code skill' },
  { path: join(homedir(), '.claude', 'plugins', 'push-todo'), label: 'Claude Code plugin (legacy)' },
  { path: join(homedir(), '.codex', 'skills', 'push-todo'), label: 'OpenAI Codex skill' },
  { path: join(homedir(), '.openclaw', 'skills', 'push-todo'), label: 'OpenClaw skill' },
  { path: join(homedir(), '.clawdbot', 'skills', 'push-todo'), label: 'OpenClaw skill (legacy ~/.clawdbot)' },
];

/**
 * Remove a symlink if it points to this package.
 */
function removeSymlink({ path, label }) {
  if (!existsSync(path)) return;

  try {
    const stats = lstatSync(path);
    if (!stats.isSymbolicLink()) {
      console.log(`[push-todo] ${label} is not a symlink, leaving it alone.`);
      return;
    }

    const target = readlinkSync(path);
    if (target === PACKAGE_ROOT || target.includes('node_modules/@masslessai/push-todo')) {
      unlinkSync(path);
      console.log(`[push-todo] Removed ${label} symlink.`);
    } else {
      console.log(`[push-todo] ${label} symlink points elsewhere, leaving it alone.`);
    }
  } catch (error) {
    console.error(`[push-todo] Warning: Could not remove ${label}: ${error.message}`);
  }
}

/**
 * Main pre-uninstall routine.
 */
function main() {
  console.log('[push-todo] Running pre-uninstall...');

  for (const link of SYMLINKS) {
    removeSymlink(link);
  }

  console.log('[push-todo] Uninstall cleanup complete.');
  console.log('[push-todo] Your configuration at ~/.config/push/ has been preserved.');
  console.log('[push-todo] To remove config: rm -rf ~/.config/push');
}

main();
