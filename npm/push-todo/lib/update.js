/**
 * Manual update orchestrator for Push CLI.
 *
 * `push-todo update` performs four actions:
 * 1. Self-update: check and install latest push-todo from npm
 * 2. Agent CLIs: detect versions, check for updates, and install if available
 * 3. Version parity: warn if agents are below minimum required versions
 * 4. Project freshness: fetch and rebase registered projects that are behind
 *
 * Separation of concerns:
 * - Daemon: runs all checks periodically (hourly, throttled, non-interactive)
 *   - Self-update: always (gated by auto-update setting)
 *   - Agent updates: opt-in (gated by auto-update-agents setting, default OFF)
 *   - Project freshness: always (gated by auto-update setting)
 * - This module: runs on explicit user request (immediate, verbose, interactive)
 *   - Always checks and updates everything, no settings gate
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { checkForUpdate, performUpdate } from './self-update.js';
import { getAgentVersions, getKnownAgentTypes, checkForAgentUpdate, performAgentUpdate, checkVersionParity } from './agent-versions.js';
import { checkProjectFreshness } from './project-freshness.js';
import { getRegistry } from './project-registry.js';
import { bold, green, yellow, red, dim } from './utils/colors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion() {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

const AGENT_LABELS = {
  'claude-code': 'Claude Code',
  'openai-codex': 'Codex',
  'openclaw': 'OpenClaw',
};

/**
 * Run the manual update flow.
 *
 * @param {Object} values - Parsed CLI flags
 */
export async function runManualUpdate(values) {
  const currentVersion = getVersion();

  console.log();
  console.log(bold('  Push Update'));
  console.log('  ' + '='.repeat(40));
  console.log();

  // ── 1. Self-update ──────────────────────────────────────
  console.log(bold('  Push CLI'));
  console.log(`  Current version: v${currentVersion}`);

  // Force bypass throttle for manual check
  const updateResult = checkForUpdate(currentVersion);

  if (updateResult.available) {
    console.log(`  Latest version:  ${green('v' + updateResult.version)}`);
    console.log();
    console.log(`  Updating to v${updateResult.version}...`);
    const success = performUpdate(updateResult.version);
    if (success) {
      console.log(`  ${green('Updated successfully')}`);
    } else {
      console.log(`  ${red('Update failed')} — try: npm install -g @masslessai/push-todo`);
    }
  } else if (updateResult.reason === 'too_recent') {
    console.log(`  Latest version:  v${updateResult.version} ${dim('(published <1hr ago, waiting)')}`);
    console.log(`  ${green('Up to date')}`);
  } else {
    console.log(`  ${green('Up to date')}`);
  }
  console.log();

  // ── 2. Agent CLIs ──────────────────────────────────────
  console.log(bold('  Agent CLIs'));

  const agentVersions = getAgentVersions({ force: true });
  for (const type of getKnownAgentTypes()) {
    const info = agentVersions[type];
    const label = AGENT_LABELS[type] || type;

    if (!info.installed) {
      console.log(`  ${label}: ${dim('not installed')}`);
      continue;
    }

    if (!info.version) {
      console.log(`  ${label}: ${yellow('installed')} ${dim('(version unknown)')}`);
      continue;
    }

    // Check for update
    const updateInfo = checkForAgentUpdate(type);
    if (updateInfo.available) {
      console.log(`  ${label}: v${info.version} -> ${green('v' + updateInfo.latest)} available`);
      console.log(`  Updating ${label} to v${updateInfo.latest}...`);
      const success = performAgentUpdate(type, updateInfo.latest);
      if (success) {
        console.log(`  ${green('Updated successfully')}`);
      } else {
        console.log(`  ${red('Update failed')}`);
      }
    } else if (updateInfo.reason === 'too_recent') {
      console.log(`  ${label}: ${green('v' + info.version)} ${dim(`(v${updateInfo.latest} published <1hr ago)`)}`);
    } else {
      console.log(`  ${label}: ${green('v' + info.version)}`);
    }
  }

  // Version parity warnings
  const parityWarnings = checkVersionParity();
  if (parityWarnings.length > 0) {
    console.log();
    for (const w of parityWarnings) {
      const label = AGENT_LABELS[w.agentType] || w.agentType;
      console.log(`  ${yellow('Warning')}: ${label} v${w.installed} is below minimum v${w.required}`);
    }
  }
  console.log();

  // ── 3. Project freshness ───────────────────────────────
  const registry = getRegistry();
  const projects = registry.listProjects();
  const projectPaths = Object.entries(projects);

  if (projectPaths.length === 0) {
    console.log(bold('  Projects'));
    console.log(`  ${dim('No projects registered')}`);
    console.log();
    return;
  }

  console.log(bold('  Project Freshness'));

  for (const [remote, localPath] of projectPaths) {
    const result = checkProjectFreshness(localPath, {
      autoRebase: true,
      busyPaths: new Set(), // Manual update has no running tasks
      log: (msg) => console.log(`  ${dim(msg)}`),
    });

    const shortRemote = remote.length > 40
      ? '...' + remote.slice(-37)
      : remote;

    switch (result.status) {
      case 'up_to_date':
        console.log(`  ${shortRemote}: ${green('up to date')}`);
        break;
      case 'updated':
        console.log(`  ${shortRemote}: ${green('updated')} ${dim(`(${result.behind} commit(s) rebased)`)}`);
        break;
      case 'behind_wrong_branch':
        console.log(`  ${shortRemote}: ${yellow(`${result.behind} behind`)} ${dim(`(on branch '${result.currentBranch}')`)}`);
        break;
      case 'behind_dirty':
        console.log(`  ${shortRemote}: ${yellow(`${result.behind} behind`)} ${dim('(dirty working tree)')}`);
        break;
      case 'rebase_failed':
        console.log(`  ${shortRemote}: ${red('rebase failed')} ${dim(`(${result.behind} behind)`)}`);
        break;
      case 'fetch_failed':
        console.log(`  ${shortRemote}: ${dim('fetch failed (offline?)')}`);
        break;
      case 'not_a_repo':
        console.log(`  ${shortRemote}: ${dim('path is not a git repo')}`);
        break;
      default:
        console.log(`  ${shortRemote}: ${dim(result.status)}`);
    }
  }

  console.log();
}
