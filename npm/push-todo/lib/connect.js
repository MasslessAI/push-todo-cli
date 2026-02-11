/**
 * Connect and authentication module for Push CLI (Doctor Mode).
 *
 * Comprehensive health check and connect tool:
 * - Version check: Compare local vs remote plugin version
 * - API validation: Verify API key is still valid
 * - Project registration: Register current project with keywords
 * - Authentication: Handle initial auth or re-auth when needed
 * - E2EE setup: Compile Swift helper, import encryption key
 * - Machine validation: Multi-Mac coordination
 *
 * Ported from: plugins/push-todo/scripts/connect.py (1866 lines)
 */

import { execSync, spawnSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';
import * as api from './api.js';
import { getApiKey, saveCredentials, clearCredentials, getConfigValue, getEmail } from './config.js';
import { getMachineId, getMachineName } from './machine-id.js';
import { getRegistry } from './project-registry.js';
import { getGitRemote, isGitRepo, getGitRoot, normalizeGitRemote } from './utils/git.js';
import { isE2EEAvailable } from './encryption.js';
import { ensureDaemonRunning } from './daemon-health.js';
import { bold, green, yellow, red, cyan, dim } from './utils/colors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Supabase anonymous key for auth flow
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4dXpxY2JxaGlheG1maXR6eGxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzI0ODA5MjIsImV4cCI6MjA0ODA1NjkyMn0.Qxov5qJTVLWmseyFNhBQBJN7-t5sXlHZyzFKhSN_e5g';
const API_BASE = 'https://jxuzqcbqhiaxmfitzxlo.supabase.co/functions/v1';

// Remote URLs for updates
const REMOTE_PACKAGE_JSON_URL = 'https://raw.githubusercontent.com/MasslessAI/push-todo-cli/main/npm/push-todo/package.json';

// Get version from package.json
function getVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || '3.0.0';
  } catch {
    return '3.0.0';
  }
}

const VERSION = getVersion();

// Client types
const CLIENT_NAMES = {
  'claude-code': 'Claude Code',
  'openai-codex': 'OpenAI Codex',
  'openclaw': 'OpenClaw'
};

// ============================================================================
// INSTALLATION METHOD DETECTION
// ============================================================================

/**
 * Detect how the package was installed.
 *
 * Returns:
 *   "npm-global" - Installed via npm install -g
 *   "npm-local" - Installed locally in node_modules
 *   "development" - Linked for development
 */
function getInstallationMethod() {
  const pkgPath = join(__dirname, '..');

  // Check if it's a symlink (development setup)
  try {
    const stats = statSync(pkgPath, { throwIfNoEntry: false });
    if (stats?.isSymbolicLink?.()) {
      return 'development';
    }
  } catch {}

  // Check if in node_modules (local install)
  if (pkgPath.includes('node_modules')) {
    return 'npm-local';
  }

  // Default to global npm install
  return 'npm-global';
}

// ============================================================================
// E2EE SETUP (End-to-End Encryption)
// ============================================================================

/**
 * Get the plugin/package root directory.
 */
function getPluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  return join(__dirname, '..');
}

/**
 * Get path to the Swift keychain helper binary.
 */
function getSwiftHelperPath() {
  return join(getPluginRoot(), 'bin', 'push-keychain-helper');
}

/**
 * Get path to the Swift keychain helper source.
 */
function getSwiftSourcePath() {
  return join(getPluginRoot(), 'natives', 'KeychainHelper.swift');
}

/**
 * Check if Swift compiler is available.
 */
function checkSwiftcAvailable() {
  try {
    const result = spawnSync('which', ['swiftc'], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if E2EE key exists in keychain.
 */
function checkE2EEKeyExists() {
  const helperPath = getSwiftHelperPath();
  if (!existsSync(helperPath)) {
    return false;
  }

  try {
    const result = spawnSync(helperPath, ['--check'], { timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Compile the Swift keychain helper from source.
 */
function compileSwiftHelper() {
  const sourcePath = getSwiftSourcePath();
  const binDir = join(getPluginRoot(), 'bin');
  const helperPath = getSwiftHelperPath();

  // Check if source exists
  if (!existsSync(sourcePath)) {
    return {
      status: 'no_source',
      message: `Swift source not found at ${sourcePath}`
    };
  }

  // Check for Swift compiler
  if (!checkSwiftcAvailable()) {
    return {
      status: 'no_swiftc',
      message: 'Swift compiler not found. Install Xcode Command Line Tools.'
    };
  }

  // Create bin directory
  mkdirSync(binDir, { recursive: true });

  // Compile
  try {
    const result = spawnSync('swiftc', ['-O', sourcePath, '-o', helperPath], {
      timeout: 60000,
      encoding: 'utf8'
    });

    if (result.status === 0) {
      return {
        status: 'success',
        message: 'Compiled encryption helper from source',
        path: helperPath
      };
    } else {
      return {
        status: 'compile_error',
        message: `Compilation failed: ${result.stderr}`
      };
    }
  } catch (error) {
    return {
      status: 'compile_error',
      message: `Compilation error: ${error.message}`
    };
  }
}

/**
 * Set up E2EE support for the CLI.
 */
function setupE2EE() {
  const helperPath = getSwiftHelperPath();
  const sourcePath = getSwiftSourcePath();

  // Case 1: Helper already exists
  if (existsSync(helperPath)) {
    const keyExists = checkE2EEKeyExists();
    if (keyExists) {
      return {
        status: 'ready',
        message: 'E2EE ready',
        keyAvailable: true
      };
    } else {
      return {
        status: 'not_enabled',
        message: 'E2EE helper ready, but no key found (enable in iOS app)',
        keyAvailable: false
      };
    }
  }

  // Case 2: Need to compile helper
  if (existsSync(sourcePath)) {
    if (checkSwiftcAvailable()) {
      const compileResult = compileSwiftHelper();

      if (compileResult.status === 'success') {
        const keyExists = checkE2EEKeyExists();
        return {
          status: 'compiled',
          message: 'Compiled encryption helper from source',
          keyAvailable: keyExists,
          sourcePath
        };
      } else {
        return {
          status: 'error',
          message: compileResult.message,
          keyAvailable: false
        };
      }
    } else {
      return {
        status: 'needs_setup',
        message: 'Swift compiler not found',
        keyAvailable: false,
        options: [
          'Install Xcode Command Line Tools: xcode-select --install',
          'Or use pre-signed binary (downloaded during npm install)'
        ],
        sourcePath
      };
    }
  }

  // Case 3: No source file - check if binary was downloaded
  return {
    status: 'error',
    message: 'E2EE helper not found. Run: npm rebuild @masslessai/push-todo',
    keyAvailable: false
  };
}

/**
 * Store E2EE key directly without interactive prompt.
 */
function storeE2EEKeyDirect(keyInput) {
  keyInput = keyInput.trim();

  // Validate format (should be base64, 44 chars for 32 bytes)
  try {
    const keyData = Buffer.from(keyInput, 'base64');
    if (keyData.length !== 32) {
      return {
        status: 'error',
        message: `Invalid key size: expected 32 bytes, got ${keyData.length}`
      };
    }
  } catch {
    return {
      status: 'error',
      message: 'Invalid base64 encoding'
    };
  }

  // Store via Swift helper
  let helperPath = getSwiftHelperPath();
  if (!existsSync(helperPath)) {
    const compileResult = compileSwiftHelper();
    if (compileResult.status !== 'success') {
      return {
        status: 'error',
        message: `Cannot compile helper: ${compileResult.message}`
      };
    }
  }

  try {
    const result = spawnSync(helperPath, ['--store'], {
      input: keyInput,
      timeout: 10000,
      encoding: 'utf8'
    });

    if (result.status === 0) {
      return {
        status: 'success',
        message: 'Key stored in macOS Keychain'
      };
    } else {
      return {
        status: 'error',
        message: `Failed to store key: ${result.stderr?.trim() || 'Unknown error'}`
      };
    }
  } catch (error) {
    return {
      status: 'error',
      message: `Error storing key: ${error.message}`
    };
  }
}

/**
 * Check if running in an interactive terminal.
 */
function isInteractive() {
  return process.stdin.isTTY && process.stdout.isTTY;
}

/**
 * Check if user has any encrypted todos.
 */
async function checkUserHasEncryptedTodos() {
  try {
    const apiKey = getApiKey();
    if (!apiKey) return false;

    const response = await fetch(
      `${API_BASE}/synced-todos?is_encrypted=true&limit=1`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) return false;

    const data = await response.json();
    const todos = data.todos || data;
    return Array.isArray(todos) && todos.length > 0;
  } catch {
    return false;
  }
}

/**
 * Interactive E2EE key import (for TTY only).
 */
async function importE2EEKey() {
  if (!isInteractive()) {
    console.log('');
    console.log('  E2EE_KEY_IMPORT_AVAILABLE');
    console.log('  Use: push-todo connect --store-e2ee-key <base64_key>');
    return false;
  }

  console.log('');
  console.log('  🔐 Import Encryption Key');
  console.log('  ' + '-'.repeat(38));
  console.log('');
  console.log('  Your Push account has E2EE enabled.');
  console.log('  To decrypt tasks on this Mac, import your encryption key.');
  console.log('');
  console.log('  On your iPhone:');
  console.log('    1. Open Push app');
  console.log('    2. Go to Settings > End-to-End Encryption');
  console.log("    3. Tap 'Export Encryption Key'");
  console.log('    4. Copy the key');
  console.log('');

  // Prompt for key
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('  Paste your encryption key (or press Enter to skip): ', (keyInput) => {
      rl.close();

      keyInput = keyInput.trim();
      if (!keyInput) {
        console.log('  Skipped key import.');
        resolve(false);
        return;
      }

      const result = storeE2EEKeyDirect(keyInput);
      if (result.status === 'success') {
        console.log('  ✓ Key stored in macOS Keychain');
        resolve(true);
      } else {
        console.log(`  ✗ ${result.message}`);
        resolve(false);
      }
    });
  });
}

/**
 * Show E2EE status and optionally prompt for import.
 */
async function showE2EEStatus(promptForImport = true) {
  const e2eeStatus = setupE2EE();

  console.log('');
  console.log('  E2EE Status');
  console.log('  ' + '-'.repeat(38));

  if (e2eeStatus.status === 'ready') {
    console.log('  ✓ End-to-end encryption ready');
    console.log('  ✓ Encryption key available');
    return;
  }

  if (e2eeStatus.status === 'compiled') {
    console.log('  ✓ Compiled encryption helper from source');
    if (e2eeStatus.sourcePath) {
      console.log(`  📄 Source: ${e2eeStatus.sourcePath}`);
    }
    if (e2eeStatus.keyAvailable) {
      console.log('  ✓ Encryption key available');
    } else {
      console.log('  ⚠️  No encryption key found');
      if (promptForImport && await checkUserHasEncryptedTodos()) {
        if (await importE2EEKey()) {
          console.log('  ✓ E2EE setup complete!');
        }
      }
    }
    return;
  }

  if (e2eeStatus.status === 'not_enabled') {
    console.log('  ✓ Encryption helper ready');
    const hasEncrypted = await checkUserHasEncryptedTodos();
    if (hasEncrypted) {
      console.log('  ⚠️  No encryption key found (E2EE enabled on account)');
      if (promptForImport) {
        if (await importE2EEKey()) {
          console.log('  ✓ E2EE setup complete!');
        }
      }
    } else {
      console.log('  ℹ️  E2EE not enabled (no encrypted todos)');
    }
    return;
  }

  if (e2eeStatus.status === 'needs_setup') {
    console.log('  ⚠️  E2EE setup needed');
    console.log('    Swift compiler not found. To enable E2EE:');
    console.log('    → Run: xcode-select --install');
    console.log('    → Then run: push-todo connect');
    return;
  }

  console.log(`  ⚠️  E2EE error: ${e2eeStatus.message}`);

  // Trust-building info
  if (e2eeStatus.sourcePath && ['ready', 'compiled'].includes(e2eeStatus.status)) {
    console.log('');
    console.log('  🔐 Your encryption key:');
    console.log('    • Stored securely in macOS Keychain');
    console.log('    • Never sent to our servers');
    console.log('    • Only your devices can decrypt');
  }
}

// ============================================================================
// VERSION CHECK
// ============================================================================

/**
 * Get remote version from npm/GitHub.
 */
async function getRemoteVersion() {
  try {
    const response = await fetch(REMOTE_PACKAGE_JSON_URL, {
      headers: { 'User-Agent': 'push-cli/1.0' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.version || null;
  } catch {
    return null;
  }
}

/**
 * Parse version string into comparable tuple.
 */
function parseVersion(versionStr) {
  try {
    return versionStr.split('.').map(p => parseInt(p, 10));
  } catch {
    return [0, 0, 0];
  }
}

/**
 * Check if an update is available.
 */
async function checkVersion() {
  const method = getInstallationMethod();

  // Dev installation
  if (method === 'development') {
    return {
      status: 'dev_installation',
      current: VERSION,
      latest: null,
      updateAvailable: false,
      message: `Dev installation (v${VERSION}) - use git pull to update`
    };
  }

  const remote = await getRemoteVersion();

  if (!remote) {
    return {
      status: 'unknown',
      current: VERSION,
      latest: null,
      updateAvailable: false,
      message: 'Could not fetch remote version (network error)'
    };
  }

  const localParts = parseVersion(VERSION);
  const remoteParts = parseVersion(remote);

  let updateAvailable = false;
  for (let i = 0; i < 3; i++) {
    if ((remoteParts[i] || 0) > (localParts[i] || 0)) {
      updateAvailable = true;
      break;
    } else if ((remoteParts[i] || 0) < (localParts[i] || 0)) {
      break;
    }
  }

  return {
    status: updateAvailable ? 'update_available' : 'up_to_date',
    current: VERSION,
    latest: remote,
    updateAvailable,
    message: updateAvailable
      ? `Update available: ${VERSION} → ${remote}`
      : `Plugin is up to date (v${VERSION})`
  };
}

/**
 * Update the package to latest version.
 */
async function doUpdate() {
  const method = getInstallationMethod();

  if (method === 'development') {
    return {
      status: 'skipped',
      message: 'Development installation - use git pull instead'
    };
  }

  console.log('Updating @masslessai/push-todo...');

  try {
    execSync('npm update -g @masslessai/push-todo', { stdio: 'inherit' });
    return { status: 'success', message: 'Updated successfully' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate the current API key.
 */
async function validateApiKeyStatus() {
  let apiKey;
  try {
    apiKey = getApiKey();
  } catch {
    return { status: 'missing', message: 'No API key configured' };
  }

  const result = await api.validateApiKey();

  if (result.valid) {
    return { status: 'valid', email: result.email, userId: result.userId };
  }

  return { status: 'invalid', message: result.reason };
}


/**
 * Validate project registration (full validation with warnings).
 */
function validateProjectInfo() {
  const warnings = [];
  const projectPath = process.cwd();
  const gitRemoteRaw = getGitRemote();
  const gitRemote = gitRemoteRaw ? normalizeGitRemote(gitRemoteRaw) : null;

  // Check if git repo
  const isGit = isGitRepo();
  if (!isGit) {
    warnings.push('Not a git repository (no .git folder)');
  }

  // Check git remote
  if (isGit && !gitRemoteRaw) {
    warnings.push("Git repo has no 'origin' remote configured");
  }

  if (gitRemoteRaw && !gitRemote) {
    warnings.push(`Could not normalize git remote: ${gitRemoteRaw}`);
  }

  // Check local registry
  let localRegistryStatus = 'not_registered';
  if (gitRemote) {
    const registry = getRegistry();
    const registeredPath = registry.getPathWithoutUpdate(gitRemote);
    if (registeredPath) {
      if (registeredPath === projectPath) {
        localRegistryStatus = 'registered';
      } else {
        localRegistryStatus = 'path_mismatch';
        warnings.push(`Local registry has different path: ${registeredPath}`);
      }
    } else {
      warnings.push("Project not in local registry (daemon won't route tasks here)");
    }
  }

  // Determine overall status
  let status;
  if (!isGit || !gitRemote) {
    status = 'warnings';
  } else if (warnings.length > 0) {
    status = 'warnings';
  } else {
    status = 'valid';
  }

  return {
    status,
    projectPath,
    isGitRepo: isGit,
    gitRemote,
    gitRemoteRaw,
    localRegistryStatus,
    warnings,
    message: status === 'valid'
      ? `Project valid: ${gitRemote}`
      : `Project has ${warnings.length} warning(s)`
  };
}

/**
 * Simple project validation (JSON output).
 */
function validateProjectStatus() {
  if (!isGitRepo()) {
    return { status: 'not_git', message: 'Not in a git repository' };
  }

  const gitRemote = getGitRemote();
  if (!gitRemote) {
    return { status: 'no_remote', message: 'No git remote configured' };
  }

  const normalized = normalizeGitRemote(gitRemote);
  const registry = getRegistry();
  const isRegistered = registry.isRegistered(normalized);
  const localPath = registry.getPathWithoutUpdate(normalized);

  return {
    status: isRegistered ? 'registered' : 'unregistered',
    gitRemote: normalized,
    localPath,
    gitRoot: getGitRoot()
  };
}

// ============================================================================
// AUTH FLOW
// ============================================================================

/**
 * Get device name for registration.
 */
function getDeviceName() {
  return getMachineName() || 'Unknown Device';
}

/**
 * Initiate device code flow.
 */
async function initiateDeviceFlow(clientType = 'claude-code') {
  const clientName = CLIENT_NAMES[clientType] || 'Claude Code';

  const response = await fetch(`${API_BASE}/device-auth/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY
    },
    body: JSON.stringify({
      client_name: clientName,
      client_type: clientType,
      client_version: VERSION,
      device_name: getDeviceName(),
      project_path: process.cwd(),
      git_remote: getGitRemote()
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to initiate auth: ${response.status}`);
  }

  return response.json();
}

/**
 * Poll for authorization status.
 */
async function pollStatus(deviceCode) {
  const response = await fetch(`${API_BASE}/device-auth/poll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY
    },
    body: JSON.stringify({ device_code: deviceCode })
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (body.error === 'slow_down') {
      return { status: 'slow_down', interval: body.interval || 10 };
    }
    throw new Error(`Poll failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Open a URL in the default browser.
 */
function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
      return true;
    } else if (process.platform === 'linux') {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
      return true;
    } else if (process.platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore' });
      return true;
    }
  } catch {}
  return false;
}

/**
 * Full device auth flow with browser sign-in.
 */
async function doFullDeviceAuth(clientType = 'claude-code') {
  const clientName = CLIENT_NAMES[clientType] || 'Claude Code';

  console.log('  Initializing...');

  let deviceData;
  try {
    deviceData = await initiateDeviceFlow(clientType);
  } catch (error) {
    console.error(`  Error: Failed to initiate connection: ${error.message}`);
    process.exit(1);
  }

  const deviceCode = deviceData.device_code;
  const expiresIn = deviceData.expires_in;
  let pollInterval = deviceData.interval || 5;

  const authUrl = deviceData.verification_uri_complete ||
    `https://pushto.do/auth/cli?code=${deviceCode}`;

  console.log('');
  console.log('  Opening browser for Sign in with Apple...');
  console.log('');

  const browserOpened = openBrowser(authUrl);

  if (browserOpened) {
    console.log("  If the browser didn't open, visit:");
  } else {
    console.log('  Open this URL in your browser:');
  }
  console.log(`  ${authUrl}`);
  console.log('');
  console.log(`  Waiting for authorization (${Math.floor(expiresIn / 60)} min timeout)...`);
  console.log('  Press Ctrl+C to cancel');
  console.log('');

  const startTime = Date.now();

  while (true) {
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed > expiresIn) {
      console.log('');
      console.log('  Error: Authorization timed out. Please run connect again.');
      console.log('');
      process.exit(1);
    }

    try {
      const result = await pollStatus(deviceCode);

      if (result.status === 'authorized') {
        const apiKeyResult = result.api_key;
        const email = result.email || 'Unknown';
        const actionName = result.normalized_name || result.action_name || clientName;

        if (apiKeyResult) {
          return {
            api_key: apiKeyResult,
            email,
            action_name: actionName
          };
        } else {
          console.log('');
          console.log('  Error: Authorization succeeded but no API key received.');
          console.log('');
          process.exit(1);
        }
      }

      if (result.status === 'denied') {
        console.log('');
        console.log('  Authorization denied.');
        console.log('');
        process.exit(1);
      }

      if (result.status === 'expired') {
        console.log('');
        console.log('  Error: Authorization expired. Please run connect again.');
        console.log('');
        process.exit(1);
      }

      if (result.status === 'slow_down') {
        pollInterval = result.interval || pollInterval + 5;
      }

      // Still pending
      const remaining = Math.floor(expiresIn - elapsed);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      process.stdout.write(`\r  Waiting... (${mins}:${secs.toString().padStart(2, '0')} remaining)   `);

    } catch (error) {
      process.stdout.write(`\r  Error: ${error.message}. Retrying...                 `);
    }

    await sleep(pollInterval * 1000);
  }
}

/**
 * Register project with backend.
 */
async function registerProjectWithBackend(apiKey, clientType = 'claude-code', keywords = '', description = '') {
  const clientName = CLIENT_NAMES[clientType] || 'Claude Code';

  const payload = {
    client_type: clientType,
    client_name: clientName,
    device_name: getDeviceName(),
    project_path: process.cwd(),
    git_remote: getGitRemote()
  };

  if (keywords) payload.keywords = keywords;
  if (description) payload.description = description;

  const response = await fetch(`${API_BASE}/register-project`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    if (response.status === 401) {
      return { status: 'unauthorized', message: 'API key invalid or revoked' };
    }
    const body = await response.json().catch(() => ({}));
    return { status: 'error', message: body.error_description || `HTTP ${response.status}` };
  }

  const data = await response.json();
  if (data.success) {
    return {
      status: 'success',
      action_id: data.action_id || null,
      action_type: data.action_type || null,
      action_name: data.normalized_name || data.action_name || 'Unknown',
      created: data.created !== false,
      message: data.message || ''
    };
  }

  return { status: 'error', message: 'Unknown error' };
}

// Mapping from CLI client_type to canonical DB action_type
// Must match CLIENT_TO_ACTION_TYPE in register-project edge function
const CLIENT_TO_ACTION_TYPE = {
  'claude-code': 'claude-code',
  'openai-codex': 'openai-codex',
  'openclaw': 'clawdbot',
  'clawdbot': 'clawdbot',
};

/**
 * Register project in local registry for daemon routing.
 *
 * @param {string} gitRemoteRaw - Raw git remote URL
 * @param {string} localPath - Absolute local path
 * @param {Object} [actionMeta] - Action metadata from register-project response
 * @returns {boolean}
 */
function registerProjectLocally(gitRemoteRaw, localPath, actionMeta = {}) {
  if (!gitRemoteRaw) return false;

  const gitRemote = normalizeGitRemote(gitRemoteRaw);
  if (!gitRemote) return false;

  const registry = getRegistry();
  return registry.register(gitRemote, localPath, actionMeta);
}

/**
 * Show migration hint for legacy installations.
 */
function showMigrationHint() {
  const method = getInstallationMethod();

  if (method === 'npm-local') {
    console.log('');
    console.log('  ' + '-'.repeat(50));
    console.log('  TIP: You have a local installation.');
    console.log('  For global access, install globally:');
    console.log('');
    console.log('    npm install -g @masslessai/push-todo');
    console.log('');
    console.log('  ' + '-'.repeat(50));
  }
}

// ============================================================================
// STATUS DISPLAY
// ============================================================================

/**
 * Show current connection status.
 */
async function showStatus() {
  console.log('');
  console.log('  Push Connection Status');
  console.log('  ' + '='.repeat(40));
  console.log('');

  let existingKey, existingEmail;
  try {
    existingKey = getApiKey();
  } catch {}
  existingEmail = getEmail();

  if (existingKey && existingEmail) {
    console.log(`  ✓ Connected as ${existingEmail}`);
    console.log(`  ✓ API key: ${existingKey.slice(0, 16)}...`);
    console.log('');
    console.log('  Current project:');
    const gitRemote = getGitRemote();
    if (gitRemote) {
      console.log(`    Git remote: ${gitRemote}`);
    } else {
      console.log(`    Path: ${process.cwd()}`);
    }
    console.log('');
    console.log("  Run 'push-todo connect' to register this project.");
    console.log("  Run 'push-todo connect --reauth' to re-authenticate.");
  } else if (existingKey) {
    console.log('  ⚠ Partial config (missing email)');
    console.log(`    API key: ${existingKey.slice(0, 16)}...`);
    console.log('');
    console.log("  Run 'push-todo connect --reauth' to fix.");
  } else {
    console.log('  ✗ Not connected');
    console.log('');
    console.log("  Run 'push-todo connect' to connect your Push account.");
  }

  console.log('');
}

// ============================================================================
// MAIN CONNECT FLOW
// ============================================================================

/**
 * Run the connect/doctor flow.
 *
 * @param {Object} options - Options from CLI
 */
export async function runConnect(options = {}) {
  // Self-healing: ensure daemon is running
  ensureDaemonRunning();

  // Auto-detect client type from installation method
  let clientType = options.client || 'claude-code';
  const clientName = CLIENT_NAMES[clientType] || 'Claude Code';

  // Handle --check-version (JSON output)
  if (options['check-version'] || options.checkVersion) {
    const result = await checkVersion();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Handle --update
  if (options.update) {
    const result = await doUpdate();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Handle --validate-key (JSON output)
  if (options['validate-key'] || options.validateKey) {
    const result = await validateApiKeyStatus();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Handle --validate-project (JSON output)
  if (options['validate-project'] || options.validateProject) {
    const result = validateProjectStatus();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Handle --store-e2ee-key
  if (options['store-e2ee-key'] || options.storeE2eeKey) {
    const key = options['store-e2ee-key'] || options.storeE2eeKey;
    const result = storeE2EEKeyDirect(key);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Handle --status (show status without registering)
  if (options.status) {
    await showStatus();
    return;
  }

  // Handle --reauth
  if (options.reauth) {
    console.log('  Forcing re-authentication...');
    clearCredentials();
  }

  // ─────────────────────────────────────────────────────────────────
  // FULL DOCTOR FLOW
  // ─────────────────────────────────────────────────────────────────

  console.log('');
  console.log(`  Push Voice Tasks Connect`);
  console.log('  ' + '='.repeat(40));
  console.log('');

  // Step 1: Check for updates
  const versionInfo = await checkVersion();
  if (versionInfo.updateAvailable) {
    console.log(`  ${yellow('⚠')}  Update available: ${versionInfo.current} → ${versionInfo.latest}`);
    console.log(`     Run: ${cyan('npm update -g @masslessai/push-todo')}`);
    console.log('');
  }

  let existingKey, existingEmail;
  try {
    existingKey = getApiKey();
  } catch {}
  existingEmail = getEmail();

  const keywords = options.keywords || '';
  const description = options.description || '';

  if (existingKey && existingEmail && !options.reauth) {
    // ─────────────────────────────────────────────────────────────────
    // FAST PATH: Already authenticated, just register project
    // ─────────────────────────────────────────────────────────────────
    console.log(`  Connected as ${existingEmail}`);
    console.log('  Registering project...');

    const result = await registerProjectWithBackend(existingKey, clientType, keywords, description);

    if (result.status === 'success') {
      // Register in local project registry for global daemon routing
      const gitRemoteRaw = getGitRemote();
      const localPath = process.cwd();
      const actionType = result.action_type || CLIENT_TO_ACTION_TYPE[clientType] || clientType;
      const isNewLocal = registerProjectLocally(gitRemoteRaw, localPath, {
        actionType,
        actionId: result.action_id,
        actionName: result.action_name,
      });

      console.log('');
      console.log('  ' + '='.repeat(40));
      if (result.created) {
        console.log(`  Created action: "${result.action_name}"`);
      } else {
        console.log(`  Found existing action: "${result.action_name}"`);
      }

      // Validate and show project info
      const projectInfo = validateProjectInfo();
      if (projectInfo.gitRemote) {
        console.log(`  Git remote: ${projectInfo.gitRemote}`);
      }
      for (const warning of projectInfo.warnings) {
        console.log(`  ⚠️  ${warning}`);
      }

      // Show local registry status
      if (gitRemoteRaw) {
        if (isNewLocal) {
          console.log(`  Local path registered: ${localPath}`);
        } else {
          console.log(`  Local path updated: ${localPath}`);
        }
      }

      // Show machine info
      console.log(`  Machine: ${getMachineName()}`);
      console.log('  ' + '='.repeat(40));
      console.log('');

      if (result.created) {
        console.log('  Your iOS app will sync this automatically.');
      } else {
        console.log('  This project is already configured.');
      }

      // Show E2EE status
      await showE2EEStatus();

      // Show migration hint
      showMigrationHint();
      console.log('');
      return;
    }

    if (result.status === 'unauthorized') {
      console.log('');
      console.log('  Session expired, re-authenticating...');
      console.log('');
      clearCredentials();
      // Fall through to full auth
    } else {
      console.log('');
      console.log(`  Registration failed: ${result.message || 'Unknown error'}`);
      console.log('  Trying full connection...');
      console.log('');
      // Fall through to full auth
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // SLOW PATH: First time or re-auth needed
  // ─────────────────────────────────────────────────────────────────────
  const isReauth = existingKey !== undefined;

  const authResult = await doFullDeviceAuth(clientType);

  // Save credentials
  saveCredentials(authResult.api_key, authResult.email);

  // Register in local project registry for global daemon routing
  const gitRemoteRaw = getGitRemote();
  const localPath = process.cwd();
  const actionType = CLIENT_TO_ACTION_TYPE[clientType] || clientType;
  const isNewLocal = registerProjectLocally(gitRemoteRaw, localPath, {
    actionType,
    actionName: authResult.action_name,
  });

  // Show success
  console.log('');
  console.log('  ' + '='.repeat(40));
  if (isReauth) {
    console.log(`  Re-connected as ${authResult.email}`);
  } else {
    console.log(`  Connected as ${authResult.email}`);
  }
  console.log(`  Created action: "${authResult.action_name}"`);

  // Validate and show project info
  const projectInfo = validateProjectInfo();
  if (projectInfo.gitRemote) {
    console.log(`  Git remote: ${projectInfo.gitRemote}`);
  }
  for (const warning of projectInfo.warnings) {
    console.log(`  ⚠️  ${warning}`);
  }

  // Show local registry status
  if (gitRemoteRaw) {
    if (isNewLocal) {
      console.log(`  Local path registered: ${localPath}`);
    } else {
      console.log(`  Local path updated: ${localPath}`);
    }
  }

  // Show machine info
  console.log(`  Machine: ${getMachineName()}`);
  console.log('  ' + '='.repeat(40));
  console.log('');
  console.log('  Your iOS app will sync this automatically.');

  // Show E2EE status
  await showE2EEStatus();

  // Show migration hint
  showMigrationHint();
  console.log('');
}

export {
  checkVersion,
  doUpdate,
  validateApiKeyStatus,
  validateProjectStatus,
  validateProjectInfo,
  setupE2EE,
  storeE2EEKeyDirect,
  showStatus,
  getInstallationMethod,
  VERSION
};
