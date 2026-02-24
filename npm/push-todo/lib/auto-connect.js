/**
 * Auto-connect orchestrator for Push CLI.
 *
 * Scans the user's home folder for Claude Code, Codex, and OpenClaw projects,
 * then batch-registers them all with the Push backend in one shot.
 *
 * Usage: push-todo connect --auto
 */

import { getApiKey, saveCredentials, getEmail } from './config.js';
import {
  CLIENT_TO_ACTION_TYPE,
  registerProjectWithBackendExplicit,
  registerProjectLocally,
  doFullDeviceAuth,
} from './connect.js';
import { getRegistry } from './project-registry.js';
import { normalizeGitRemote } from './utils/git.js';
import { discoverAllProjects } from './discovery.js';
import { createSpinner } from './utils/spinner.js';
import { bold, green, red, dim, cyan } from './utils/colors.js';
import { ensureDaemonRunning } from './daemon-health.js';
import { install as installLaunchAgent, getStatus as getLaunchAgentStatus } from './launchagent.js';

/**
 * Install or update LaunchAgent (macOS only).
 * Called at the end of auto-connect, even for early-exit paths.
 */
function installLaunchAgentIfNeeded() {
  if (process.platform !== 'darwin') return;

  const laStatus = getLaunchAgentStatus();
  if (!laStatus.installed) {
    const laSpinner = createSpinner();
    laSpinner.start('Installing LaunchAgent for auto-start on login...');

    const laResult = installLaunchAgent();
    if (laResult.success) {
      laSpinner.succeed('LaunchAgent installed — daemon starts automatically on login');
    } else {
      laSpinner.fail(`LaunchAgent: ${laResult.message}`);
      console.log(`  ${dim('Daemon will still self-heal via push-todo commands.')}`);
    }
  } else {
    // Already installed — ensure it's loaded and up to date
    const laResult = installLaunchAgent();
    if (laResult.alreadyInstalled) {
      console.log(`  ${green('✓')} LaunchAgent already configured`);
    } else if (laResult.success) {
      console.log(`  ${green('✓')} LaunchAgent updated`);
    }
  }
  console.log('');
}

/**
 * Run the auto-connect flow.
 *
 * 1. Ensure authenticated
 * 2. Scan for projects across all agents
 * 3. Deduplicate and filter already-registered
 * 4. Batch-register with backend + local registry
 * 5. Display progress and summary
 *
 * @param {Object} options - CLI options
 */
export async function runAutoConnect(options = {}) {
  // Self-healing: ensure daemon is running
  ensureDaemonRunning();

  console.log('');
  console.log(`  ${bold('Push Auto-Connect')}`);
  console.log(`  ${'='.repeat(40)}`);
  console.log('');

  // Phase 1: Ensure authenticated
  let apiKey;
  try {
    apiKey = getApiKey();
  } catch {
    apiKey = null;
  }
  const email = getEmail();

  if (!apiKey || !email) {
    console.log('  Not authenticated. Starting auth flow...');
    console.log('');
    const authResult = await doFullDeviceAuth('claude-code');
    saveCredentials(authResult.api_key, authResult.email);
    apiKey = authResult.api_key;
    console.log('');
    console.log(`  ${green('✓')} Authenticated as ${authResult.email}`);
    console.log('');
  } else {
    console.log(`  ${green('✓')} Authenticated as ${email}`);
    console.log('');
  }

  // Phase 2: Scan for projects
  console.log('  Scanning for projects...');

  const spinner = createSpinner();

  spinner.start('Scanning Claude Code projects...');
  const { projects, counts } = discoverAllProjects();

  // Show per-agent results
  if (counts.claudeCode > 0) {
    spinner.succeed(`Claude Code: ${counts.claudeCode} projects found`);
  } else {
    spinner.info('Claude Code: no projects found');
  }

  const spinner2 = createSpinner();
  if (counts.codex > 0) {
    spinner2.succeed(`Codex: ${counts.codex} projects found`);
  } else {
    spinner2.info('Codex: not installed or no projects');
  }

  const spinner3 = createSpinner();
  if (counts.openclaw > 0) {
    spinner3.succeed(`OpenClaw: ${counts.openclaw} projects found`);
  } else {
    spinner3.info('OpenClaw: not installed or no projects');
  }

  if (projects.length === 0) {
    console.log('');
    console.log('  No projects with git remotes found.');
    console.log(`  ${dim('Projects must have a git remote to be registered.')}`);
    console.log('');
    // Still install LaunchAgent even with no projects
    installLaunchAgentIfNeeded();
    return;
  }

  console.log('');
  console.log(`  ${bold(`${projects.length} unique projects`)} to process`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log('');

  // Phase 3: Check which are already registered
  const registry = getRegistry();
  const toRegister = [];
  let alreadyConnected = 0;

  for (const project of projects) {
    const actionType = CLIENT_TO_ACTION_TYPE[project.agentType] || project.agentType;
    const existingPath = registry.getPathWithoutUpdate(project.gitRemote, actionType);
    if (existingPath) {
      alreadyConnected++;
      console.log(`  ${dim('○')} ${dim(project.gitRemote)} ${dim(`(${project.agentType})`)} ${dim('— already connected')}`);
    } else {
      toRegister.push(project);
    }
  }

  if (toRegister.length === 0) {
    console.log('');
    console.log(`  ${'='.repeat(40)}`);
    console.log(`  All ${alreadyConnected} projects already connected.`);
    console.log('');
    // Still install LaunchAgent even when all projects connected
    installLaunchAgentIfNeeded();
    return;
  }

  // Phase 4: Register new projects
  let registered = 0;
  let failed = 0;

  for (const project of toRegister) {
    const regSpinner = createSpinner();
    const label = `${project.gitRemote} (${project.agentType})`;
    regSpinner.start(`Registering ${label}...`);

    try {
      const result = await registerProjectWithBackendExplicit(
        apiKey,
        project.agentType,
        project.projectPath,
        project.gitRemote,
        project.projectContext
      );

      if (result.status === 'unauthorized') {
        regSpinner.fail(`${label} — session expired`);
        console.log('');
        console.log(`  ${red('Error:')} API key invalid or revoked.`);
        console.log(`  Run ${cyan("'push-todo connect --reauth'")} to re-authenticate.`);
        console.log('');
        return;
      }

      if (result.status === 'success') {
        // Register locally
        const actionType = result.action_type || CLIENT_TO_ACTION_TYPE[project.agentType] || project.agentType;
        registerProjectLocally(project.gitRemote, project.projectPath, {
          actionType,
          actionId: result.action_id,
          actionName: result.action_name,
        });
        regSpinner.succeed(label);
        registered++;
      } else {
        regSpinner.fail(`${label} — ${result.message || 'unknown error'}`);
        failed++;
      }
    } catch (error) {
      regSpinner.fail(`${label} — ${error.message}`);
      failed++;
    }
  }

  // Phase 5: Summary
  console.log('');
  console.log(`  ${'='.repeat(40)}`);

  const parts = [];
  if (registered > 0) parts.push(green(`${registered} registered`));
  if (alreadyConnected > 0) parts.push(dim(`${alreadyConnected} already connected`));
  if (failed > 0) parts.push(red(`${failed} failed`));

  console.log(`  ${parts.join(', ')}`);

  if (registered > 0) {
    console.log(`  Run ${cyan("'push-todo'")} to see your tasks.`);
  }
  console.log('');

  // Phase 6: Install LaunchAgent (macOS only)
  installLaunchAgentIfNeeded();
}
