/**
 * Manual update orchestrator for Push CLI.
 *
 * `push-todo update` performs three actions:
 * 1. Self-update: check and install latest push-todo from npm
 * 2. Agent versions: detect and display installed agent CLI versions
 * 3. Project freshness: fetch and rebase registered projects that are behind
 *
 * Separation of concerns:
 * - Daemon: runs all three checks periodically (hourly, throttled, non-interactive)
 * - This module: runs on explicit user request (immediate, verbose, interactive)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { checkForUpdate, performUpdate, compareSemver } from './self-update.js';
import { getAgentVersions, getKnownAgentTypes } from './agent-versions.js';
import { checkProjectFreshness } from './project-freshness.js';
import { getRegistry } from './project-registry.js';
import { bold, green, yellow, red, cyan, dim } from './utils/colors.js';

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

  // ── 2. Agent versions ──────────────────────────────────
  console.log(bold('  Agent CLIs'));

  const agentVersions = getAgentVersions({ force: true });
  for (const type of getKnownAgentTypes()) {
    const info = agentVersions[type];
    const label = AGENT_LABELS[type] || type;

    if (info.installed && info.version) {
      console.log(`  ${label}: ${green('v' + info.version)}`);
    } else if (info.installed) {
      console.log(`  ${label}: ${yellow('installed')} ${dim('(version unknown)')}`);
    } else {
      console.log(`  ${label}: ${dim('not installed')}`);
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
